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
}
/**
 * 读一次凭据记录。
 *
 * 永不抛错：诊断的价值在于「说清现在怎样」，抛错就变成了「什么都没说」。
 * 读不到就报 `unknown` 并附原因。
 */
export declare function probeCredentialPresence(): CredentialPresence;
/**
 * 从凭据状态与 CLI 的登录结论，得出「这一项现在到底是怎么回事」。
 *
 * ## 三种结论，三种下一步
 *
 * | 结论 | 依据 | 下一步 |
 * | --- | --- | --- |
 * | `no_credential` | 没有登录记录 | 去登录 |
 * | `credential_unusable` | 有登录记录，但 CLI 说没有可用令牌 | 先确认网络，再重新登录 |
 * | `ok` | CLI 说登录通过 | 无 |
 *
 * `credential_unusable` **不直接断言「令牌过期」**：CLI 的 `resolveToken()` 在
 * 刷新令牌的 HTTP 请求失败时也会返回 null（它 `catch` 了所有异常），所以
 * 「网络断了」与「令牌过期」在 CLI 的输出上**完全一样**。把两者说成一个，
 * 会让主人在断网时跑去重新登录，而登录同样会失败。
 *
 * 所以措辞里两件事都写，并给出能区分它们的动作：先确认网络，再重新登录。
 */
export type LoginVerdict = 'ok' | 'no_credential' | 'credential_unusable' | 'unknown';
export declare function loginVerdictOf(input: {
    readonly credential: CredentialPresence;
    /** CLI 的 login 步骤是否通过。`undefined` 表示没跑 doctor。 */
    readonly cliLoginOk: boolean | undefined;
}): LoginVerdict;
/** 「上次登录是多久以前」，用于提醒会话有寿命。 */
export declare function describeAge(recordedAt: string | undefined, now: number): string | undefined;
//# sourceMappingURL=credential-state.d.ts.map