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

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 凭据记录的存在性。 */
export interface CredentialPresence {
  /**
   * `absent`：这台机器上没有登录记录。
   * `recorded`：有记录（登录过），但令牌当前是否可用由 CLI 回答，不由这里判断。
   * `unknown`：文件在，但读不出来（权限、格式）。
   */
  readonly state: 'absent' | 'recorded' | 'unknown'
  /** 记录里的账号名。只用于显示「上次登录的是谁」。 */
  readonly username?: string
  /** 记录创建时间（ISO）。用来算「这个登录有多久了」。 */
  readonly recordedAt?: string
  /** 存储方式，`keychain` / `env` / `encrypted_file`。不显示细节，只显示类别。 */
  readonly storage?: string
  /** 读不出来时的原因。 */
  readonly reason?: string
}

/** CLI 的配置目录，与它自己的 `getConfigDir()` 同一套规则。 */
function configDir(): string {
  // CLI 在 `NODE_ENV=development` 时用 `.weibo-cli-dev`。本插件不设这个变量，
  // 但显式判断一次比「假设它总是 production」更安全：假设错了，面板会永远显示
  // 「没有登录记录」，而那是错的。
  return join(homedir(), process.env.NODE_ENV === 'development' ? '.weibo-cli-dev' : '.weibo-cli')
}

/**
 * 读一次凭据记录。
 *
 * 永不抛错：诊断的价值在于「说清现在怎样」，抛错就变成了「什么都没说」。
 * 读不到就报 `unknown` 并附原因。
 */
export function probeCredentialPresence(): CredentialPresence {
  const path = join(configDir(), 'credential-ref.json')
  if (!existsSync(path)) {
    return { state: 'absent' }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      state: 'unknown',
      reason: `读不到登录记录文件：${(error as Error).message.split('\n')[0] ?? '未知错误'}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unknown', reason: '登录记录文件不是合法 JSON（可能被手工改过）。' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'unknown', reason: '登录记录文件的内容不是一个对象。' }
  }
  const record = parsed as Record<string, unknown>
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

  /**
   * ## 只取四个字段，且明确列出
   *
   * 不是 `{...record}` 之后删几个：那种写法在 CLI 将来往文件里加一个
   * `access_token` 字段时会**原样带进来**，然后被写进诊断快照、日志、页面。
   * 白名单是这里唯一安全的形状。
   */
  const username = text(record.username)
  const recordedAt = text(record.created_at)
  const storage = text(record.storage)
  return {
    state: 'recorded',
    ...(username === undefined ? {} : { username }),
    ...(recordedAt === undefined ? {} : { recordedAt }),
    ...(storage === undefined ? {} : { storage }),
  }
}

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
export type LoginVerdict = 'ok' | 'no_credential' | 'credential_unusable' | 'unknown'

export function loginVerdictOf(input: {
  readonly credential: CredentialPresence
  /** CLI 的 login 步骤是否通过。`undefined` 表示没跑 doctor。 */
  readonly cliLoginOk: boolean | undefined
}): LoginVerdict {
  if (input.cliLoginOk === true) return 'ok'
  // CLI 没给出结论时不猜：没跑 doctor 就没有关于登录的证据。
  if (input.cliLoginOk === undefined) {
    return input.credential.state === 'absent' ? 'unknown' : 'unknown'
  }
  if (input.credential.state === 'absent') return 'no_credential'
  if (input.credential.state === 'recorded') return 'credential_unusable'
  return 'unknown'
}

/** 「上次登录是多久以前」，用于提醒会话有寿命。 */
export function describeAge(recordedAt: string | undefined, now: number): string | undefined {
  if (recordedAt === undefined) return undefined
  const at = Date.parse(recordedAt)
  if (!Number.isFinite(at)) return undefined
  const hours = Math.floor((now - at) / 3_600_000)
  if (hours < 1) return '不到一小时'
  if (hours < 24) return `${hours} 小时`
  const days = Math.floor(hours / 24)
  return `${days} 天`
}
