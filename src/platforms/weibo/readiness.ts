/**
 * 微博 CLI 的授权就绪诊断：八个独立状态（v0.2.30 §三）。
 *
 * ## 为什么必须是八个，而不是一个布尔
 *
 * 「微博能不能读」这个问题的答案有八种不同的「不能」，而它们对应八个完全不同的
 * 下一步动作：
 *
 * | 状态 | 用户要做什么 |
 * | --- | --- |
 * | 没装 CLI | `npm install -g @weibo-ai/weibo-cli` |
 * | 版本太低 | 升级 CLI |
 * | 命令清单读不到 | 检查 CLI 是否正常、网络是否可达 |
 * | 没登录 | `weibo-cli auth login` |
 * | 没做开发者认证 | 在微博控制台扫码完成认证 |
 * | 没开通服务 | 领取体验服务或购买积分包 |
 * | 额度用完 | 充值或等额度重置 |
 * | 最近一次读取失败 | 看具体错误（可能是临时故障） |
 *
 * 把这些压成一个 `canRead: false`，用户就只能一个个试。而更糟的是反过来的那种
 * 压缩：把「没装」和「已就绪」压成两个值，中间六种全被当成「可以试试」——
 * 于是每次读取都失败在同一个地方，而面板一直是绿的。
 *
 * ## 与 `diagnostics.ts` 的分工
 *
 * `diagnostics.ts` 是**一次读取过程中**的诊断记录（读到了什么、错在哪一步），
 * 它回答「刚才那次读取发生了什么」。本模块回答的是**现在的授权链条走到哪一步**，
 * 是一个可以在没有任何读取发生时就给出的快照。
 *
 * 两者都需要，因为它们服务不同的时刻：前者用于事后排查，后者用于事前决策。
 *
 * ## 一个刻意的「读不到」
 *
 * 额度和「最近一次读取」在纯本地探测里读不到：
 *
 * - 额度要通过 `me` / 计费类命令查，而本版只调用读命令的允许列表里没有它，
 *   也不应该为了显示一个数字去碰账号管理。
 * - 最近一次读取是**本进程内**的记录，重启之后没有。
 *
 * 这两个都报 `unknown`，理由写清楚。`unknown` 不是 `unavailable`：
 * 前者是「本进程没查」，后者是「查了也不会有」。
 */

import type { WeiboCliStatus } from './cli.js'

/**
 * 一项就绪检查的状态。
 *
 * 刻意只有四种：能 / 不能 / 不知道 / 不适用。多一种就会有人在面板里为它写
 * 一段解释文字，而解释文字正是这个模块要消灭的东西。
 */
export type ReadinessState =
  /** 这一项通过了。 */
  | 'ready'
  /** 这一项没通过，`next` 里是下一步。 */
  | 'blocked'
  /** 本进程没有证据，既不能说通过也不能说不通过。 */
  | 'unknown'
  /** 这一项对这个平台不适用（目前没有用到，但保留以免将来用 `unknown` 冒充）。 */
  | 'not_applicable'

/** 八项检查各自的标识。用字符串而不是序号：它要出现在页面的 `data-check` 里。 */
export type ReadinessCheckId =
  | 'installed'
  | 'version'
  | 'commands'
  | 'login'
  | 'certification'
  | 'activation'
  | 'quota'
  | 'last_read'

/** 顺序即页面顺序。 */
export const READINESS_ORDER: readonly ReadinessCheckId[] = [
  'installed',
  'version',
  'commands',
  'login',
  'certification',
  'activation',
  'quota',
  'last_read',
]

