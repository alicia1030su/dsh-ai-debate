/**
 * 本机登录凭据的**存在性**，不含任何秘密（v0.2.31 §六）。
 *
 * ## 为什么需要它：`doctor` 分不清两种「没登录」
 *
 * `@weibo-ai/weibo-cli@0.9.8` 在下面两种情况下打印**同一句话**：
 *
 * ```
 * × 注册或登录
 * ```
 *
 * 1. 这台机器从来没有登录过 —— 下一步是「去登录」；
 * 2. 登录过，但令牌已被平台判定过期或撤销 —— 下一步还是「去登录」，
 *    但用户会以为插件在说假话（「我明明登录过」）。
 *
 * 第二种是 v0.2.30 发布当天真实发生的：README 写着「已登录」，十二小时后
 * 平台返回 `401 invalid_grant`，而 `doctor` 的第一行又变回了 `×`。
 * 一份文档因为分不清这两件事，把一个会过期的状态写成了永久事实。
 *
 * ## 只读「引用」，从不读令牌
 *
 * CLI 把令牌存在系统保管库（Windows PasswordVault / macOS Keychain），只把一个
 * **指针**写在 `~/.weibo-cli/credential-ref.json`：账号名、用户 id、存储方式、
 * 创建时间。那个文件里没有令牌，读它也不涉及解密。
 *
 * 本模块只读这个文件，且只取四个非敏感字段。**任何情况下都不读保管库**：
 * 那需要系统级权限，而一个诊断面板没有理由拿到主人的凭据。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** CLI 用 `NODE_ENV` 决定的两套环境。 */
function envOf(nodeEnv) {
    return nodeEnv === 'development' ? 'development' : 'production';
}
/** CLI 的配置目录，与它自己的 `getConfigDir()` 同一套规则。 */
function configDirFor(env) {
    return join(homedir(), env === 'development' ? '.weibo-cli-dev' : '.weibo-cli');
}
/** 本进程看到的配置目录（诊断显示用，路径本身不含秘密）。 */
export function currentConfigDir() {
    return configDirFor(envOf(process.env.NODE_ENV));
}
/**
 * 读一次凭据记录。
 *
 * 永不抛错：诊断的价值在于「说清现在怎样」，抛错就变成了「什么都没说」。
 * 读不到就报 `unknown` 并附原因。
 */
export function probeCredentialPresence() {
    const currentEnv = envOf(process.env.NODE_ENV);
    const dir = configDirFor(currentEnv);
    const base = { env: currentEnv, configDir: dir };
    const path = join(dir, 'credential-ref.json');
    if (!existsSync(path)) {
        /**
         * ## 记录不在，先看另一套环境
         *
         * 这是「登录状态消失」最常见的真相：令牌好好的，只是 CLI 去错了目录。
         * 不查这一下，面板会说「从没登录过」，而主人十二小时前刚扫过码。
         */
        const otherEnv = currentEnv === 'production' ? 'development' : 'production';
        const otherPath = join(configDirFor(otherEnv), 'credential-ref.json');
        const other = readRef(otherPath);
        const lock = lockState(dir);
        return {
            state: 'absent',
            ...base,
            ...(other === undefined
                ? {}
                : {
                    otherEnv: {
                        env: otherEnv,
                        ...(other.recordedAt === undefined ? {} : { recordedAt: other.recordedAt }),
                        ...(other.username === undefined ? {} : { username: other.username }),
                    },
                }),
            ...(lock === undefined ? {} : { refreshLock: lock }),
        };
    }
    const record = readRef(path);
    if (record === undefined) {
        return { state: 'unknown', ...base, reason: '登录记录文件读不出来或不是合法 JSON（可能被手工改过）。' };
    }
    const lock = lockState(dir);
    return {
        state: 'recorded',
        ...base,
        ...(record.username === undefined ? {} : { username: record.username }),
        ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }),
        ...(record.storage === undefined ? {} : { storage: record.storage }),
        ...(record.envMismatch === true ? { reason: `记录里的环境是 ${record.env}，与当前进程不一致。` } : {}),
        ...(lock === undefined ? {} : { refreshLock: lock }),
    };
}
/**
 * 读一份 `credential-ref.json` 里的**四个非敏感字段**。
 *
 * 白名单而不是「读进来再删几个」：后者在 CLI 将来往文件里加一个 `access_token`
 * 字段时会原样带进来，然后被写进诊断快照、日志、页面。
 */
