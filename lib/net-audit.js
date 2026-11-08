/**
 * 出网守卫：把「这一次能不能访问那个地址」变成一个可检查、可留痕、可强制执行的判断。
 *
 * ## 为什么需要它
 *
 * 这个插件有两类出网：模型接口（用户自己配的，或宿主提供的）和平台接口
 * （微博 CLI、贴吧页面）。它们在**安全语义上完全不同**：
 *
 * - 模型接口：用户明确配置的目的地，允许。
 * - 平台接口：读取要授权、写入被三层禁用。手动导入模式下**一次都不该发生**。
 *
 * v0.2.35 的离线验收只能说「我们没有看到出网」——因为拦截器没有装上。空日志
 * 与「根本没有记录」在证据上是同一件事，那不是一个可以发布的安全结论。
 *
 * ## 一条判断，三个出口
 *
 * 所有出网都必须先过 {@link EgressGuard.check}：模型客户端（fetch）、平台 CLI
 * （子进程）、以及设置页的连通性测试。守卫做三件事：
 *
 * 1. **判断**：按策略决定 allow / deny，拒绝时抛 {@link EgressBlockedError}。
 * 2. **留痕**：每条判断写一行 JSONL（主机、用途、结果、原因），**不含任何
 *    header、查询串或凭据** —— 审计日志本身不能成为泄露源。
 * 3. **自检**：{@link EgressGuard.selfTest} 故意访问一个必然被拒的地址，用来
 *    证明「机制是活的」。一个从不拒绝任何请求的守卫，和一个没装上的守卫，
 *    在日志里长得一模一样。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
/** 被守卫拒绝时抛这个。`code` 让上层能区分「策略拒绝」与「网络故障」。 */
export class EgressBlockedError extends Error {
    code = 'egress_blocked';
    host;
    purpose;
    mode;
    constructor(host, purpose, mode, reason) {
        super(`已阻止一次出网（${mode} / ${purpose}）：${host} —— ${reason}`);
        this.name = 'EgressBlockedError';
        this.host = host;
        this.purpose = purpose;
        this.mode = mode;
    }
}
/** 平台主机：出现在这里的地址在 manual / offline 下一律拒绝。 */
export const PLATFORM_HOSTS = [
    /(^|\.)weibo\.com$/i,
    /(^|\.)weibo\.cn$/i,
    /(^|\.)sina\.com\.cn$/i,
    /(^|\.)baidu\.com$/i,
    /(^|\.)tieba\.com$/i,
];
/** 本机回环：无论哪种模式都允许。 */
function isLoopback(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}
/** 主机是否是平台。 */
export function isPlatformHost(hostname) {
    return PLATFORM_HOSTS.some((pattern) => pattern.test(hostname));
}
/** 从 URL 里取主机名，解析失败返回空串。 */
function hostnameOf(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return '';
    }
}
/** 审计落盘。写入失败不抛：审计坏了不该让一次生成失败。 */
export class EgressLog {
    path;
    memory = [];
    maxMemory;
    constructor(path, maxMemory = 2000) {
        this.path = path;
        this.maxMemory = maxMemory;
        if (path !== undefined) {
            try {
                mkdirSync(dirname(path), { recursive: true });
            }
            catch {
                // 目录建不出来时只留内存记录：报告会说明「没有落盘」，不会假装写过。
            }
        }
    }
    record(entry) {
        this.memory.push(entry);
        if (this.memory.length > this.maxMemory)
            this.memory.splice(0, this.memory.length - this.maxMemory);
        if (this.path === undefined)
            return;
        try {
            appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
        }
        catch {
            // 见上：审计写入失败不升级成业务失败。
        }
    }
    /** 内存里的记录（最近 maxMemory 条）。 */
    entries() {
        return [...this.memory];
    }
    /** 审计文件路径，没有落盘时为 undefined。 */
    filePath() {
        return this.path;
    }
    /** 读回落盘内容，用于验收脚本自己核对（不是产品逻辑）。 */
    readBack() {
        if (this.path === undefined || !existsSync(this.path))
            return [];
        const out = [];
        for (const line of readFileSync(this.path, 'utf8').split('\n')) {
            if (line.trim() === '')
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch {
                // 半行（进程被杀时）跳过。
            }
        }
        return out;
    }
}
/** 守卫本体。 */
export class EgressGuard {
    policy;
    log;
    constructor(policy, log) {
        this.policy = policy;
        this.log = log;
    }
    mode() {
        return this.policy.mode;
    }
    /**
     * 判断一次出网。
     *
     * @param url 目标地址；无法解析时按「未知主机」拒绝（`offline`/`manual`）或放行（`open`）。
     */
    check(url, purpose) {
        const host = hostnameOf(url);
        const verdict = this.decide(host, purpose);
        this.log.record({
            at: new Date().toISOString(),
            mode: this.policy.mode,
            purpose,
            host: host === '' ? '<unparsable>' : host,
            decision: verdict.allowed ? 'allow' : 'deny',
            reason: verdict.reason,
        });
        if (!verdict.allowed) {
            throw new EgressBlockedError(host === '' ? url : host, purpose, this.policy.mode, verdict.reason);
        }
        return { host };
    }
    /** 纯判断，不写日志 —— 供不需要留痕的预检使用。 */
    decide(host, purpose) {
        const mode = this.policy.mode;
        if (mode === 'open')
            return { allowed: true, reason: 'open 模式不限制出网' };
        const loopback = isLoopback(host);
        if (loopback)
            return { allowed: true, reason: '本机回环' };
        // 平台主机先判：即使有人把它写进 allowedHosts，manual / offline 也不放行。
        if (isPlatformHost(host)) {
            return { allowed: false, reason: `${mode} 模式禁止访问平台主机` };
        }
        if (mode === 'offline') {
            return { allowed: false, reason: 'offline 模式只允许本机回环' };
        }
        // manual：只放模型用途 + 白名单里的主机。
        if (this.policy.allowedHosts.some((entry) => entry.toLowerCase() === host.toLowerCase())) {
            return { allowed: true, reason: purpose === 'model' ? '手动导入模式下允许的模型地址' : '在允许清单里' };
        }
        return { allowed: false, reason: 'manual 模式只允许配置的模型地址与本机回环' };
    }
    /** 包一层 fetch：先判断，再真正发出。 */
    fetch(base = fetch) {
        const guarded = async (input, init) => {
            // 兼容 Request 对象：取它的 url。
            const url = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
            this.check(url, 'model');
            return base(input, init);
        };
        return guarded;
    }
    /**
     * 子进程出网预检。
     *
     * CLI 的网络在它自己的进程里，守卫拦不到它的 socket —— 所以这里拦的是**启动**
     * 这件事：在 manual / offline 模式下，平台 CLI 一次都不许起来。这比「起来了
     * 但没发请求」更强，也更容易验证：进程没起来，就不可能有流量。
     */
    assertSpawn(purpose, label) {
        const verdict = this.decide('platform.invalid', purpose);
        // 上面那次判断只是借道拿策略；这里真正要问的是「这个模式允许平台动作吗」。
        void verdict;
        const mode = this.policy.mode;
        if (mode === 'open')
            return;
        this.log.record({
            at: new Date().toISOString(),
            mode,
            purpose,
            host: `<spawn:${label}>`,
            decision: 'deny',
            reason: `${mode} 模式禁止启动平台进程`,
        });
        throw new EgressBlockedError(`<spawn:${label}>`, purpose, mode, `${mode} 模式禁止启动平台进程`);
    }
    /**
     * 自检：故意访问一个必然被拒的地址。
     *
     * 用 `.invalid` 顶级域：RFC 2606 保留，永远不解析。所以这里不是「碰运气访问
     * 一个外部站点看会不会超时」，而是一次**确定会被策略拒绝**的尝试。
     *
     * 返回 `blocked: true` 才说明守卫是活的。`open` 模式下它会走到 DNS 并失败，
     * 那也算「没有拦住」—— 报告必须如实写，而不是把它算成通过。
     */
    async selfTest(base) {
        const host = 'network-boundary.invalid';
        const url = `https://${host}/self-test`;
        try {
            this.check(url, 'self-test');
        }
        catch (error) {
            return {
                blocked: true,
                mode: this.policy.mode,
                host,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        // 没被拦：用真 fetch 证明这次「放行」确实会出网（而不是守卫静默返回）。
        try {
            await (base ?? fetch)(url, { method: 'HEAD' });
            return { blocked: false, mode: this.policy.mode, host, reason: '请求被放行并已发出' };
        }
        catch (error) {
            return {
                blocked: false,
                mode: this.policy.mode,
                host,
                reason: `策略放行了这次请求（之后网络失败：${error.message}）`,
            };
        }
    }
}
/** 从配置构造策略。 */
export function egressPolicyOf(input) {
    const hosts = [];
    const host = hostnameOf(input.llmBaseUrl);
    if (host !== '')
        hosts.push(host);
    return { mode: input.mode, allowedHosts: hosts };
}
//# sourceMappingURL=net-audit.js.map