/**
 * 授权链的因果顺序——与 `READINESS_ORDER` **不同**，这一点是 v0.2.30 用真实
 * CLI 状态测出来才发现的。
 *
 * ## 为什么不能拿展示顺序当因果顺序
 *
 * 2026-11 在本机用 `@weibo-ai/weibo-cli@0.9.8` 实测（登录已完成、认证与开通未完成）：
 *
 * ```
 * ✓ 注册或登录: 一个天真的矿哥
 * × 完成开发者认证
 * × 开通服务
 *
 * commands list --available → { total: 75, available_count: 0, commands: [] }
 * ```
 *
 * 页面展示顺序是「安装/版本/命令清单/登录/认证/开通/额度/最近读取」——命令清单排在
 * 登录前面，因为它和「能不能读」最直接相关。但按那个顺序取第一个阻断项，得到的
 * 结论是「命令清单不可用」。
 *
 * 而命令清单为空是**结果**：没有开发者认证与服务，账号本来就没有可用命令。
 * 让用户先去查命令清单，等于让他排查一个不是原因的现象。
 *
 * 因果顺序是另一条链：
 *
 * ```
 * 装上 → 版本对 → 登录 → 开发者认证 → 开通服务 → 才有命令 → 才能读
 * ```
 *
 * `blocking` 沿这条链取第一个阻断项，用户就会得到「去完成扫脸认证」这个
 * 真正能解开死结的下一步。
 */
export const CAUSAL_ORDER: readonly ReadinessCheckId[] = [
  'installed',
  'version',
  'login',
  'certification',
  'activation',
  'commands',
]

/** 一项检查的展示形态。 */
export interface ReadinessCheck {
  readonly id: ReadinessCheckId
  readonly title: string
  readonly state: ReadinessState
  /** 一句话说清现在是什么情况。必须是事实，不是「可能」。 */
  readonly detail: string
  /** 用户能做的事，按顺序。`blocked` 时通常非空。 */
  readonly next: readonly string[]
}

/** 八项检查的整体快照。 */
export interface ReadinessSnapshot {
  readonly checks: readonly ReadinessCheck[]
  /**
   * 最早一个阻断项。
   *
   * 单独给出来，是因为「先修哪一个」有确定的答案：授权链是有顺序的，
   * 没登录的时候去查额度是浪费时间。页面用它来决定把哪一行画成当前项。
   */
  readonly blocking?: ReadinessCheckId
  /**
   * 现在能不能发起一次真实读取。
   *
   * 这是八项推导出来的**结论**，不是第八项的替代品。判据只有一条：
   * 前六项全部 `ready`（额度与最近读取不阻断发起）。
   */
  readonly canRead: boolean
  /**
   * 为什么不能读，一句话。`canRead` 为真时缺席。
   *
   * 与 `blocking` 的分工：后者说「哪一项」，这句说「那一项现在是怎样」。
   */
  readonly summary?: string
}

/** 探测的原始输入，与本模块解耦，便于用固定数据测八项判断。 */
export interface ReadinessProbe {
  /** CLI 是否被找到。 */
  readonly cliInstalled: boolean
  /** `version` 的输出，第一行。 */
  readonly cliVersion?: string
  /** `commands list --available` 是否成功，以及失败原因。 */
  readonly commands?:
    | { readonly ok: true; readonly count: number }
    | { readonly ok: false; readonly reason: string }
  /**
   * `doctor` 报告里三步的完成情况。
   *
   * 三项分别对应「注册或登录」「完成开发者认证」「开通服务」——这正是 CLI 自己
   * 打印的三行。把它们分开是这一版的关键：v0.2.29 之前这三项被压进一个
   * `serviceActive` 布尔，于是「没登录」和「没开通服务」在面板上长得一样。
   */
  readonly doctorSteps?: readonly { readonly label: string; readonly ok: boolean }[]
  /** `doctor` 的整体退出码与输出，用于「解析不出步骤」时的兜底措辞。 */
  readonly doctorRaw?: { readonly code: number; readonly output: string }
  /**
   * 只知道退出码、不关心输出时的简写。
   *
   * 与 `doctorRaw` 重复，但被调用方需要：provider 手上只有退出码时也要能把
   * 「exit 1 但没有步骤行」这句话说准，否则措辞会退回到「本次没有运行 doctor」——
   * 那是一句不成立的话，它跑了。
   */
  readonly doctorExitCode?: number
  /** 额度。本进程通常给 `unknown`。 */
  readonly quota?: { readonly known: true; readonly detail: string } | { readonly known: false; readonly reason: string }
  /** 本进程内最近一次真实读取。 */
  readonly lastRead?: {
    readonly ok: boolean
    readonly at: string
    readonly stage: string
    readonly message: string
  }
  /** 最近一次错误，用于给「读取失败」那一项提供细节。 */
  readonly lastError?: { readonly at: string; readonly state: string; readonly message: string }
}