function readRef(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return undefined;
    const record = parsed;
    const text = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    const env = text(record.env);
    const username = text(record.username);
    const recordedAt = text(record.created_at);
    const storage = text(record.storage);
    return {
        ...(username === undefined ? {} : { username }),
        ...(recordedAt === undefined ? {} : { recordedAt }),
        ...(storage === undefined ? {} : { storage }),
        ...(env === undefined ? {} : { env }),
        ...(env !== undefined && env !== envOf(process.env.NODE_ENV) ? { envMismatch: true } : {}),
    };
}
/**
 * 刷新锁的状态。只看存在性与年龄，不读内容、不删。
 *
 * CLI 的陈旧阈值是 30 秒；超过它，下一个进程会直接删掉这把锁，于是两个进程
 * 可能在同一个窗口里各刷一次。这不是本插件该修的东西（那是 CLI 的内部约定），
 * 但它值得被说出来——因为主人看到的「又要重新登录」可能只是这个。
 */
function lockState(dir) {
    const path = join(dir, '.refresh-lock-default');
    try {
        const stat = statSync(path);
        const ageMs = Date.now() - stat.mtimeMs;
        return { present: true, ageMs, stale: ageMs > 30_000 };
    }
    catch {
        return undefined;
    }
}
/**
 * 子进程该用哪一套凭据环境。
 *
 * ## 规则：跟着「记录实际在哪」走，而不是跟着宿主环境走
 *
 * 宿主是开发构建时，`process.env.NODE_ENV === 'development'`，但主人是用普通
 * 终端 `weibo-cli auth login` 登录的 —— 记录在 production 那套里。此时让子进程
 * 继承宿主环境，它会去 `~/.weibo-cli-dev` 找一个不存在的记录，然后说「缺少
 * 登录令牌」。
 *
 * 所以：
 * 1. 当前环境有记录 → 用当前环境（不改变任何东西）；
 * 2. 当前环境没有、另一套有 → 用另一套（这正是主人真正登录过的地方）；
 * 3. 两套都没有 → 返回 `undefined`，不猜、不改环境。
 *
 * 返回 `undefined` 时子进程继承原环境，于是「从没登录过」仍然如实显示。
 */
export function credentialEnvForCli() {
    const current = envOf(process.env.NODE_ENV);
    if (existsSync(join(configDirFor(current), 'credential-ref.json')))
        return current;
    const other = current === 'production' ? 'development' : 'production';
    if (existsSync(join(configDirFor(other), 'credential-ref.json')))
        return other;
    return undefined;
}
export function loginVerdictOf(input) {
    if (input.cliLoginOk === true)
        return 'ok';
    // CLI 没给出结论时不猜：没跑 doctor 就没有关于登录的证据。
    if (input.cliLoginOk === undefined)
        return 'unknown';
    if (input.credential.state === 'absent') {
        // 记录在另一套环境里：这不是「没登录」，是「找错目录」。
        return input.credential.otherEnv === undefined ? 'no_credential' : 'credential_in_other_env';
    }
    if (input.credential.state === 'recorded')
        return 'credential_unusable';
    return 'unknown';
}
/** 「上次登录是多久以前」，用于提醒会话有寿命。 */
export function describeAge(recordedAt, now) {
    if (recordedAt === undefined)
        return undefined;
    const at = Date.parse(recordedAt);
    if (!Number.isFinite(at))
        return undefined;
    const hours = Math.floor((now - at) / 3_600_000);
    if (hours < 1)
        return '不到一小时';
    if (hours < 24)
        return `${hours} 小时`;
    const days = Math.floor(hours / 24);
    return `${days} 天`;
}
//# sourceMappingURL=credential-state.js.map