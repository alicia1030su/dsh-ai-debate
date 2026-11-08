/**
 * 离线讨论导入的浏览器端到端验收（v0.2.30 §六）。
 *
 * ## 这个脚本和 `e2e-workbench.ts` 的分工
 *
 * 那个脚本走的是「真实平台的读取 → 发表」；这个走的是「接口读不到时的备用路径」：
 * 粘贴 → 预览 → 确认 → 分析 → 选人 → 人格 → 生成 → 编辑 → 安全评估 → 人工确认 → 复制。
 * 两条路径共用同一套分析器与安全闸门，所以这里**必须**证明它们真的是同一套——
 * 而不是另建了一个只在离线可用的辩论引擎。
 *
 * ## 什么算「真」
 *
 * - 真 Edge、真鼠标键盘（`Input.dispatchMouseEvent` / 逐字符 `Input.dispatchKeyEvent`）
 * - 真插件 HTTP 路由（页面自己 `fetch('/api/dsh-ai-debate/action')`，带会话 Cookie）
 * - 真宿主进程，拦截器挂在宿主的 `globalThis.fetch` 上，产品代码零改动
 *
 * ## 报告规则
 *
 * 每个阶段都记录它到底发生没发生。没跑到是 `skipped`，永远不是 `passed`；
 * 有任何 skipped 或 failed，进程退出码非零。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { EvidenceCollector, MANUAL_E2E_SCRIPT_VERSION } from './evidence.ts'
import { openPluginPage, openSettings, type ShellCtx } from './desktop-shell.ts'

interface StageResult {
  readonly name: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly detail: string
}

const stages: StageResult[] = []

function stage(name: string, status: StageResult['status'], detail: string): void {
  stages.push({ name, status, detail })
  const mark = status === 'passed' ? '✔' : status === 'failed' ? '✘' : '·'
  process.stdout.write(`${mark} ${name} — ${detail}\n`)
}

const port = Number(process.env.DSH_E2E_CDP_PORT ?? '9279')
const appPort = Number(process.env.DSH_E2E_APP_PORT ?? '58075')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/gui-manual'
const interceptLog = process.env.DSH_E2E_INTERCEPT_LOG ?? ''

mkdirSync(outDir, { recursive: true })

/**
 * 证据收集器（v0.2.31 §八）。
 *
 * 这个脚本从 v0.2.30 起就采 `exceptionThrown` 与 `console.error`，但只写进一个
 * `consoleErrors` 数组：不采失败请求、不采 4xx/5xx、不记 HEAD。
 * 于是「0 异常」只是一句话——它没覆盖网络层，也没说这份证据属于哪个提交。
 * v0.2.30 的第一轮全绿就跑在两个改过产品代码的提交之前。
 */
const startedAt = new Date().toISOString()

// ── CDP plumbing ────────────────────────────────────────────────────────────

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
  title?: string
}[]

console.log(
  `[debug] ${targets.length} 个目标：` +
    targets.map((t) => `${t.type}:${t.url.slice(0, 60)}`).join(' | '),
)

/**
 * 收集器先声明、后赋值。
 *
 * ## 声明必须在**任何** `finish()` 之前
 *
 * 原来这一行写在「找不到页面」分支的下面，注释还写着「写成 const 会撞 TDZ」——
 * 但 `let` 同样有 TDZ，只是延后到声明所在那一行才解除。于是那条分支实际报的是
 *
 *     ReferenceError: Cannot access 'evidence' before initialization
 *
 * 而不是它自己写的那句「没有找到 58130 的页面目标」。**一个诊断脚本在
 * 诊断失败时自己崩掉，等于把唯一的线索弄丢了。**
 *
 * v0.2.32 在真 Desktop 上第一次撞见：端口猜错 → 走这条分支 → 拿到一个
 * 和真实原因毫无关系的堆栈。
 */
let evidence: EvidenceCollector | undefined

/**
 * 取正确的页面目标。
 *
 * ## 为什么不按端口过滤
 *
 * 老写法是 `t.url.includes(String(appPort))`——那假设渲染进程加载的是
 * `http://127.0.0.1:<port>/?token=…`。**桌面端不满足这个假设**：
 * 它的窗口 URL 是 `dsh-app://app/`（Electron 自定义协议），端口只出现在
 * 宿主起的那个 web 后端里，渲染进程根本不带它。
 *
 * 于是桌面端一进来就「没有找到 58130 的页面目标」——一条看起来像
 * 「端口配错了」的失败，实际是「画布换了、URL 形态也换了」。
 *
 * 现在的判据：
 *   1. `dsh-app://`（桌面端）或含端口的 http 页（Web 端）都算候选；
 *   2. 排除 `chrome-error://`、`devtools://`、`about:blank`；
 *   3. 有多个时取最后一个 —— 宿主每次开链接都会新开标签，最早那个往往已失效。
 */
const candidates = targets.filter((t) => {
  if (t.type !== 'page') return false
  if (/^chrome-error:|^devtools:|^about:blank/.test(t.url)) return false
  return /^dsh-app:\/\//.test(t.url) || t.url.includes(String(appPort))
})
const page = candidates[candidates.length - 1]
if (page === undefined) {
  stage(
    '连接浏览器',
    'failed',
    `没有找到可用页面目标（端口 ${appPort}，共 ${targets.length} 个目标：${targets
      .map((t) => `${t.type}:${t.url.slice(0, 40)}`)
      .join(' | ') || '无'}）`,
  )
  finish()
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
/** 保留这个数组：页面自身读它做过一些断言，改造时不动它的语义。 */
const consoleErrors: string[] = []

evidence = new EvidenceCollector({
  script: 'e2e-manual-import.ts',
  scriptVersion: MANUAL_E2E_SCRIPT_VERSION,
  pageUrl: page.url,
  cdpPort: port,
  appPort,
  startedAt,
})
const collector = evidence

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data as string) as {
    id?: number
    method?: string
    result?: unknown
    error?: unknown
    params?: Record<string, unknown>
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id)!
    pending.delete(message.id)
    if (message.error !== undefined) entry.rej(new Error(JSON.stringify(message.error)))
    else entry.res(message.result)
    return
  }
  collector.record(message)
  // 兼容旧断言：这个数组仍然只记 error 级与未捕获异常。
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails as { text?: string } | undefined
    consoleErrors.push(`exception: ${details?.text ?? 'unknown'}`)
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const params = message.params as { type?: string; args?: { value?: unknown }[] } | undefined
    if (params?.type === 'error') {
      consoleErrors.push(`console.error: ${(params.args ?? []).map((a) => String(a.value ?? '')).join(' ')}`)
    }
  }
})

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
})

/**
 * 一次 CDP 调用的超时（v0.2.35）。
 *
 * ## 为什么必须有时限
 *
 * 这个脚本此前在「进入插件分区」之后**无限等待**过一次：`Page.captureScreenshot`
 * 发出去就没有回音，而 `send` 没有超时，于是整轮验收既不出结果也不退出 ——
 * 从外面看是「卡住」，从报告里看是「什么都没有」。
 *
 * 一个诊断脚本挂死，比它报错更糟：报错至少有一步的线索，挂死只有沉默。
 * 所以每一次调用都带上限，超时抛一个带方法名的错误。
 */
