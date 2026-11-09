/**
 * v0.2.38 §5：真实模型质量对照的**采集器**。
 *
 * ## 这一轮与 v0.2.35/36/37 那三次的区别
 *
 * 那三次的结论都是定性的（「四条措辞区分得开，但论证策略没分开」），因为每次都只有
 * 一两条真实输出，两个版本之间根本不是同一组实验。这一轮要的是**可比**：
 *
 * - 同一批案例（≥20 个，脱敏，固定）；
 * - 同一个模型（宿主 `llm` 服务，不读、不存、不落盘任何密钥）；
 * - 同一套生成参数与同一套评分器；
 * - 两个版本分别跑一遍，逐条记下输入、人格、策略、候选、依据、安全结论、token、耗时。
 *
 * ## 为什么走桌面而不是直连端点
 *
 * 插件唯一合法的真实模型来源是宿主的 `llm` 服务 —— 走它就意味着「请求由宿主发出」，
 * 插件拿不到密钥。直连一个端点需要一份插件自己的凭据，那是第二份要保管的密钥，
 * 也正是 v0.2.36 明确排除的做法。
 *
 * 所以采集器通过**页面的路由**（`/api/dsh-ai-debate/action`）驱动真实链路：导入 → 确认
 * → 生成。每一步都是产品自己的接口，不是为测试造的旁路。
 *
 * ## 它拒绝做什么
 *
 * - 不重试到成功为止：一次失败就是一条失败记录，重试会把「模型不稳定」洗成「正常」。
 * - 不因为某条输出难看就换一条重跑。
 * - 不在预算之外偷偷多跑：`--budget` 是硬上限，用完即停并如实说明「样本不足」。
 *
 * 用法（在已启动的隔离桌面里）：
 *
 * ```bash
 * DSH_E2E_CDP_PORT=9820 node --experimental-transform-types test/gui/collect-quality-corpus.ts
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dismissOnboarding, openPluginPage, openSettings, type ShellCtx } from './desktop-shell.ts'
import { CASES } from './quality-cases.ts'

const CDP_PORT = Number(process.env.DSH_E2E_CDP_PORT ?? '9820')
const OUT_DIR = process.env.DSH_E2E_OUT_DIR ?? `C:/AI-Workspace/dsh-ai-debate/tmp/quality/run-${CDP_PORT}`
/** 模型调用预算：一次生成算 1 次。用完即停。 */
const BUDGET = Number(process.env.DSH_E2E_MODEL_BUDGET ?? '36')
/** 案例数上限：语料里按顺序取前 N 个。 */
const MAX_CASES = Number(process.env.DSH_E2E_MAX_CASES ?? '30')
/** 这一轮的人格。固定一个，两版都用它，避免「人格不同」混进版本差异。 */
const PERSONA = process.env.DSH_E2E_PERSONA ?? 'tieba_veteran'
/** 手工策略。空串表示自动选择（v0.2.38 才有；v0.2.37 忽略这个字段）。 */
const STRATEGY = process.env.DSH_E2E_STRATEGY ?? ''
const VERSION_LABEL = process.env.DSH_E2E_VERSION_LABEL ?? 'unknown'

