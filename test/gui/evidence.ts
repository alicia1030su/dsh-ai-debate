/**
 * 浏览器验收的证据收集（v0.2.31 §八）。
 *
 * ## 上一次为什么不算证据
 *
 * v0.2.30 的异常脚本**根本不采集控制台异常**：`result.json` 里没有那个字段，
 * 于是「异常流程 0 控制台异常」这句话无法验证——它没被量过，只是没被记下来。
 * 一份不含失败信号的报告，看起来和一份全绿的报告一模一样。
 *
 * 更早的一次更糟：第一轮的「47/47 全绿」跑在两个改过产品代码的提交**之前**。
 * 数字是对的，结论是错的——它证明的是一份不再存在的代码。
 *
 * 所以这个模块只做一件事：把「这次跑的是哪个代码、什么时候、有哪些异常信号」
 * 记在一起，让报告没法只引用通过数。
 *
 * ## 采什么
 *
 * | 信号 | CDP 事件 | 为什么要 |
 * | --- | --- | --- |
 * | 页面错误 | `Runtime.exceptionThrown` | 未捕获异常、未处理的 Promise 拒绝都在这里 |
 * | 控制台 error | `Runtime.consoleAPICalled` | 产品自己的日志也会走这里 |
 * | 浏览器日志 | `Log.entryAdded` | 网络/CSP/证书类错误只在这里出现 |
 * | 失败请求 | `Network.loadingFailed` | 页面请求了不存在的东西 |
 * | 4xx/5xx 响应 | `Network.responseReceived` | 上一类抓不到「有响应但是错」 |
 * | 截图 | 脚本自己数 | 报告要能指回一张图 |
 *
 * 缺任何一类，「0 异常」就是一个比实际更强的声明。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一条异常信号。 */
export interface EvidenceSignal {
  readonly kind: 'exception' | 'console' | 'log' | 'network' | 'http'
  readonly detail: string
  readonly at: string
}

/** 一次运行的完整证据。 */
export interface EvidenceBundle {
  /** 被验收的源码提交。取不到时写明原因，不写空字符串。 */
  readonly headSha: string
  readonly headDirty: boolean
  readonly startedAt: string
  readonly endedAt: string
  /** 脚本自身的标识：哪个脚本、哪个版本。 */
  readonly script: string
  readonly scriptVersion: string
  /** 页面地址，用来确定验收的是哪个宿主实例。 */
  readonly pageUrl: string
  readonly cdpPort: number
  readonly appPort: number
  readonly stages: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number }
  readonly signals: readonly EvidenceSignal[]
  /** 截图文件清单（相对 outDir）。 */
  readonly screenshots: readonly string[]
  /** 结果文件与日志的位置。 */
  readonly artifacts: readonly string[]
  /** 有任何 skipped 时说明为什么——「跳过」不能算通过。 */
  readonly skippedReasons: readonly string[]
}

/** 本次运行的开始时间由调用方给，避免模块自己偷偷记时间。 */
export interface EvidenceInit {
  readonly script: string
  readonly scriptVersion: string
  readonly pageUrl: string
  readonly cdpPort: number
  readonly appPort: number
  readonly startedAt: string
}

const MAX_SIGNALS = 400

/**
 * 收集器。
 *
 * 它不做判断——判断留给报告。这里只负责「把发生过的信号记下来，一条都不吞」。
 * 一旦在这里就开始过滤（比如「忽略与 X 相关的错误」），报告就会变成
 * 「我们选择不看的异常」清单。
 */
export class EvidenceCollector {
  private readonly signals: EvidenceSignal[] = []
  private readonly screenshots: string[] = []
  private readonly artifacts: string[] = []

  constructor(private readonly init: EvidenceInit) {}

  /** 喂一条 CDP 事件。未识别的 `method` 直接忽略。 */
  record(message: { readonly method?: string; readonly params?: Record<string, unknown> }): void {
    if (this.signals.length >= MAX_SIGNALS) return
    const push = (kind: EvidenceSignal['kind'], detail: string): void => {
      this.signals.push({ kind, detail: detail.slice(0, 300), at: new Date().toISOString() })
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails as
        | {
            readonly text?: string
            readonly exception?: { readonly description?: string }
            readonly url?: string
            readonly lineNumber?: number
          }
        | undefined
      // 未处理的 Promise 拒绝也走这个事件，`text` 是 `Uncaught (in promise)`。
      // 两者分开记：前者是「代码抛了没人接」，后者是「异步失败被静默了」，
      // 排查方向完全不同。
      const text = details?.exception?.description ?? details?.text ?? 'unknown'
      const where = details?.url === undefined ? '' : ` @ ${details.url}:${details.lineNumber ?? 0}`
      push('exception', `${text}${where}`)
      return
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params as
        | { readonly type?: string; readonly args?: readonly { readonly value?: unknown; readonly description?: string }[] }
        | undefined
      // `warning` 也记：产品把可疑情况写成 warn，而 warn 从不出现在 error 计数里。
      if (params?.type === 'error' || params?.type === 'warning') {
        const text = (params.args ?? [])
          .map((arg) => (typeof arg.value === 'string' ? arg.value : (arg.description ?? String(arg.value ?? ''))))
          .join(' ')
        push('console', `${params.type}: ${text}`)
      }
      return
    }