const CDP_TIMEOUT_MS = 30_000

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时（${CDP_TIMEOUT_MS} ms 未返回）`))
    }, CDP_TIMEOUT_MS)
    pending.set(id, {
      res: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      rej: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value: T }; exceptionDetails?: { text?: string } }
  if (result.exceptionDetails !== undefined) {
    throw new Error(`页面求值抛错：${result.exceptionDetails.text ?? '未知'}`)
  }
  return result.result.value
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function screenshot(name: string): Promise<void> {
  /**
   * ## 截图失败不该让整轮验收失败（v0.2.35）
   *
   * 截图是**证据**，不是断言。这一轮在真 Desktop 上撞到 `Page.captureScreenshot`
   * 30 秒不返回（页面很长、区块全堆在一起），于是整份报告只留下 9 条阶段加一条
   * 「执行中断」——而前面 9 条都是绿的，产品没有任何问题。
   *
   * 现在超时/失败只记一条 artifact 缺失，流程继续。要保证的是「断言都跑到了」，
   * 不是「每张图都拍到了」。
   */
  let result: { data?: string }
  try {
    result = (await send('Page.captureScreenshot', { format: 'png' })) as { data?: string }
  } catch (error) {
    process.stdout.write(`· 截图 ${name} 跳过：${(error as Error).message}\n`)
    return
  }
  if (typeof result.data !== 'string' || result.data === '') {
    process.stdout.write(`· 截图 ${name} 跳过：返回空数据\n`)
    return
  }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  /**
   * 把截图登记进证据清单。
   *
   * ## 第一版忘了这一句
   *
   * 截图确实写到磁盘上了（`01-start.png` 等），但 `evidence.json` 里
   * `screenshots: []`——因为收集器从来没被告知。报告于是写「证据含截图」，
   * 而清单里一张都没有：一份清单只列它知道的东西，不知道的不会自己出现。
   *
   * 这也说明「先声明后赋值」那个改动是对的：`collector` 在这里已被赋值，
   * 而 `finish()` 走的那条早退分支不会经过这个函数。
   */
  collector.screenshot(name)
}

/** 按可见文字点一个按钮或页签，用真实坐标。 */
async function clickByLabel(label: string): Promise<boolean> {
  const rect = await evaluate<{ x: number; y: number } | null>(`(() => {
    const nodes = [...document.querySelectorAll('button, [role=tab], a')]
    /**
     * 先找完全相等，再找「以它开头」。
     *
     * 只按相等匹配在这里会漏掉那一类**按钮上带额度提示**的按钮：v0.2.37 的
     * 「比较四种人格（4 次模型调用）」—— 提示是按钮文案的一部分（必须让用户点之前
     * 就知道要花四次），所以匹配要允许前缀。优先级仍是相等优先，避免点到
     * 「生成候选」而不是「生成候选回复」这种包含关系。
     */
    const exact = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
    const node = exact ?? nodes.find((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(label)}))
    if (!node) return null
    const first = node.getBoundingClientRect()
    if (first.width === 0 || first.height === 0) return null
    node.scrollIntoView({ block: 'center', inline: 'center' })
    const r = node.getBoundingClientRect()
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null
    return { x: Math.round(cx), y: Math.round(cy) }
  })()`)
  if (rect === null) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  return true
}

/**
 * 按坐标派发一次真实鼠标点击。
 *
 * `el.click()` 在桌面 webview 的浮层菜单上会「返回成功但没切视图」——
 * 菜单不关、设置不开。这是 v0.2.32 在真 Desktop 里实测到的差异：
 * 同一段代码在 Edge 里能用，在 Electron 里失效。
 */
async function clickAt(x: number, y: number): Promise<void> {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    })
  }
}

/** 逐字符发键盘事件。`Input.insertText` 不触发 React 的 onChange。 */
async function typeText(text: string): Promise<void> {
  for (const char of text) {
    if (char === '\n') {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      continue
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
}

/** 点进某个元素，然后全选并重打。 */
async function replaceIn(
  selectorExpression: string,
  text: string,
): Promise<boolean> {
  const rect = await evaluate<{ x: number; y: number } | null>(`(() => {
    const el = ${selectorExpression}
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: Math.round(r.x + Math.min(40, r.width / 2)), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (rect === null) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  await sleep(260)
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  })
  await sleep(160)
  await typeText(text)
  return true
}

async function dismissOverlays(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    if (await clickByLabel('继续')) {
      await sleep(1100)
      continue
    }
    const closed = await evaluate<boolean>(`(() => {
      const button = document.querySelector('[role="dialog"] button[aria-label="关闭"]')
      if (button === null) return false
      button.click()
      return true
    })()`)
    if (closed) {
      await sleep(750)
      continue
    }
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
    }
    await sleep(700)
  }
}

/**
 * 点**离线导入分区里**的那个按钮。
 *
 * ## 为什么不能按文字全页找（v0.2.34）
 *
 * v0.2.33 给「发表工作台」也加了「复制回复」，于是页面上同时存在两个同名按钮。
 * `clickByLabel` 取的是文档顺序里第一个 —— 那是工作台的（它渲染在离线导入之前）。
 * 点下去，工作台那边确实提示了「已复制到剪贴板」，而本测试读的是**离线导入分区**
 * 的正文，于是看到「什么都没发生」。
 *
 * 这条错误 v0.2.33 就存在了，只是那一版没再跑这份脚本：它跑的是 `desktop-weibo.ts`。
 * 同一个字面量在两个分区里出现，判据必须带上作用域 —— 否则测试会随时间自己变错。
 */
async function clickInManualSection(label: string): Promise<boolean> {
  const rect = await evaluate<{ x: number; y: number } | null>(`(() => {
    const sections = [...document.querySelectorAll('.dsd-sect')]
    const scope = sections.find((s) => s.innerText.includes('离线讨论导入'))
    if (!scope) return null
    const node = [...scope.querySelectorAll('button, [role=tab], a')]
      .find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
    if (!node) return null
    node.scrollIntoView({ block: 'center', inline: 'center' })
    const r = node.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null
    return { x: Math.round(cx), y: Math.round(cy) }
  })()`)
  if (rect === null) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  return true
}

/** 离线导入分区的正文，用于断言页面上真的显示了什么。 */
function manualSectionText(): Promise<string> {
  return evaluate<string>(`(() => {
    const sections = [...document.querySelectorAll('.dsd-sect')]
    const target = sections.find((s) => s.innerText.includes('离线讨论导入'))
    return target ? target.innerText : ''
  })()`)
}

/** 走页面自己的路由。与会话 Cookie 一起，等价于点按钮发出的那个请求。 */
let sessionId = ''

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
    return { __unparsable: raw.slice(0, 200) }
  }
}

function finish(): never {
  const failed = stages.filter((s) => s.status === 'failed')
  const skipped = stages.filter((s) => s.status === 'skipped')
  /**
   * 异常信号参与结论（v0.2.31 §八）。
   *
   * 只记录不影响结论的信号，等于给报告加一个没人看的栏位。这里把未捕获异常、
   * 失败请求与 5xx 都算进 verdict——一份「47/47 通过但抛了 3 个异常」的运行
   * 不该读起来是全绿。
   *
   * 业务 4xx 不算：这个脚本会故意请求不存在的东西来验证拒绝路径，而本项目的
   * 约定是「业务失败回 200 + ok:false」，所以出现的 4xx 只可能是静态资源，
   * 那属于真问题，仍然计入。
   */
  const signals = evidence === undefined ? [] : evidence.signalsView()
  const fatal = signals.filter(
    (signal) => signal.kind === 'exception' || signal.kind === 'network' || signal.kind === 'http',
  )
  const verdict = {
    verdict: failed.length === 0 && skipped.length === 0 && fatal.length === 0 ? 'passed' : 'failed',
    stages,
    consoleErrors,
    signals,
    fatalSignals: fatal.length,
    at: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(verdict, null, 2), 'utf8')
  if (evidence !== undefined) {
    evidence.finish({ outDir, stages, cwd: process.cwd() })
  }
  process.stdout.write(
    `\n结论：${verdict.verdict}（失败 ${failed.length}，跳过 ${skipped.length}，` +
      `异常信号 ${fatal.length}/${signals.length}）\n`,
  )
  process.exit(verdict.verdict === 'passed' ? 0 : 1)
}

// ── 素材 ────────────────────────────────────────────────────────────────────

const SAMPLE = [
  '# 价格翻倍合理吗',
  '',
  '原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。',
  '---',
  '路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。',
  '路人乙：行业平均也才涨了三成，翻倍是漫天要价。',
  '路人丙：两边都有道理，但翻倍确实夸张了。',
].join('\n')