interface Stage {
  readonly name: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly detail: string
}
const stages: Stage[] = []
function stage(name: string, status: Stage['status'], detail: string): void {
  stages.push({ name, status, detail })
  const mark = status === 'passed' ? '✔' : status === 'failed' ? '✘' : '·'
  process.stdout.write(`${mark} ${name} — ${detail}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---- CDP 连接 ---------------------------------------------------------------

const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
  type: string
  url: string
  id: string
  webSocketDebuggerUrl?: string
}[]
const page = list.find((item) => item.type === 'page')
if (page === undefined) {
  process.stderr.write('找不到可用的页面目标：桌面可能没起来。\n')
  process.exit(2)
}

const socket = new WebSocket(page.webSocketDebuggerUrl ?? `ws://127.0.0.1:${CDP_PORT}/devtools/page/${page.id}`)
await new Promise<void>((resolve, reject) => {
  socket.addEventListener('open', () => resolve(), { once: true })
  socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
})

let nextId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
socket.addEventListener('message', (event) => {
  const payload = JSON.parse(String(event.data)) as {
    id?: number
    result?: unknown
    error?: { message: string }
  }
  if (payload.id === undefined) return
  const waiter = pending.get(payload.id)
  if (waiter === undefined) return
  pending.delete(payload.id)
  if (payload.error !== undefined) waiter.reject(new Error(payload.error.message))
  else waiter.resolve(payload.result)
})

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = (await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result: { value: T } }
  return result.result.value
}

const ctx: ShellCtx = {
  evaluate,
  sleep,
  clickAt: async (x: number, y: number) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
  },
  /**
   * 按可见文字点。
   *
   * `desktop-shell` 里的实现会先量坐标再确认 `elementFromPoint` 命中同一个元素
   * （被遮罩挡住时就换下一个候选）。这里照抄那套判据 —— 只按 DOM 里存在就算点到，
   * 会得到「点了但什么都没发生」，而失败信息看起来像按钮没实现。
   */
  clickByText: async (label: string) => {
    const rect = await evaluate<string | null>(`(() => {
      const nodes = [...document.querySelectorAll('button,[role=button],a,[tabindex]')]
        .filter((node) => (node.innerText || '').trim() === ${JSON.stringify(label)})
      for (const node of nodes) {
        const r = node.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        const x = r.x + r.width / 2
        const y = r.y + r.height / 2
        const hit = document.elementFromPoint(x, y)
        if (hit === null) continue
        if (hit === node || node.contains(hit)) return JSON.stringify({ x: Math.round(x), y: Math.round(y) })
      }
      return null
    })()`)
    if (rect === null) return false
    const { x, y } = JSON.parse(rect) as { x: number; y: number }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    return true
  },
  viewport: async () =>
    evaluate<{ vw: number; vh: number }>(
      '(() => ({ vw: window.innerWidth, vh: window.innerHeight }))()',
    ),
}

mkdirSync(OUT_DIR, { recursive: true })

// ---- 语料 -------------------------------------------------------------------

/**
 * 20 个脱敏案例。
 *
 * 来源：`test/evaluation` 的语料形状（同一套「讨论 + 选中评论 + 正确行为」的表达），
 * 但这里是**独立的一份文本**，不是从语料文件里读出来的：
 *
 * - 真实模型要的是自然语言，不是 `EvalCase`；
 * - 案例内容全部为合成文本，不含任何真实用户、真实帖子、真实账号；
 * - 每条都带 `expect`，说明这条案例上正确的行为是什么，供人工盲评对照。
 */

const records: CaseRecord[] = []
let calls = 0
let aborted = false
let abortReason = ''

// ---- 页面就绪 ---------------------------------------------------------------

/**
 * 先过引导，再开设置面板，最后才点插件分区。
 *
 * 这三步在 v0.2.36/37 的桌面脚本里都做过，这一轮第一版漏了 —— 于是全新 profile 的
 * 首次启动停在引导页，侧栏里当然找不到「AI代吵架」，而失败信息看起来像插件没装上。
 * 顺序是产品自己的顺序，不是测试的便利。
 */
/**
 * 等外壳真正加载完再动手。
 *
 * 全新 profile 首次启动会停在 `HARNESS / Loading plugins…` 好几秒。这时候点任何东西
 * 都点不到 —— 第一版就是在这里失败的，而失败信息（「找不到账号菜单」）看起来像
 * 产品缺了入口。判据用「左下角账号菜单可见」而不是「body 有文字」：后者在加载页也成立。
 */