/** CLI 的六个状态到「装在不在 / 通了没通」的映射，保持与 `cli.ts` 一致。 */
export function isInstallFailure(status: WeiboCliStatus): boolean {
  return status === 'cli_missing'
}

/**
 * 从 `doctor` 的三步里认出某一项。
 *
 * 用词而不是位置：CLI 的步骤顺序将来可能变，而「哪一行说了什么」不会。
 * 三组关键词分别对应登录、开发者认证、服务开通——这是 `doctor` 输出里唯一
 * 稳定的东西。
 */
function doctorStep(
  steps: readonly { readonly label: string; readonly ok: boolean }[] | undefined,
  pattern: RegExp,
): { readonly label: string; readonly ok: boolean } | undefined {
  return steps?.find((step) => pattern.test(step.label))
}

const LOGIN_PATTERN = /注册|登录|login|sign\s*in/i
const CERT_PATTERN = /开发者认证|认证|certif/i
const ACTIVATION_PATTERN = /开通服务|开通|服务|subscri|plan/i

/** 版本号是否可用。只检查「有没有解析出一个像版本的东西」。 */
function versionLooksUsable(version: string | undefined): boolean {
  if (version === undefined) return false
  return /\d+\.\d+/.test(version)
}

/**
 * 组装八项检查。
 *
 * ## 顺序是有意义的
 *
 * 每一项的 `state` 只看它自己，但 `blocking` 取第一个 `blocked`。
 * 这样「已安装但没登录」会指出 `login`，而不是把 `certification` 也标红——
 * 后者在没登录的时候根本无从判断，标红它是在制造噪音。
 *
 * ## 没有证据时说「不知道」，不说「未完成」
 *
 * CLI 没装的时候，`doctor` 一次都没跑过。这时把登录状态报成 `blocked`
 * 是一个关于账号的断言，而我们没有任何证据——用户会去找一个不存在的登录问题。
 */