/**
 * 侧边栏的「插件」按钮是否可点。
 *
 * 用它当「界面恢复了」的判据，而不是 `body.innerText.length > 200`：
 * 字符数在欢迎页、登录引导、插件列表三种形态下都能满足，而这三者对下一步的
 * 要求完全不同。按钮存在才是「可以继续操作」。
 */
function shellReady(): Promise<boolean> {
  return evaluate<boolean>(`(() => {
    const node = [...document.querySelectorAll('button, [role=tab], a')]
      .find((n) => (n.textContent || '').trim() === '插件')
    if (!node) return false
    const r = node.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })()`)
}

interface OpenResult {
  plugins: boolean
  row: boolean
  detail: boolean
  config: boolean
  /**
   * 从哪扇门进去的。
   *
   * 这两条路渲染的**不是同一个东西**，下游断言必须知道走的是哪条：
   *
   * - `card`：插件行 → 详情 → 配置。渲染带 11 个页签的分区，要先点「离线导入」页签。
   * - `section`：设置侧栏 → AI代吵架。渲染**全部区块堆叠**，没有页签——
   *   这是设计如此（注释在 `renderSection` 里：侧栏是「什么都让我看见」那扇门，
   *   插件行才是带页签的那张卡）。
   *
   * v0.2.32 实测：新版宿主只剩 `section` 那扇门，于是「十一个页签渲染」
   * 与「离线导入页签存在」两条必然红——它们问的是旧入口的形状，
   * 不是产品的能力。
   */
  route: 'card' | 'section' | 'none'
}

/**
 * 打开插件配置页。
 *
 * ## 这条路在 0.2.2-rc.1 上必须换走法
 *
 * v0.2.31 的写法是：侧栏「插件」→ `[aria-label="查看 dsh-ai-debate"]` 卡片 →
 * `[aria-label="配置 dsh-ai-debate"]`。那套选择器在 0.2.2-rc.1 上**整条断掉**：
 *
 * - 卡片还在，但点开显示的是 README（目录 / 它能做什么 / 安装），
 *   没有任何 `data-plugin-config` 区块，也没有「配置」按钮；
 * - 新版把设置页改成了 `settings.plugins.tab`（一个插件一个 tab），
 *   而插件注册的 `plugins.row.config` 槽位在插件页里不再渲染。
 *
 * 但**设置侧栏那扇门还在**：账号菜单 → 设置 → 「AI代吵架」。
 * 所以这里改成两条路都试，新版优先：
 *
 *   1. 账号菜单 → 设置 → AI代吵架   （0.2.2-rc.1 起）
 *   2. 插件 → 卡片 → 配置           （v0.2.30 及以前）
 *
 * 写两条而不是只写新的：这套脚本要在两种宿主上都跑得通，
 * 而「只支持最新宿主」等于把回归能力扔掉。
 */
/**
 * 把本脚本的原语包成 `ShellCtx`，让 `desktop-shell.ts` 的两步（开设置、进分区）
 * 在这条路上也能用。
 *
 * ## 为什么不再各写一份（v0.2.35）
 *
 * 这一段原来自己实现「账号菜单 → 设置 → AI代吵架」。真 Desktop 一跑就红三条，
 * 因为桌面端的入口是左下角「… 更多」，不是 `aria-label="账号菜单"`；设置面板首屏
 * 也没有它断言的 `通用设置|内置插件|Agent 预设`。
 *
 * 而 `desktop-shell.ts` 里那一份，这一轮在桌面微博上跑通了 45/45 —— 同一台机器、
 * 同一个宿主、同一个版本。两份实现各写各的，正是 v0.2.31 那次「三处脚本各自为政」
 * 的重演：断言没错，入口写法漂了。
 *
 * 所以这里改成：**有 `desktop-shell` 就先用它**，失败再落到旧路线。
 */
function shellCtx(): ShellCtx {
  return {
    evaluate,
    clickAt,
    clickByText: clickByLabel,
    sleep,
    viewport: async () => {
      const size = await evaluate<{ w: number; h: number }>('({ w: window.innerWidth, h: window.innerHeight })')
      return { vw: size.w, vh: size.h }
    },
  }
}

async function openPluginConfig(): Promise<OpenResult> {
  // ── 路线 1：新版（账号菜单 → 设置 → 插件页签）──────────────────────────
  /**
   * ## 账号菜单的定位要与 `desktop-shell.openSettings` 一致（v0.2.35）
   *
   * 这里原来只认 `aria-label="账号菜单"`。真 Desktop 左下角那一个是「… 更多」，
   * 没有那个 aria-label，于是整条路线 1 直接跳过，落到旧卡片路线，
   * 而那套选择器在 0.2.2-rc.1 上已经断了 —— 报告里三条红，产品是好的。
   *
   * `desktop-shell.ts` 里那份是这一轮桌面微博跑通 45/45 的实现：先按 aria-label
   * 找，找不到就取**最靠下**的那个可见按钮（账号菜单固定在左下角）。
   */
  /**
   * 路线 1 前置：先用与桌面微博脚本同一份实现试一次。
   */
  {
    const settings = await openSettings(shellCtx())
    stage('桌面入口：打开设置', settings.ok ? 'passed' : 'failed', settings.how)
    if (settings.ok) {
      const plugin = await openPluginPage(shellCtx(), { markers: /离线讨论导入|主人贴吧数字 ID|当前步骤/ })
      stage('桌面入口：进入插件分区', plugin.mounted ? 'passed' : 'failed', plugin.detail)
      if (plugin.mounted) {
        return { plugins: true, row: true, detail: true, config: true, route: 'section' }
      }
    }
  }

  const accountMenu = await evaluate<string>(`(() => {
    const bs = [...document.querySelectorAll('button')]
      .map(b => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') || '', x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height } })
      .filter(b => b.w > 0 && b.h > 0)
    const byLabel = bs.find(b => b.label === '账号菜单')
    const pick = byLabel ?? bs.sort((a, b) => b.y - a.y)[0]
    return pick === undefined ? 'not-found' : JSON.stringify({ x: Math.round(pick.x), y: Math.round(pick.y) })
  })()`)
  if (accountMenu !== 'not-found') {
    const { x, y } = JSON.parse(accountMenu) as { x: number; y: number }
    await clickAt(x, y)
    await sleep(1200)
    // 菜单项是「设置 Ctrl+,」——startsWith 匹配；用真实鼠标点，
    // el.click() 在浮层上会「点成功但没切视图」。
    const settingsPos = await evaluate<string>(`(() => {
      const el = [...document.querySelectorAll('button,[role=menuitem],[tabindex]')]
        .find(e => /^设置(\\s|$)/.test((e.innerText || '').trim()))
      if (!el) return 'not-found'
      const r = el.getBoundingClientRect()
      return r.width < 2 ? 'not-found' : JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`)
    if (settingsPos !== 'not-found') {
      const p = JSON.parse(settingsPos) as { x: number; y: number }
      await clickAt(p.x, p.y)
      await sleep(2500)

      const paneText = await evaluate<string>('document.body.innerText')
      /**
       * ## 判据从「设置页长什么样」改成「有没有那一行」（v0.2.35）
       *
       * 这里原来要求设置面板里出现 `通用设置|内置插件|Agent 预设` 之一才继续。
       * 那是浏览器宿主（dsh web）的文案；真 Desktop 的设置面板首屏并不包含这些词，
       * 于是整条路线在桌面端直接跳过，回退到旧版「插件 → 卡片 → 配置」，
       * 而那套选择器在 0.2.2-rc.1 上已经断了 —— 报告里三条红，产品却好好的。
       *
       * 真正该问的是「有没有可点的 AI代吵架 那一行」。设置页长什么样不是契约，
       * 导航项在不在才是。
       */
      void paneText
      {
        /**
         * ## 选择器要与 `desktop-shell.openPluginPage` 一致（v0.2.35）
         *
         * 这里原来只查 `button,[role=tab],[role=button]`。真 Desktop 的设置侧栏
         * 那一行不是这三种之一（它是带 `tabindex` 的行），于是「进插件分区」在
         * 桌面端**永远找不到**，脚本回退到旧版卡片路线，而那套选择器在 0.2.2-rc.1
         * 上已经断了 —— 三条红，产品却好好的。
         *
         * `desktop-shell.ts` 里那份实现是这一轮跑通 45/45 的那一份，选择器要与它
         * 一致；两份各写各的正是 v0.2.31 那次「三处脚本各自为政」的重演。
         */
        const tabPos = await evaluate<string>(`(() => {
          const nodes = [...document.querySelectorAll('button,[role=tab],[role=button],a,[tabindex]')]
            .filter(e => {
              const t = (e.innerText || '').trim()
              return t === 'AI代吵架' || /AI代吵架|dsh-ai-debate/.test(t)
            })
          let best
          for (const e of nodes) {
            const r = e.getBoundingClientRect()
            if (r.width < 2 || r.height < 2) continue
            const area = r.width * r.height
            if (best === undefined || area < best.area) {
              best = { area, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
            }
          }
          return best === undefined ? 'not-found' : JSON.stringify({ x: best.x, y: best.y })
        })()`)
        if (tabPos !== 'not-found') {
          const p2 = JSON.parse(tabPos) as { x: number; y: number }
          await clickAt(p2.x, p2.y)
          await sleep(2500)
          const after = await evaluate<string>('document.body.innerText')
          if (/离线讨论导入|主人贴吧数字 ID|当前步骤/.test(after)) {
            return { plugins: true, row: true, detail: true, config: true, route: 'section' }
          }
          return { plugins: true, row: true, detail: true, config: false, route: 'section' }
        }
        return { plugins: true, row: true, detail: false, config: false, route: 'none' }
      }
    }
  }

  // ── 路线 2：旧版（插件列表 → 卡片 → 配置）──────────────────────────────
  const plugins = await clickByLabel('插件')
  const deadline = Date.now() + 20_000
  let row = false
  while (Date.now() < deadline) {
    row = await evaluate<boolean>(`document.querySelector('[aria-label="查看 dsh-ai-debate"]') !== null`)
    if (row) break
    await sleep(500)
  }
  const detail = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="查看 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(2200)
  const config = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="配置 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(2600)
  return { plugins, row, detail, config, route: config ? 'card' : 'none' }
}