const shellDeadline = Date.now() + 60_000
let shellReady = false
while (Date.now() < shellDeadline) {
  shellReady = await evaluate<boolean>(`(() => {
    const buttons = [...document.querySelectorAll('button, [role=button], a')]
    return buttons.some((node) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }) && !document.body.innerText.includes('Loading plugins')
  })()`)
  if (shellReady) break
  await sleep(1000)
}
stage('等外壳加载', shellReady ? 'passed' : 'failed', shellReady ? '已就绪' : '60 秒内仍是加载页')
if (!shellReady) finish('failed')
await sleep(2000)

const onboarding = await dismissOnboarding(ctx)
stage('跳过引导', 'passed', onboarding)

const settings = await openSettings(ctx)
stage('打开设置面板', settings.ok ? 'passed' : 'failed', settings.how)
if (!settings.ok) finish('failed')

const opened = await openPluginPage(ctx)
stage('打开插件页', opened.mounted ? 'passed' : 'failed', opened.detail)
if (!opened.mounted) {
  finish('failed')
}

// ---- 逐案例采集 -------------------------------------------------------------

interface CaseRecord {
  readonly id: string
  readonly title: string
  readonly persona: string
  readonly strategyRequested: string
  /** 产品写回的正文。 */
  readonly text?: string
  readonly candidateId?: string
  readonly reason?: string
  /** v0.2.38 才有：程序选出的打法与依据。 */
  readonly argumentStrategy?: unknown
  readonly securityDecision?: string
  readonly securityReasons?: readonly string[]
  readonly elapsedMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** 失败分类：哪一步死的。 */
  readonly failureStage?: string
  /** 模型主动要求补充信息时为 true（这不是失败，是一种诚实的结果）。 */
  readonly needsInput?: boolean
  readonly needsInputReason?: string
  /** 五态分类（v0.2.39 §3.1）。缺省视为旧采集，按 ok 推断。 */
  readonly outcome?: string
  /** 拒绝或故障时，页面给用户的下一步动作。 */
  readonly next?: readonly string[]
  readonly expect: string
}


/** 走页面自己的路由，与会话 Cookie 一致。 */
async function callAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await evaluate<string>(`(async () => {
    const r = await fetch('/api/dsh-ai-debate/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(body)}),
    })
    return await r.text()
  })()`)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { __unparsable: raw.slice(0, 300) }
  }
}

