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
/** 出网模式。 */
export type EgressMode = 
/** 什么都不限制（默认）：平台读取与模型都可用。 */
'open'
/**
 * 手动导入：只允许用户配置的模型地址与本机回环，**禁止任何平台主机**。
 *
 * 这条模式存在的意义是把产品承诺写进代码：粘贴一段讨论、生成回复、复制，
 * 整个过程不应该碰微博或贴吧一个字节。
 */
 | 'manual'
/** 完全离线：除回环外一律拒绝。用于离线验收与「拔网线也要能用」的场景。 */
 | 'offline';
/** 这次出网是为了什么。 */
export type EgressPurpose = 'model' | 'platform' | 'self-test' | 'other';
/** 一条审计记录。字段刻意少：够定位，不够泄露。 */
export interface EgressRecord {
    readonly at: string;
    readonly mode: EgressMode;
    readonly purpose: EgressPurpose;
    readonly host: string;
    readonly decision: 'allow' | 'deny';
    readonly reason: string;
}
/** 被守卫拒绝时抛这个。`code` 让上层能区分「策略拒绝」与「网络故障」。 */
export declare class EgressBlockedError extends Error {
    readonly code = "egress_blocked";
    readonly host: string;
    readonly purpose: EgressPurpose;
    readonly mode: EgressMode;
    constructor(host: string, purpose: EgressPurpose, mode: EgressMode, reason: string);
}
/** 守卫需要的策略。 */
export interface EgressPolicy {
    readonly mode: EgressMode;
    /**
     * 允许的主机（精确匹配，含端口通配）。
     *
     * 只放模型地址，不放平台地址：平台地址由 {@link PLATFORM_HOSTS} 单独识别，
     * 它们在 `manual` / `offline` 下一律拒绝，写进白名单也无效 —— 否则一次
     * 配置失误就能让「手动导入不碰平台」这条承诺失效。
     */
    readonly allowedHosts: readonly string[];
}
/** 平台主机：出现在这里的地址在 manual / offline 下一律拒绝。 */
export declare const PLATFORM_HOSTS: readonly RegExp[];
/** 主机是否是平台。 */
export declare function isPlatformHost(hostname: string): boolean;
/** 审计落盘。写入失败不抛：审计坏了不该让一次生成失败。 */
export declare class EgressLog {
    private readonly path;
    private readonly memory;
    private readonly maxMemory;
    constructor(path?: string, maxMemory?: number);
    record(entry: EgressRecord): void;
    /** 内存里的记录（最近 maxMemory 条）。 */
    entries(): readonly EgressRecord[];
    /** 审计文件路径，没有落盘时为 undefined。 */
    filePath(): string | undefined;
    /** 读回落盘内容，用于验收脚本自己核对（不是产品逻辑）。 */
    readBack(): EgressRecord[];
}
/** 守卫本体。 */
export declare class EgressGuard {
    private readonly policy;
    private readonly log;
    constructor(policy: EgressPolicy, log: EgressLog);
    mode(): EgressMode;
    /**
     * 判断一次出网。
     *
     * @param url 目标地址；无法解析时按「未知主机」拒绝（`offline`/`manual`）或放行（`open`）。
     */
    check(url: string, purpose: EgressPurpose): {
        readonly host: string;
    };
    /** 纯判断，不写日志 —— 供不需要留痕的预检使用。 */
    decide(host: string, purpose: EgressPurpose): {
        readonly allowed: boolean;
        readonly reason: string;
    };
    /** 包一层 fetch：先判断，再真正发出。 */
    fetch(base?: typeof fetch): typeof fetch;
    /**
     * 子进程出网预检。
     *
     * CLI 的网络在它自己的进程里，守卫拦不到它的 socket —— 所以这里拦的是**启动**
     * 这件事：在 manual / offline 模式下，平台 CLI 一次都不许起来。这比「起来了
     * 但没发请求」更强，也更容易验证：进程没起来，就不可能有流量。
     */
    assertSpawn(purpose: EgressPurpose, label: string): void;
    /**
     * 自检：故意访问一个必然被拒的地址。
     *
     * 用 `.invalid` 顶级域：RFC 2606 保留，永远不解析。所以这里不是「碰运气访问
     * 一个外部站点看会不会超时」，而是一次**确定会被策略拒绝**的尝试。
     *
     * 返回 `blocked: true` 才说明守卫是活的。`open` 模式下它会走到 DNS 并失败，
     * 那也算「没有拦住」—— 报告必须如实写，而不是把它算成通过。
     */
    selfTest(base?: typeof fetch): Promise<{
        readonly blocked: boolean;
        readonly mode: EgressMode;
        readonly host: string;
        readonly reason: string;
    }>;
}
/** 从配置构造策略。 */
export declare function egressPolicyOf(input: {
    readonly mode: EgressMode;
    readonly llmBaseUrl: string;
}): EgressPolicy;
//# sourceMappingURL=net-audit.d.ts.map