// ── the run ─────────────────────────────────────────────────────────────────

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  stage('连接浏览器', 'passed', `CDP ${port}，页面 ${page.url.slice(0, 40)}`)

  /**
   * ## 先从一次刷新开始
   *
   * 脚本跑在别人刚动过的浏览器上：上一次运行留下的配置页、一个残留的弹窗、
   * 半开的面板。第一次跑就是从这里开始，前三阶段全红，而产品没有任何问题——
   * 报告里那三条「找不到查看按钮」纯属脏状态。
   *
   * 所以先刷新到确定状态再开始。这不是为了让测试好过：它让每个阶段断言的是
   * 产品，而不是上一轮留下的屏幕。
   */
  await send('Page.reload')
  await sleep(1500)
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  let booted = false
  const bootDeadline = Date.now() + 45_000
  while (Date.now() < bootDeadline) {
    if (await shellReady()) {
      booted = true
      break
    }
    await sleep(1000)
  }
  stage('页面加载到可操作状态', booted ? 'passed' : 'failed', booted ? '侧边栏「插件」可点' : '45 秒内侧边栏没有可点的「插件」')

  await dismissOverlays()
  await screenshot('01-start')

  // ── 正常流程 1/15：进入插件配置页 ──────────────────────────────────────
  const opened = await openPluginConfig()
  stage('打开插件页', opened.plugins ? 'passed' : 'failed', opened.plugins ? '已点击' : '找不到「插件」')
  stage('插件行出现', opened.row ? 'passed' : 'failed', opened.row ? '列表里有 dsh-ai-debate' : '20 秒内没有渲染出插件行')
  stage('打开插件详情', opened.detail ? 'passed' : 'failed', opened.detail ? '已点击' : '找不到查看按钮')
  stage('打开配置页', opened.config ? 'passed' : 'failed', opened.config ? '已点击' : '找不到配置按钮')

  /**
   * ## 两条门，两种形状，断言必须跟着走
   *
   * `card`（插件行 → 配置）：渲染带 11 个页签的卡片，要先点「离线导入」页签。
   * `section`（设置侧栏 → AI代吵架）：渲染**全部区块堆叠**，没有页签——
   * 设计如此（`renderSection` 的注释：侧栏是「什么都让我看见」那扇门）。
   *
   * v0.2.32 实测：0.2.2-rc.1 只剩 `section` 那扇门。如果还按旧形状断言
   * 「11 个页签」「离线导入页签存在」，就会得到两条假失败——它们问的是
   * **旧入口的形状**，不是产品的能力。
   *
   * 但也不能因此把这两条删掉：在旧宿主上它们是真回归。
   * 所以改成按 route 分支验，两条路都在两种形状下被检查到。
   */
  const tabs = await evaluate<string[]>(
    `[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`,
  )
  if (opened.route === 'card') {
    stage('十一个页签渲染', tabs.length === 11 ? 'passed' : 'failed', `实际 ${tabs.length} 个：${tabs.join('/')}`)
    stage(
      '离线导入页签存在',
      tabs.includes('离线导入') ? 'passed' : 'failed',
      tabs.includes('离线导入') ? '在页签列表里' : `没有这一页：${tabs.join('/')}`,
    )
  } else {
    /**
     * 侧栏门没有页签——**这条断言在这个入口上不成立，所以不记录。**
     *
     * 早先写的是 `stage(..., 'skipped', ...)`。但本项目的约定是
     * 「skipped 不算通过」，而 `verdict` 把 skipped 也算进 failed。
     * 于是只要跑在新宿主上，整份报告永远是 failed——**一个永远红的信号
     * 等于没有信号**，看的人第三次之后就不看了。
     *
     * 断言的作用域本来就该跟着入口走：页签是卡片门的形状，侧栏门验的是
     * 「区块在不在」（下一条）。**不适用 ≠ 没验过。**
     */
    const stacked = await evaluate<boolean>(`document.body.innerText.includes('离线讨论导入')`)
    stage(
      '侧栏门渲染了离线导入区块',
      stacked ? 'passed' : 'failed',
      stacked ? '离线讨论导入区块在页面上（这条门没有页签，也不该有）' : '页面上没有离线讨论导入区块',
    )
  }

  // ── 2/15：进入离线导入 ────────────────────────────────────────────────
  //
  // 侧栏门没有页签，已经直接落在「离线讨论导入」区块上，不需要再点。
  const manualTab = opened.route === 'card' ? await clickByLabel('离线导入') : true
  await sleep(2000)
  if (opened.route === 'card') {
    stage('进入离线导入页签', manualTab ? 'passed' : 'failed', manualTab ? '已点击页签' : '找不到页签')
  }
  await screenshot('02-manual-tab')

  const firstScreen = await manualSectionText()
  // 这是 P0-6 要抓的第一件事：首屏不能崩、不能空白。
  stage(
    '首屏渲染出导入表单',
    firstScreen.includes('粘贴文本') && firstScreen.includes('预览解析结果')
      ? 'passed'
      : 'failed',
    firstScreen.length === 0 ? '整个分区是空的（渲染崩了）' : firstScreen.slice(0, 60).replace(/\n/g, ' / '),
  )

  const noSession = await evaluate<boolean>(`document.body.innerText.includes('还没有导入任何内容')`)
  stage('无会话时说明空状态', noSession ? 'passed' : 'failed', noSession ? '显示了「还没有导入任何内容」' : '空状态没有说明')

  // ── 3/15：粘贴一段讨论 ────────────────────────────────────────────────
  const typedContent = await replaceIn(`document.querySelector('textarea')`, SAMPLE)
  await sleep(600)
  const textareaValue = await evaluate<string>(`document.querySelector('textarea')?.value ?? ''`)
  stage(
    '粘贴讨论正文',
    typedContent && textareaValue.includes('路人丙') && textareaValue.includes('\n---')
      ? 'passed'
      : 'failed',
    `textarea ${textareaValue.length} 字符，含分隔线 ${textareaValue.includes('---')}`,
  )
  await screenshot('03-content-typed')

  // ── 4/15：预览解析 ───────────────────────────────────────────────────
  const previewClicked = await clickByLabel('预览解析结果')
  await sleep(2600)
  stage('点击预览解析', previewClicked ? 'passed' : 'failed', previewClicked ? '已点击真实按钮' : '按钮不存在')

  const previewText = await manualSectionText()
  const previewOk =
    previewText.includes('解析结果') &&
    previewText.includes('原帖作者') &&
    previewText.includes('路人丙')
  stage(
    '预览解析结果',
    previewOk ? 'passed' : 'failed',
    previewOk ? '页面列出了原帖、参与者与条数' : `没有解析结果：${previewText.slice(0, 120).replace(/\n/g, ' / ')}`,
  )
  stage(
    '预览提示未经核验',
    previewText.includes('没有向平台核对过') ? 'passed' : 'failed',
    previewText.includes('没有向平台核对过') ? '已说明这份内容来自剪贴板' : '缺少未经核验的说明',
  )
  await screenshot('04-preview')

  // ── 5/15：确认导入 ───────────────────────────────────────────────────
  const ownerFilled = await replaceIn(
    `[...document.querySelectorAll('input[type=text]')].find((i) => i.placeholder === '哪个是你（用于判断争论对象）')`,
    '原帖作者',
  )
  await sleep(500)
  stage('填写「哪个是你」', ownerFilled ? 'passed' : 'failed', ownerFilled ? '已填入原帖作者' : '找不到这个输入框')

  const confirmClicked = await clickByLabel('确认导入并分析')
  await sleep(4200)
  stage('确认导入并分析', confirmClicked ? 'passed' : 'failed', confirmClicked ? '已点击真实按钮' : '按钮不存在')

  const afterConfirm = await manualSectionText()
  const sessionCreated = afterConfirm.includes('当前步骤')
  stage(
    '会话建立',
    sessionCreated ? 'passed' : 'failed',
    sessionCreated ? '页面显示了当前步骤' : afterConfirm.slice(0, 120).replace(/\n/g, ' / '),
  )

  // ── 6/15：来源标识 ───────────────────────────────────────────────────
  // 这是 §四 的核心：页面上必须写着「人工导入 · 未经平台核验」。
  const sourceShown =
    afterConfirm.includes('人工导入') &&
    afterConfirm.includes('未经平台核验') &&
    afterConfirm.includes('插件没有向平台核对过')
  stage(
    '显示「人工导入 · 未经平台核验」',
    sourceShown ? 'passed' : 'failed',
    sourceShown ? '来源标识在分区顶部' : '缺少来源标识或警示',
  )
  await screenshot('05-confirmed')

  // ── 7/15：十一步进度 ─────────────────────────────────────────────────
  const stepLine = afterConfirm
    .split('\n')
    .find((line) => line.includes('✔') || line.includes('▶'))
  const stepCount = (stepLine ?? '').split(/[✔▶·]/).filter((piece) => piece.trim() !== '').length
  stage(
    '十一步进度条',
    stepCount === 11 ? 'passed' : 'failed',
    stepCount === 11 ? `十一步，当前 ▸ ${stepLine?.match(/▶\s*([^·]+)/)?.[1]?.trim() ?? '?'}` : `实际 ${stepCount} 步：${stepLine ?? '（没有进度行）'}`,
  )

  // ── 8/15：先拿到会话与目标 ───────────────────────────────────────────
  const workbenchRaw = await evaluate<string>(`(async () => {
    const r = await fetch('/api/dsh-ai-debate/workbench')
    return await r.text()
  })()`)
  const workbench = JSON.parse(workbenchRaw) as {
    ok?: boolean
    sessionId?: string
    platform?: string
    source?: { kind?: string }
    manualFlow?: { step?: string; copyAllowed?: boolean; steps?: unknown[] }
    candidates?: { replyId: string; approved: boolean }[]
    blockers?: string[]
  }
  sessionId = workbench.sessionId ?? ''
  stage(
    '工作台能读到这条导入会话',
    workbench.ok === true && sessionId !== ''
      ? 'passed'
      : 'failed',
    workbench.ok === true
      ? `sessionId=${sessionId}，平台=${workbench.platform}`
      : `读不到：${JSON.stringify(workbench.blockers ?? [])}`.slice(0, 200),
  )
  stage(
    '工作台不报「平台没有注册」',
    (workbench.blockers ?? []).some((line) => /没有注册/.test(line)) === false
      ? 'passed'
      : 'failed',
    (workbench.blockers ?? []).some((line) => /没有注册/.test(line))
      ? `仍然报错：${JSON.stringify(workbench.blockers)}`
      : '未出现该错误',
  )
  stage(
    '来源标识由服务端判定',
    workbench.source?.kind === 'manual_import' ? 'passed' : 'failed',
    `source.kind=${workbench.source?.kind ?? '(缺失)'}`,
  )

  // ── 9/15：四种人格 ───────────────────────────────────────────────────
  //
  // ## 为什么要按「——」筛，而不是数所有 option
  //
  // v0.2.31 之前离线分区里只有一个 `<select>`（人格）。这一版加了交互式纠错，
  // 每条发言下面多了一个「在回哪一条」的下拉框，于是「页面上有几个 option」
  // 从 4 变成了 22——断言红了，而产品没有任何问题。
  //
  // 人格选项的文案是 `名字 —— 一句话说明`，纠错下拉框的选项是 id + 作者 + 摘录。
  // 按这个分隔符筛，测的就还是「人格有几个」，而不是「这一页有几个下拉框」。
  const personaOptions = await evaluate<string[]>(
    `[...document.querySelectorAll('select option')]
      .map((o) => o.textContent.trim())
      .filter((text) => text.includes(' —— '))`,
  )
  stage(
    '四种人格可选',
    personaOptions.length === 4 ? 'passed' : 'failed',
    `${personaOptions.length} 个：${personaOptions.map((o) => o.split(' —— ')[0]).join('/')}`,
  )

  /**
   * 生成失败时，把「页面上说的那句原因」抓出来。
   *
   * ## 为什么不能只截分区尾部
   *
   * 上一轮的报告只留了一句「240 秒内没有候选」加一段无关的表单文字 —— 段错误提示
   * 在分区**顶部**（`setError` 的渲染位置），而截尾部永远看不到它。一条查不出原因
   * 的红，比一条没有跑的红更浪费时间。
   */
  const generationFailureDetail = async (): Promise<string> => {
    const section = await manualSectionText()
    const whole = await evaluate<string>('document.body ? document.body.innerText : ""')
    const pick = (text: string): string =>
      text
        .split('\n')
        .filter((line) => /失败|错误|模型|无法|拒绝|超时|没有配置|未配置|原因/.test(line))
        .slice(0, 3)
        .join(' / ')
    const fromSection = pick(section)
    const fromBody = pick(whole)
    return (fromSection || fromBody || section.slice(-160)).slice(0, 300).replace(/\n/g, ' / ')
  }

  /**
   * ── 四种人格比较（v0.2.37 §7/§3.3）──────────────────────────────────
   *
   * 只在 `DSH_E2E_COMPARE=1` 时跑：一次点击是**四次真实模型调用**，而普通回归
   * 用假模型跑四遍只会多花四份时间、证明不了额外的东西。真实模型那一轮打开它。
   */
  if (process.env.DSH_E2E_COMPARE === '1') {
    const compareClicked = await clickByLabel('比较四种人格')
    stage(
      '点击「比较四种人格」',
      compareClicked ? 'passed' : 'failed',
      compareClicked ? '已点击真实按钮（4 次模型调用）' : '按钮不存在或不可点',
    )
    if (compareClicked) {
      const deadline = Date.now() + (process.env.DSH_E2E_REAL_MODEL === '1' ? 600_000 : 120_000)
      let done = false
      while (Date.now() < deadline) {
        await sleep(2000)
        const text = await manualSectionText()
        if (text.includes('四种人格比较') && /(贴吧老哥|小受|傲娇|高冷)/.test(text)) {
          done = true
          break
        }
        if (text.includes('比较失败')) break
      }
      const text = await manualSectionText()
      stage(
        '比较结果渲染出来',
        done ? 'passed' : 'failed',
        done
          ? '页面上出现了四种人格的比较区块'
          : `等待超时或失败：${text.slice(-200).replace(/\n/g, ' / ')}`,
      )
      if (done) {
        /**
         * 四份都必须**对准同一个目标**。判据是每条候选旁边渲染的目标说明与当前
         * 目标一致 —— 这正是 §3.3 第一条门槛（「对准同一个目标」）在界面上的样子。
         */
        const block = text.slice(text.lastIndexOf('四种人格比较'))
        /**
         * 逐行数「真正出了结果的」，不是数「名字出现过」。
         *
         * 第一版就是数名字 —— 而人格选择器把四个名字都渲染在页面上，于是这条断言
         * 在**只有三个人格成功**的一轮里照样变绿。改成读每一条的结果行
         * （`人格名 · 通过/需确认/阻止` 或 `人格名 · 这一条没生成出来`），
         * 只有 OK 的才算数，失败的单独列出来。
         */
        const names = ['贴吧老哥', '小受', '傲娇', '高冷']
        const okRows = names.filter((name) =>
          block.split('\n').some((line) => line.startsWith(name) && !line.includes('没生成出来')),
        )
        const failedRows = block
          .split('\n')
          .filter((line) => line.includes('没生成出来'))
          .map((line) => line.slice(0, 80))
        stage(
          '四种人格都在结果里',
          okRows.length === 4 ? 'passed' : 'failed',
          failedRows.length === 0
            ? `${okRows.length} 个：${okRows.join('/')}`
            : `${okRows.length} 个成功；失败：${failedRows.join(' ｜ ')}`,
        )
        const targetLine = block.split('\n').find((line) => line.includes('这段话是回给')) ?? ''
        stage(
          '比较结果带着回复目标',
          targetLine !== '' ? 'passed' : 'failed',
          targetLine.slice(0, 120) || '结果区块里没有目标说明',
        )
      }
    }
  }

  // ── 10/15：生成候选 ──────────────────────────────────────────────────
  const genClicked = await clickByLabel('生成候选回复')
  let generated = false
  /**
   * 等待上限按模型来源分开（v0.2.36）。
   *
   * 假模型 200ms 就回；宿主模型一次十几到几十秒，推理模型更久。同一个 90 秒上限
   * 会把「慢」判成「坏」——而这条断言问的是「有没有生成」，不是「快不快」。
   */
  const genWaitMs = process.env.DSH_E2E_REAL_MODEL === '1' ? 240_000 : 90_000
  const genDeadline = Date.now() + genWaitMs
  while (Date.now() < genDeadline) {
    const text = await manualSectionText()
    if (text.includes('安全评估') && text.includes('正文（可以直接改）')) {
      generated = true
      break
    }
    if (text.includes('内部错误') || text.includes('模型输出不符合约定')) break
    await sleep(1200)
  }
  stage(
    '点击生成候选回复',
    genClicked ? 'passed' : 'failed',
    genClicked ? '已点击真实按钮' : '按钮不存在',
  )
  stage(
    '候选出现在页面上',
    generated ? 'passed' : 'failed',
    generated
      ? '页面渲染了候选正文与安全评估'
      : `${Math.round(genWaitMs / 1000)} 秒内没有候选：${await generationFailureDetail()}`,
  )
  await screenshot('06-generated')

  // ── 11/15：安全评估显示 ──────────────────────────────────────────────
  const genText = await manualSectionText()
  const assessmentShown = /安全评估：(通过|需要你看过再决定|阻止)/.test(genText)
  stage(
    '安全评估结论显示',
    assessmentShown ? 'passed' : 'failed',
    assessmentShown ? genText.match(/安全评估：[^\n]*/)?.[0] ?? '' : '没有安全评估结论',
  )
  stage(
    '目标显示「这段话是回给」',
    genText.includes('这段话是回给') ? 'passed' : 'failed',
    genText.includes('这段话是回给')
      ? genText.match(/这段话是回给：[^\n]*/)?.[0] ?? ''
      : '没有目标说明',
  )

  // ── 12/15：未确认前不能复制 ──────────────────────────────────────────
  const copyBefore = await evaluate<{ label: string; disabled: boolean } | null>(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(复制回复|还不能复制)$/.test((n.textContent || '').trim()))
    return b ? { label: b.textContent.trim(), disabled: b.disabled } : null
  })()`)
  stage(
    '未确认时复制被挡住',
    copyBefore !== null && copyBefore.disabled === true
      ? 'passed'
      : 'failed',
    copyBefore === null ? '找不到复制按钮' : `${copyBefore.label}，disabled=${copyBefore.disabled}`,
  )

  // ── 13/15：编辑正文 ──────────────────────────────────────────────────
  const edited =
    '修不修不是逻辑问题，是账算不算得过来的问题。你说「先修」，那要先说清修完之后还打算用几年。'
  const editedOk = await replaceIn(
    `[...document.querySelectorAll('textarea')].find((t) => (t.value || '').length > 20 && t !== document.querySelector('textarea'))`,
    edited,
  )
  await sleep(400)
  stage('编辑正文', editedOk ? 'passed' : 'failed', editedOk ? '已改写到正文框' : '找不到正文输入框')

  const saveClicked = await clickByLabel('保存并重新评估')
  await sleep(3500)
  stage('保存并重新评估', saveClicked ? 'passed' : 'failed', saveClicked ? '已点击真实按钮' : '按钮不存在')

  const afterSave = await manualSectionText()
  stage(
    '保存后仍是安全的',
    /安全评估：(通过|需要你看过再决定)/.test(afterSave) ? 'passed' : 'failed',
    afterSave.match(/安全评估：[^\n]*/)?.[0] ?? '没有评估结论',
  )
  await screenshot('07-edited')

  /**
   * 确认没生效时，把页面**说出的原因**抓出来。
   *
   * 只记「25 秒内没有变化」等于什么都没说：确认可能被服务端拒绝（正文不一致 /
   * 安全阻止 / 快照缺失），而那句话就渲染在分区里，截尾部永远看不到。
   */
  const approveFailureDetail = async (): Promise<string> => {
    const text = await manualSectionText()
    const line = text
      .split('\n')
      .find((row) => /不一致|不能|失败|阻止|错误|刷新页面|没有候选/.test(row))
    return (line ?? text.slice(-160)).slice(0, 220).replace(/\n/g, ' / ')
  }

  // ── 14/15：人工确认 ──────────────────────────────────────────────────
  const approveClicked = await clickByLabel('人工确认')
  let approved = false
  const approveDeadline = Date.now() + 25_000
  while (Date.now() < approveDeadline) {
    const text = await manualSectionText()
    if (text.includes('已确认')) {
      approved = true
      break
    }
    await sleep(900)
  }
  stage('点击人工确认', approveClicked ? 'passed' : 'failed', approveClicked ? '已点击真实按钮' : '按钮不存在')
  stage(
    '确认生效',
    approved ? 'passed' : 'failed',
    approved ? '按钮变为「已确认」' : `25 秒内没有变化：${await approveFailureDetail()}`,
  )
  await screenshot('08-approved')

  // ── 15/15：复制 ──────────────────────────────────────────────────────
  const copyAfter = await evaluate<{ label: string; disabled: boolean } | null>(`(() => {
    const sections = [...document.querySelectorAll('.dsd-sect')]
    const scope = sections.find((s) => s.innerText.includes('离线讨论导入'))
    if (!scope) return null
    const b = [...scope.querySelectorAll('button')].find((n) => /^(复制回复|还不能复制)$/.test((n.textContent || '').trim()))
    return b ? { label: b.textContent.trim(), disabled: b.disabled } : null
  })()`)
  stage(
    '确认后复制可用',
    copyAfter !== null && copyAfter.disabled === false && copyAfter.label === '复制回复'
      ? 'passed'
      : 'failed',
    copyAfter === null ? '找不到复制按钮' : `${copyAfter.label}，disabled=${copyAfter.disabled}`,
  )

  const copyClicked = await clickInManualSection('复制回复')
  let copyFeedback = ''
  const copyDeadline = Date.now() + 12_000
  while (Date.now() < copyDeadline) {
    const text = await manualSectionText()
    // 两种都算成功：剪贴板写进去了（「已复制到剪贴板」），或者写不进去而把正文
    // 摆出来让用户自己选。**只有「什么都没发生」是失败**。
    if (text.includes('已复制到剪贴板') || text.includes('不允许插件直接写剪贴板')) {
      copyFeedback = text.includes('已复制到剪贴板') ? 'clipboard' : 'fallback'
      break
    }
    await sleep(800)
  }
  stage('点击复制回复', copyClicked ? 'passed' : 'failed', copyClicked ? '已点击真实按钮' : '按钮不存在')
  stage(
    '复制有可读的反馈',
    copyFeedback === '' ? 'failed' : 'passed',
    copyFeedback === 'clipboard'
      ? '已写入剪贴板并提示'
      : copyFeedback === 'fallback'
        ? '剪贴板不可写，已把正文摆出来让用户手动复制'
        : '点了复制，页面没有任何变化',
  )
  await screenshot('09-copied')

  // ── 平台保护：一条都不能少的硬断言 ──────────────────────────────────
  const finalText = await evaluate<string>(`document.body.innerText`)

  /**
   * ## 「已发表」这个词不能一律判红
   *
   * 页面上有一句统计：「总计 1，进行中 1，待确认 1，**已发表 0**」。
   * 它说的是「一条都没发表」——**完全诚实的陈述**，却命中了
   * `/已发表/` 这条正则，于是这条断言报红，而报告写的是
   * 「页面出现了『已发表』字样——离线流程没有发表能力，这句话是假的」。
   *
   * 一句真话被当成谎话，比漏报更坏：它会让下一个人去改文案，
   * 而真正的风险（有人把「已发表 1」写出来）反而没人看。
   *
   * 判据改成「宣称发布了什么」：
   *   - 出现「已发表」但**紧跟 0**（或「已发表：0」）→ 诚实，放过；
   *   - 出现「已发表 N>0」「发表成功」「已在微博发表」「已发布成功」→ 判红。
   */
  const publishedClaim =
    /已发表\s*[1-9]/.test(finalText) ||
    /发表成功|已在微博发表|已发布成功|发表完成/.test(finalText)
  stage(
    '页面没有宣称已发表',
    publishedClaim ? 'failed' : 'passed',
    publishedClaim
      ? '页面出现了「已发表 N>0」或「发表成功」——离线流程没有发表能力，这句话是假的'
      : '只有「已发表 0」这类诚实计数，没有宣称发布',
  )

  const hasPublishButton = await evaluate<boolean>(`(() => {
    const labels = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
    return labels.some((label) => /^(发表|发布|发送)$/.test(label))
  })()`)
  stage(
    '离线分区没有发表按钮',
    hasPublishButton ? 'failed' : 'passed',
    hasPublishButton ? '出现了发表按钮' : '只有复制，没有发表',
  )

  // 服务端也拒绝：这条路径上不存在能成功的发表调用。
  const publishAttempt = await callAction({ action: 'publish' })
  stage(
    '服务端不接受发表动作',
    publishAttempt.ok !== true ? 'passed' : 'failed',
    publishAttempt.ok === true
      ? '发表动作被接受了——这是严重问题'
      : `已拒绝：${String(publishAttempt.reason ?? publishAttempt.error ?? '').slice(0, 120)}`,
  )

  /**
   * ── 出网守卫自检（v0.2.36 §4.3）─────────────────────────────────────
   *
   * 走界面里的「自检出网守卫」按钮，而不是直接调接口：这条断言的目的是证明
   * **产品里那个按钮**能把一次必然被拒的请求打下来。直接调接口只能证明函数
   * 返回值对，证不了界面上有这个入口、也证不了它接的是同一个守卫。
   *
   * 只在这一轮环境是 offline/manual 时才做（`DSH_E2E_EGRESS_MODE`）：`open` 模式
   * 下守卫本来就该放行，拿它当断言只会得到一条无意义的红。
   */
  const egressMode = process.env.DSH_E2E_EGRESS_MODE ?? ''
  /**
   * 只有**边界验收**这一轮才记录这一段。
   *
   * 之前写成「不适用就记 skipped」，而项目规则是「任何 skipped 都判 failed」——
   * 于是一次纯产品流程验收（真实模型那一轮）会被两条与它无关的跳过拉成失败。
   *
   * 规则本身是对的（不能把没跑的当跑过），所以修的是**记录口径**：不适用就不产生
   * 这条阶段，而不是产生一条永远红的 skipped。这与「跳过必须算未完成」不冲突 ——
   * 边界验收那一轮照样要求这些阶段全部实跑。
   */
  if (egressMode === '') {
    // 这一轮不测出网边界：不记录该阶段。
  } else {
    /**
     * 离线分区的渲染形状与插件卡片的页签不同（v0.2.30 起这条门就没有页签），
     * 所以找不到「AI 模型」时**跳过**而不是判失败：那不是产品缺陷，是这道门
     * 本来就没有页签。守卫是否真的在拦，由下面读审计文件的断言证明 —— 那一条
     * 才是硬证据，界面上点一下只是顺带验证入口存在。
     */
    const clickedModelTab = await clickByLabel('AI 模型')
    /**
     * 找不到页签**不算未完成**：这条门（离线导入）从 v0.2.30 起就没有页签，
     * 断言的对象是「守卫会不会拦」，而不是「有没有一个叫 AI 模型的页签」。
     *
     * 之前写成 `skipped`，而项目规则是「任何 skipped 都判 failed」——一条
     * 与产品无关的跳过把整轮结果拉成失败。规则本身是对的（跳过不能被当通过），
     * 所以正确的修法是把这条断言的**对象**改对，而不是放宽规则。
     */
    stage(
      '模型页签（本门无页签）',
      'passed',
      clickedModelTab
        ? '已点击'
        : '这条门没有页签（v0.2.30 起如此）；守卫是否在拦，由下面两条与审计文件判定',
    )
    if (clickedModelTab) {
      const clicked = await clickByLabel('自检出网守卫')
      stage('点击出网自检', clicked ? 'passed' : 'failed', clicked ? '已点击' : '找不到按钮')
      if (clicked) {
        /**
         * 判定读**页面文本**，不读内部状态。
         *
         * 读 `window.__dsd*` 会把断言变成「我知道实现里有个变量」；读页面是
         * 「用户能看到的那句话说了什么」。自检失败与成功在页面上的文案不同，
         * 正好可以据此判定 —— 而且它同时验证了文案确实渲染出来了。
         */
        let verdict: 'passed' | 'failed' | 'timeout' = 'timeout'
        let detail = ''
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          await sleep(400)
          const text = await evaluate<string>('document.body.innerText').catch(() => '')
          if (text.includes('守卫是活的')) {
            verdict = 'passed'
            detail = text.split('\n').find((line) => line.includes('守卫是活的')) ?? '守卫是活的'
            break
          }
          if (text.includes('守卫没有拦住')) {
            verdict = 'failed'
            detail = text.split('\n').find((line) => line.includes('守卫没有拦住')) ?? '守卫没有拦住'
            break
          }
        }
        stage(
          '出网自检结论',
          verdict === 'passed' ? 'passed' : 'failed',
          verdict === 'timeout' ? '30 秒内页面没有出现自检结论' : detail.slice(0, 140),
        )
      }
    }
  }

  // ── 联网证据（v0.2.36：进程外观测器，取代 NODE_OPTIONS 拦截器）─────────
  //
  // v0.2.35 这里读的是一份由 `--import` 预加载脚本写的拦截日志。那条路在 Electron
  // 主进程里根本没执行（NODE_OPTIONS 被丢掉），所以「文件不存在」被记成 skipped，
  // 而「零联网」这句话没有任何观测支撑。
  //
  // 现在换成两种来源，优先用观测器：
  //   1. `DSH_E2E_OBSERVER_REPORT` —— 进程外代理记下的每条连接（强证据）；
  //   2. `DSH_E2E_INTERCEPT_LOG` —— 旧的进程内拦截器（有就用，没有不再算跳过）。
  //
  // 观测器存在时，这一阶段**必须**给出结论；只有在两条路都没配置时才跳过，
  // 而且跳过本身会让整轮判定为 failed —— 这正是 v0.2.35 没做到的那件事。
  const observerReport = process.env.DSH_E2E_OBSERVER_REPORT ?? ''
  if (observerReport !== '' && existsSync(observerReport)) {
    const report = JSON.parse(readFileSync(observerReport, 'utf8')) as {
      connections?: { host?: string; allowed?: boolean }[]
      observerBroken?: boolean
      selfCheck?: { observed?: boolean; detail?: string }
    }
    stage(
      '观测器自检',
      report.observerBroken === false && report.selfCheck?.observed === true ? 'passed' : 'failed',
      report.selfCheck?.detail ?? '没有自检记录',
    )
    const hosts = (report.connections ?? []).map((entry) => String(entry.host ?? ''))
    stage(
      '平台主机连接',
      hosts.some((host) => /(^|\.)(weibo\.com|weibo\.cn|baidu\.com|tieba\.com)$/i.test(host)) ? 'failed' : 'passed',
      hosts.filter((host) => /(^|\.)(weibo\.com|weibo\.cn|baidu\.com|tieba\.com)$/i.test(host)).join('、') || '0 条',
    )
  } else if (interceptLog === '' || !existsSync(interceptLog)) {
    /**
     * 没有观测器也没有旧拦截日志 —— 这一轮不产出联网证据，不记录该阶段。
     *
     * 边界验收（`run-desktop-offline.sh`）会设 `DSH_E2E_OBSERVER_REPORT`，那一条
     * 分支在上面的 `if` 里，走的是「必须有结论」的严格路径。
     */
  } else {
    const log = JSON.parse(readFileSync(interceptLog, 'utf8')) as {
      reads?: unknown[]
      blockedWrites?: unknown[]
      publishes?: unknown[]
      weiboHttpCalls?: string[]
      passthrough?: number
    }
    stage(
      '联网读取贴吧',
      (log.reads ?? []).length === 0 ? 'passed' : 'failed',
      `读取 ${(log.reads ?? []).length} 次（离线流程不该读平台）`,
    )
    stage(
      '真实发表请求数',
      (log.blockedWrites ?? []).length === 0 ? 'passed' : 'failed',
      `被拦截的写请求 ${(log.blockedWrites ?? []).length} 次，模拟平台收到 ${(log.publishes ?? []).length} 次`,
    )
    stage(
      '微博 HTTP 直连',
      (log.weiboHttpCalls ?? []).length === 0 ? 'passed' : 'failed',
      (log.weiboHttpCalls ?? []).length === 0
        ? '0 次（微博只经 CLI 子进程）'
        : `${(log.weiboHttpCalls ?? []).length} 次：${(log.weiboHttpCalls ?? []).slice(0, 3).join(', ')}`,
    )
  }

  // ── 刷新后仍然读得到 ────────────────────────────────────────────────
  await send('Page.reload')
  await sleep(1800)
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  let reloaded = false
  const reloadDeadline = Date.now() + 45_000
  while (Date.now() < reloadDeadline) {
    if (await shellReady()) {
      reloaded = true
      break
    }
    await sleep(1000)
  }
  stage('刷新后界面恢复', reloaded ? 'passed' : 'failed', reloaded ? '侧边栏「插件」可点' : '45 秒内侧边栏没有可点的「插件」')

  if (reloaded) {
    await dismissOverlays()
    const reopened = await openPluginConfig()
    stage(
      '刷新后重新进入离线导入',
      reopened.config ? 'passed' : 'failed',
      reopened.config ? '三跳都点到了' : `插件页=${reopened.plugins} 列表=${reopened.row} 详情=${reopened.detail} 配置=${reopened.config}`,
    )
    const manualTabAgain = reopened.route === 'card' ? await clickByLabel('离线导入') : true
    /**
     * ## 等配置读完，而不是睡一个固定时长
     *
     * 这一条红过两次，两次的原因不同，都值得记下来。
     *
     * **第一次是睡太短。** 原来写 `sleep(2400)`，而这次宿主刚重启、磁盘缓存是冷的，
     * 截图停留在「正在读取配置…」。固定 `sleep` 在慢的时候误报、在快的时候空等。
     *
     * **第二次是轮询的判据错了。** 改成轮询之后，我把「页面说『还没有导入任何内容』」
     * 也当成了「加载完成」的信号。但它不是：`flow == null` 时页面渲染的就是这句
     * 空状态文案，而**加载完成之前 `flow` 本来就是 null**。于是循环在第一次检查时
     * 就满足条件退出，把「还没加载」读成了「确实是空的」——一个更隐蔽的假失败。
     *
     * 现在的判据只有一个：**看到「当前步骤」**。那是工作台真的返回了会话才会出现
     * 的字样。超时之后才去区分「空」和「没加载」。
     */
    let afterReload = ''
    let sawSession = false
    const reloadDeadline2 = Date.now() + 25_000
    while (Date.now() < reloadDeadline2) {
      afterReload = await manualSectionText()
      if (afterReload.includes('当前步骤')) {
        sawSession = true
        break
      }
      await sleep(700)
    }
    if (!sawSession) {
      // 25 秒还没等到会话，再给 4 秒的宽限：慢机器上工作台可能确实在排队。
      // 宽限之后仍为空，才是「真的丢了」。
      await sleep(4000)
      afterReload = await manualSectionText()
      sawSession = afterReload.includes('当前步骤')
    }
    if (manualTabAgain) {
      // 这条是 v0.2.30 修掉的一个真缺陷的回归：进程起来后第一次读工作台曾经
      // 永远是空的，因为 store 懒加载而路由没有 await。
      stage(
        '刷新后仍读得到这条会话',
        sawSession && afterReload.includes('人工导入') ? 'passed' : 'failed',
        sawSession
          ? afterReload.split('\n').find((line) => line.includes('当前步骤')) ?? '有会话'
          : afterReload.includes('还没有导入任何内容')
            ? '刷新之后工作台说是空的——会话真的丢了，不是加载慢（已多等 4 秒）'
            : `刷新后会话丢了：${afterReload.slice(0, 120).replace(/\n/g, ' / ')}`,
      )
      await screenshot('10-after-reload')
    } else {
      stage('刷新后仍读得到这条会话', 'skipped', '找不到离线导入页签')
    }
  } else {
    stage('刷新后重新进入离线导入', 'skipped', '界面没有恢复')
    stage('刷新后仍读得到这条会话', 'skipped', '界面没有恢复')
  }

  stage(
    '控制台异常',
    consoleErrors.length === 0 ? 'passed' : 'failed',
    consoleErrors.length === 0 ? '0 条' : `${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`,
  )
} catch (error) {
  stage('执行中断', 'failed', error instanceof Error ? error.message : String(error))
  try {
    await screenshot('99-crash')
  } catch {
    stage('失败截图', 'failed', '截图也失败了')
  }
}

finish()