for (const item of CASES.slice(0, MAX_CASES)) {
  if (calls >= BUDGET) {
    aborted = true
    abortReason = `模型调用预算 ${BUDGET} 次已用完，剩余案例未跑`
    break
  }

  const base: CaseRecord = {
    id: item.id,
    title: item.title,
    persona: PERSONA,
    strategyRequested: STRATEGY,
    expect: item.expect,
  }

  // 1. 预览：验证导入内容能被解析（不花模型调用）。
  const preview = await callAction({
    action: 'manual-preview',
    kind: 'text',
    content: item.content,
    ownerName: item.owner,
  })
  if (preview.ok !== true) {
    records.push({ ...base, failureStage: 'preview', reason: String(preview.reason ?? preview.__unparsable ?? '') })
    stage(`预览 ${item.id}`, 'failed', String(preview.reason ?? ''))
    continue
  }

  // 2. 确认：建会话，分析出对手与目标。
  const confirm = await callAction({
    action: 'manual-confirm',
    kind: 'text',
    content: item.content,
    ownerName: item.owner,
    targetPostId: findPostId(preview, item.targetText),
  })
  if (confirm.ok !== true) {
    records.push({ ...base, failureStage: 'confirm', reason: String(confirm.reason ?? '') })
    stage(`确认 ${item.id}`, 'failed', String(confirm.reason ?? ''))
    continue
  }
  const sessionId = String(confirm.sessionId ?? '')
  if (sessionId === '') {
    records.push({ ...base, failureStage: 'confirm', reason: '确认没有返回 sessionId' })
    continue
  }

  // 3. 生成：唯一的真实模型调用。
  calls += 1
  const startedAt = Date.now()
  const generated = await callAction({
    action: 'manual-generate',
    sessionId,
    persona: PERSONA,
    ...(STRATEGY === '' ? {} : { strategy: STRATEGY }),
  })
  const elapsed = Date.now() - startedAt

  /**
   * 结果分类（v0.2.39 §3.1）。
   *
   * `ok === false` 不再等于「失败」：材料不足时模型拒绝是**正确**结果。采集器必须把它
   * 记成 `needs_more_context` 而不是 `failureStage: 'generate'`，否则两版的「失败率」
   * 会因为一版更谨慎而变高 —— 那不是质量指标，是口径错误。
   */
  const outcome = generated.outcome === undefined ? (generated.ok === true ? 'valid_draft' : 'technical_failure') : String(generated.outcome)
  if (outcome !== 'valid_draft' && outcome !== 'invalid_draft') {
    records.push({
      ...base,
      outcome,
      ...(generated.reason === undefined ? {} : { reason: String(generated.reason) }),
      ...(Array.isArray(generated.next) ? { next: generated.next.map((line) => String(line)) } : {}),
      ...(generated.needsInputReason === undefined
        ? {}
        : { needsInputReason: String(generated.needsInputReason) }),
      elapsedMs: elapsed,
    })
    stage(`生成 ${item.id}`, 'passed', `${outcome}（${elapsed} ms）`)
    continue
  }

  records.push({
    ...base,
    outcome,
    text: String(generated.text ?? ''),
    ...(generated.needsInput === true ? { needsInput: true } : {}),
    ...(generated.needsInputReason === undefined
      ? {}
      : { needsInputReason: String(generated.needsInputReason) }),
    ...(generated.candidateId === undefined ? {} : { candidateId: String(generated.candidateId) }),
    ...(generated.argumentStrategy === undefined ? {} : { argumentStrategy: generated.argumentStrategy }),
    ...(generated.securityDecision === undefined
      ? {}
      : { securityDecision: String(generated.securityDecision) }),
    ...(Array.isArray(generated.securityReasons)
      ? { securityReasons: generated.securityReasons.map((reason) => String(reason)) }
      : {}),
    elapsedMs: elapsed,
  })
  stage(`生成 ${item.id}`, 'passed', `${elapsed} ms`)
}

/**
 * 在预览结果里按正文片段找到那条评论的 id。
 *
 * 找不到就返回 `undefined` —— 让确认走默认目标，而不是猜一个 id。猜错会让整条记录
 * 变成「答错了对象」的假失败。
 */
function findPostId(preview: Record<string, unknown>, fragment: string): string | undefined {
  const discussion = preview.discussion as
    | { comments?: readonly { id: string; text: string }[]; text?: string }
    | undefined
  if (discussion?.comments !== undefined) {
    const hit = discussion.comments.find((comment) => comment.text.includes(fragment))
    if (hit !== undefined) return hit.id
  }
  return undefined
}

// ---- 落盘 -------------------------------------------------------------------

function finish(verdict: 'passed' | 'failed' | 'partial'): never {
  const failed = records.filter((record) => record.failureStage !== undefined)
  const payload = {
    verdict: aborted ? 'partial' : verdict,
    versionLabel: VERSION_LABEL,
    persona: PERSONA,
    strategyRequested: STRATEGY,
    budget: { limit: BUDGET, used: calls },
    ...(aborted ? { abortReason } : {}),
    cases: records,
    stages,
    at: new Date().toISOString(),
    /**
     * 模型标识单独记，不进每条记录：整轮只有一个模型，重复 20 次只会让人以为
     * 可能换了模型。真实模型名由宿主侧证据记录（`evidence.json` / 桌面日志）。
     */
    modelSource: 'host-llm',
    environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
  }
  writeFileSync(join(OUT_DIR, 'quality-cases.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `\n结论：${payload.verdict}（成功 ${records.length - failed.length}，失败 ${failed.length}，` +
      `模型调用 ${calls}/${BUDGET}）\n输出：${join(OUT_DIR, 'quality-cases.json')}\n`,
  )
  socket.close()
  process.exit(payload.verdict === 'failed' ? 1 : 0)
}

finish('passed')