export function buildReadiness(probe: ReadinessProbe): ReadinessSnapshot {
  const checks: ReadinessCheck[] = []
  const push = (check: ReadinessCheck): void => {
    checks.push(check)
  }

  // 1. 安装
  push(
    probe.cliInstalled
      ? {
          id: 'installed',
          title: 'CLI 已安装',
          state: 'ready',
          detail: '本机找到了 weibo-cli 命令。',
          next: [],
        }
      : {
          id: 'installed',
          title: 'CLI 未安装',
          state: 'blocked',
          detail: '本机没有 weibo-cli 这个命令，后面七项都无法检查。',
          next: ['安装：npm install -g @weibo-ai/weibo-cli（需要 Node.js 18 或更高）'],
        },
  )

  // 2. 版本
  if (!probe.cliInstalled) {
    push({
      id: 'version',
      title: 'CLI 版本',
      state: 'unknown',
      detail: 'CLI 未安装，版本无从确认。',
      next: [],
    })
  } else if (versionLooksUsable(probe.cliVersion)) {
    push({
      id: 'version',
      title: 'CLI 版本',
      state: 'ready',
      detail: `版本 ${probe.cliVersion}。`,
      next: [],
    })
  } else {
    push({
      id: 'version',
      title: 'CLI 版本',
      state: 'blocked',
      detail:
        probe.cliVersion === undefined
          ? 'CLI 在，但 version 命令没有输出可识别的版本号。'
          : `version 的输出不是可识别的版本号：${probe.cliVersion}`,
      next: ['运行 weibo-cli version 看它实际输出什么', '如果报错，重新安装 CLI'],
    })
  }

  // 3. 命令能力
  if (!probe.cliInstalled) {
    push({
      id: 'commands',
      title: '命令清单',
      state: 'unknown',
      detail: 'CLI 未安装，命令清单无从读取。',
      next: [],
    })
  } else if (probe.commands === undefined) {
    push({
      id: 'commands',
      title: '命令清单',
      state: 'unknown',
      detail: '本次没有读取命令清单。',
      next: [],
    })
  } else if (probe.commands.ok) {
    push({
      id: 'commands',
      title: '命令清单',
      state: probe.commands.count > 0 ? 'ready' : 'blocked',
      detail:
        probe.commands.count > 0
          ? `本账号可用命令 ${probe.commands.count} 条。`
          : '命令清单读到了，但一条可用命令都没有。',
      next: probe.commands.count > 0 ? [] : ['确认开发者认证与服务开通已完成', '运行 weibo-cli commands list --available 查看'],
    })
  } else {
    push({
      id: 'commands',
      title: '命令清单',
      state: 'blocked',
      detail: `读不到命令清单：${probe.commands.reason}`,
      next: ['运行 weibo-cli commands list --available 手动确认', '确认 CLI 与网络的连接正常'],
    })
  }

  // 4/5/6. 登录、认证、开通——来自 doctor 的三行
  const login = doctorStep(probe.doctorSteps, LOGIN_PATTERN)
  const cert = doctorStep(probe.doctorSteps, CERT_PATTERN)
  const activation = doctorStep(probe.doctorSteps, ACTIVATION_PATTERN)

  /** doctor 没跑（或没解析出步骤）时的共用措辞。 */
  const noDoctorEvidence = (): { state: ReadinessState; detail: string; next: readonly string[] } => {
    // ## 「跑了但解析不出」与「没跑」必须分开说
    //
    // 两者都是「没有证据」，但对用户意味着不同的事：前者是 CLI 的输出变了
    // （需要看它实际打印了什么），后者是这一步根本没执行（需要去执行它）。
    // 把前者说成「本次没有运行 doctor」，是一句不成立的话——它跑了。
    const exitCode = probe.doctorRaw?.code ?? probe.doctorExitCode
    return {
      state: 'unknown',
      detail:
        exitCode === undefined
          ? '本次没有运行 doctor，这一项无从确认。'
          : `doctor 跑过了，但输出里没有可识别的步骤行（退出码 ${exitCode}）。`,
      next:
        exitCode === undefined
          ? ['运行 weibo-cli doctor，按它的三行输出逐项确认']
          : ['运行 weibo-cli doctor 看它实际打印了什么', '如果输出格式变了，请把这段输出反馈给插件作者'],
    }
  }

  const fromDoctor = (
    id: ReadinessCheckId,
    title: string,
    step: { readonly label: string; readonly ok: boolean } | undefined,
    whenBlocked: readonly string[],
  ): ReadinessCheck => {
    if (!probe.cliInstalled) {
      return { id, title, state: 'unknown', detail: 'CLI 未安装，这一项无法检查。', next: [] }
    }
    if (step === undefined) {
      const fallback = noDoctorEvidence()
      return { id, title, state: fallback.state, detail: fallback.detail, next: fallback.next }
    }
    return step.ok
      ? { id, title, state: 'ready', detail: `doctor：${step.label} ✓`, next: [] }
      : {
          id,
          title,
          state: 'blocked',
          detail: `doctor：${step.label} 未完成`,
          next: whenBlocked,
        }
  }

  push(
    fromDoctor('login', 'OAuth 登录', login, [
      '运行 weibo-cli auth login（桌面环境会打开浏览器）',
      '完成后重新运行 doctor 确认这一行为 ✓',
    ]),
  )
  push(
    fromDoctor('certification', '开发者认证', cert, [
      '在微博开放平台控制台用微博客户端扫码完成开发者认证',
      '认证通过后重新运行 doctor',
    ]),
  )
  push(
    fromDoctor('activation', '服务开通', activation, [
      '在控制台「我的服务」领取体验服务（7 天），或购买积分包',
      '开通后重新运行 doctor',
    ]),
  )

  // 7. 额度
  if (probe.quota !== undefined && probe.quota.known) {
    push({
      id: 'quota',
      title: '额度',
      state: 'ready',
      detail: probe.quota.detail,
      next: [],
    })
  } else {
    push({
      id: 'quota',
      title: '额度',
      state: 'unknown',
      detail:
        probe.quota !== undefined && !probe.quota.known
          ? probe.quota.reason
          : '本进程没有查询额度。额度只能通过计费类命令读取，本版不替主人做账号管理。',
      next: ['如需确认额度，请自行运行 weibo-cli 的账号/额度相关命令'],
    })
  }

  // 8. 最近一次读取
  if (probe.lastRead === undefined) {
    push({
      id: 'last_read',
      title: '最近一次读取',
      state: 'unknown',
      detail: '本进程内还没有执行过真实读取（不代表失败，也不代表成功）。',
      next: [],
    })
  } else if (probe.lastRead.ok) {
    push({
      id: 'last_read',
      title: '最近一次读取',
      state: 'ready',
      detail: `成功 · ${probe.lastRead.stage} · ${probe.lastRead.at}`,
      next: [],
    })
  } else {
    push({
      id: 'last_read',
      title: '最近一次读取',
      state: 'blocked',
      detail: `失败 · ${probe.lastRead.stage} · ${probe.lastRead.message}`,
      next: [
        probe.lastError === undefined
          ? '重新读取一次，看错误是否稳定复现'
          : `最近错误：${probe.lastError.message}`,
      ],
    })
  }

  /**
   * 第一个阻断项，**按因果链**取，不按展示顺序。
   *
   * 详见 {@link CAUSAL_ORDER}：展示顺序把「命令清单」排在认证之前，因为它与
   * 「能不能读」最直接相关；但命令清单为空只是认证与服务缺失的**结果**。
   * 按展示顺序取，真实环境下得到的下一步是「去查命令清单」，而正确的下一步是
   * 「去完成扫脸认证」。
   */
  const blockedIds = new Set(
    checks.filter((check) => check.state === 'blocked').map((check) => check.id),
  )
  const blockingId = CAUSAL_ORDER.find((id) => blockedIds.has(id))
  const blockingCheck =
    blockingId === undefined ? undefined : checks.find((check) => check.id === blockingId)
  const canRead = checks
    .filter((check) => check.id !== 'quota' && check.id !== 'last_read')
    .every((check) => check.state === 'ready')

  return {
    checks,
    ...(blockingCheck === undefined ? {} : { blocking: blockingCheck.id }),
    canRead,
    ...(canRead || blockingCheck === undefined
      ? {}
      : { summary: `${blockingCheck.title}：${blockingCheck.detail}` }),
  }
}

/**
 * 把快照压成一行中文，给日志和不带面板的地方用。
 *
 * 刻意不返回「已就绪 / 未就绪」两个值：那句话会被人复制到别处，
 * 而它丢掉的信息正是这个模块存在的理由。
 */
export function describeReadiness(snapshot: ReadinessSnapshot): string {
  const blocked = snapshot.checks.filter((check) => check.state === 'blocked')
  const unknown = snapshot.checks.filter((check) => check.state === 'unknown')
  if (snapshot.canRead) {
    return unknown.length === 0
      ? '八项全部通过：可以发起真实读取。'
      : `可以发起真实读取；${unknown.map((check) => check.title).join('、')} 尚无证据。`
  }
  const head = blocked.map((check) => check.title).join('、')
  return `${head || '存在未通过项'}未通过：${snapshot.summary ?? '原因见各项详情'}`
}