    if (message.method === 'Log.entryAdded') {
      const entry = message.params?.entry as
        | { readonly level?: string; readonly text?: string; readonly url?: string; readonly source?: string }
        | undefined
      if (entry?.level === 'error' || entry?.level === 'warning') {
        push('log', `${entry.level} [${entry.source ?? 'log'}] ${entry.text ?? ''}${entry.url === undefined ? '' : ` @ ${entry.url}`}`)
      }
      return
    }

    if (message.method === 'Network.loadingFailed') {
      const params = message.params as { readonly errorText?: string; readonly type?: string } | undefined
      push('network', `${params?.type ?? 'request'} 失败：${params?.errorText ?? 'unknown'}`)
      return
    }

    if (message.method === 'Network.responseReceived') {
      const response = message.params?.response as
        | { readonly status?: number; readonly url?: string }
        | undefined
      const status = response?.status ?? 0
      // 只看 4xx/5xx。2xx/3xx 是正常流量，把它们记下来会把报告淹没。
      if (status >= 400) {
        push('http', `${status} ${response?.url ?? ''}`)
      }
    }
  }

  screenshot(name: string): void {
    this.screenshots.push(name)
  }

  /** 当前已收集的信号（只读快照）。让脚本能在收尾前就参与判定。 */
  signalsView(): readonly EvidenceSignal[] {
    return this.signals
  }

  artifact(path: string): void {
    this.artifacts.push(path)
  }

  /**
   * 当前工作区的提交。
   *
   * ## 为什么必须记这个
   *
   * v0.2.30 的第一轮全绿证据跑在两个改过 `src/` 的提交之前。数字对，结论错。
   * 有了 `headSha`，报告能写明「这份证据对应哪个提交」；对不上就能当场发现。
   *
   * 取不到时返回一个说明原因的值，**不返回空字符串**：空字符串在报告里会被
   * 渲染成「未知」，而「未知」很容易被读成「大概就是最新那个」。
   */
  static headOf(cwd: string): { readonly sha: string; readonly dirty: boolean } {
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', shell: false }).trim()
      const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', shell: false }).trim()
      return { sha, dirty: status !== '' }
    } catch (error) {
      return { sha: `（取不到 HEAD：${(error as Error).message.split('\n')[0] ?? '未知'}）`, dirty: true }
    }
  }

  /**
   * 落盘 `evidence.json`。
   *
   * 与 `result.json` 分成两个文件：后者是阶段结果（脚本自己写的），
   * 前者是「这次跑的是什么、有哪些异常信号」。分开之后，一个「全绿但 HEAD 对不上」
   * 的组合会立刻暴露——合成一个文件时，HEAD 那行很容易被忽略。
   */
  finish(input: {
    readonly outDir: string
    readonly stages: readonly { readonly status: 'passed' | 'failed' | 'skipped'; readonly name: string }[]
    readonly cwd: string
  }): EvidenceBundle {
    const head = EvidenceCollector.headOf(input.cwd)
    const passed = input.stages.filter((stage) => stage.status === 'passed').length
    const failed = input.stages.filter((stage) => stage.status === 'failed').length
    const skipped = input.stages.filter((stage) => stage.status === 'skipped').length
    const bundle: EvidenceBundle = {
      headSha: head.sha,
      headDirty: head.dirty,
      startedAt: this.init.startedAt,
      endedAt: new Date().toISOString(),
      script: this.init.script,
      scriptVersion: this.init.scriptVersion,
      pageUrl: this.init.pageUrl,
      cdpPort: this.init.cdpPort,
      appPort: this.init.appPort,
      stages: { total: input.stages.length, passed, failed, skipped },
      signals: this.signals,
      screenshots: this.screenshots,
      artifacts: [...this.artifacts, join(input.outDir, 'evidence.json'), join(input.outDir, 'result.json')],
      skippedReasons: input.stages.filter((stage) => stage.status === 'skipped').map((stage) => stage.name),
    }
    writeFileSync(join(input.outDir, 'evidence.json'), JSON.stringify(bundle, null, 2), 'utf8')
    return bundle
  }
}

/** 脚本版本。改动脚本时要一起改它，否则证据里无法区分「同一份脚本的两次改动」。 */
export const MANUAL_E2E_SCRIPT_VERSION = '2026-11-06.1'
