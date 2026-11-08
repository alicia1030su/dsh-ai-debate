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
/** 凭据记录的存在性。 */
export interface CredentialPresence {
    /**
     * `absent`：这台机器上没有登录记录。
     * `recorded`：有记录（登录过），但令牌当前是否可用由 CLI 回答，不由这里判断。
     * `unknown`：文件在，但读不出来（权限、格式）。
     */
    readonly state: 'absent' | 'recorded' | 'unknown';
    /** 记录里的账号名。只用于显示「上次登录的是谁」。 */
    readonly username?: string;
    /** 记录创建时间（ISO）。用来算「这个登录有多久了」。 */
    readonly recordedAt?: string;
    /** 存储方式，`keychain` / `env` / `encrypted_file`。不显示细节，只显示类别。 */
    readonly storage?: string;
    /** 读不出来时的原因。 */
    readonly reason?: string;
    /**
     * 本进程看到的「凭据环境」。
     *
     * ## 为什么它是一个字段，而不是一句注释
     *
     * CLI 的配置目录与保管库服务名都由 `NODE_ENV` 决定：
     * `production` → `~/.weibo-cli` + `weibo-cli/production`；
     * `development` → `~/.weibo-cli-dev` + `weibo-cli/development`。
     *
     * 两份凭据**互不可见**。而本插件是用 `execFile` 起的子进程，默认继承宿主环境；
     * 宿主是开发构建（或用户从设了 `NODE_ENV` 的终端启动）时，子进程会去另一套
     * 目录里找一个从来没存在过的登录记录，然后如实回答「缺少登录令牌」。
     * 用户看到的就是「我明明登录过，它说我没登录」。
     */
    readonly env?: 'production' | 'development';
    /** 本进程实际查找的配置目录（不含令牌，路径本身不敏感）。 */
    readonly configDir?: string;
    /**
     * 另一套环境里的记录摘要。
     *
     * 只有当「当前环境没有记录、另一套环境有记录」时才填 —— 那正是「登录状态消失」
     * 的共同形状，也是唯一值得在面板上指出来的错位。
     */
    readonly otherEnv?: {
        readonly env: 'production' | 'development';
        readonly recordedAt?: string;
        readonly username?: string;
    };
    /**
     * 刷新锁文件的状态。
     *
     * CLI 的每次刷新都要拿一把文件锁（`~/.weibo-cli/.refresh-lock-<account>`），
     * 等 15 秒拿不到就放弃并返回「没有令牌」。而一次刷新要在持锁期间做两次
     * PowerShell 保管库访问（本机实测读 1876ms、写 3597ms），所以三个 CLI 子进程
     * 同时要令牌时，第三个会正好等到超时。
     *
     * 这把锁里没有任何秘密（只有 lock_id / pid / created_at），读它是安全的。
     * 面板据此说明「不是登录失效，是另一个进程正在刷新」。
     */
    readonly refreshLock?: {
        readonly present: boolean;
        readonly ageMs?: number;
        /** 超过 CLI 自己的 30 秒陈旧阈值。 */
        readonly stale?: boolean;
    };
}
/** 本进程看到的配置目录（诊断显示用，路径本身不含秘密）。 */
export declare function currentConfigDir(): string;
/**
 * 读一次凭据记录。
 *
 * 永不抛错：诊断的价值在于「说清现在怎样」，抛错就变成了「什么都没说」。
 * 读不到就报 `unknown` 并附原因。
 */
export declare function probeCredentialPresence(): CredentialPresence;
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
export declare function credentialEnvForCli(): 'production' | 'development' | undefined;
/**
 * 从凭据状态与 CLI 的登录结论，得出「这一项现在到底是怎么回事」。
 *
 * ## 四种结论，四种下一步
 *
 * | 结论 | 依据 | 下一步 |
 * | --- | --- | --- |
 * | `no_credential` | 两套环境都没有登录记录 | 去登录 |
 * | `credential_in_other_env` | 当前环境没有，另一套有 | 插件会用另一套重跑（见 `credentialEnvForCli`），无需主人操作 |
 * | `credential_unusable` | 有登录记录，但 CLI 说没有可用令牌 | 先确认网络与锁，再重新登录 |
 * | `ok` | CLI 说登录通过 | 无 |
 *
 * `credential_unusable` **不直接断言「令牌过期」**，因为 CLI 的 `resolveToken()` 把
 * 三种完全不同的失败收敛成同一个 null：
 *
 * 1. 平台拒绝了刷新令牌（HTTP 401 `invalid_grant`）—— 只能重新授权；
 * 2. 刷新锁等了 15 秒没拿到（另一个进程正在刷新）—— 重试就好；
 * 3. 网络断了 —— 先修网络。
 *
 * 把它写成「令牌过期」，断网和锁竞争时主人都会白跑一趟重新登录。所以面板把
 * 三件事分开写，并各给一个能区分的动作。
 */
export type LoginVerdict = 'ok' | 'no_credential' | 'credential_in_other_env' | 'credential_unusable' | 'unknown';
export declare function loginVerdictOf(input: {
    readonly credential: CredentialPresence;
    /** CLI 的 login 步骤是否通过。`undefined` 表示没跑 doctor。 */
    readonly cliLoginOk: boolean | undefined;
}): LoginVerdict;
/** 「上次登录是多久以前」，用于提醒会话有寿命。 */
export declare function describeAge(recordedAt: string | undefined, now: number): string | undefined;
//# sourceMappingURL=credential-state.d.ts.map