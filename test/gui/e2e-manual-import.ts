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
}[]

/**
 * 取最后一个匹配的页面。
 *
 * 宿主每次打开链接都会新开一个标签页，`find` 拿到的是最早那个（可能已经
 * `chrome-error://`）。用最后一个才对上刚刚请求的那一页。
 */
const candidates = targets.filter((t) => t.type === 'page' && t.url.includes(String(appPort)))
const page = candidates[candidates.length - 1]
if (page === undefined) {
  stage('连接浏览器', 'failed', `没有找到 ${appPort} 的页面目标`)
  finish()
}

/**
 * 收集器先声明、后赋值：`finish()` 在「找不到页面」那条分支上会被调用，
 * 那时还拿不到 `page.url`。写成 `const` 会在那条分支撞进 TDZ，
 * 把一条可读的失败变成一次 `ReferenceError`。
 */
let evidence: EvidenceCollector | undefined

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

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { res: resolve, rej: reject })
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
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  if (typeof result.data !== 'string' || result.data === '') {
    throw new Error(`截图 ${name} 失败：返回空数据`)
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
    const node = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
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

/** 打开插件列表 → 详情 → 配置。返回是否三步都点到了。 */
async function openPluginConfig(): Promise<{ plugins: boolean; row: boolean; detail: boolean; config: boolean }> {
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
  return { plugins, row, detail, config }
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

  const tabs = await evaluate<string[]>(
    `[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`,
  )
  stage(
    '十一个页签渲染',
    tabs.length === 11 ? 'passed' : 'failed',
    `实际 ${tabs.length} 个：${tabs.join('/')}`,
  )
  stage(
    '离线导入页签存在',
    tabs.includes('离线导入') ? 'passed' : 'failed',
    tabs.includes('离线导入') ? '在页签列表里' : `没有这一页：${tabs.join('/')}`,
  )

  // ── 2/15：进入离线导入 ────────────────────────────────────────────────
  const manualTab = await clickByLabel('离线导入')
  await sleep(2000)
  stage('进入离线导入页签', manualTab ? 'passed' : 'failed', manualTab ? '已点击页签' : '找不到页签')
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

  // ── 10/15：生成候选 ──────────────────────────────────────────────────
  const genClicked = await clickByLabel('生成候选回复')
  let generated = false
  const genDeadline = Date.now() + 90_000
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
    generated ? '页面渲染了候选正文与安全评估' : `90 秒内没有候选：${(await manualSectionText()).slice(-160).replace(/\n/g, ' / ')}`,
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
  stage('确认生效', approved ? 'passed' : 'failed', approved ? '按钮变为「已确认」' : '25 秒内没有变化')
  await screenshot('08-approved')

  // ── 15/15：复制 ──────────────────────────────────────────────────────
  const copyAfter = await evaluate<{ label: string; disabled: boolean } | null>(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(复制回复|还不能复制)$/.test((n.textContent || '').trim()))
    return b ? { label: b.textContent.trim(), disabled: b.disabled } : null
  })()`)
  stage(
    '确认后复制可用',
    copyAfter !== null && copyAfter.disabled === false && copyAfter.label === '复制回复'
      ? 'passed'
      : 'failed',
    copyAfter === null ? '找不到复制按钮' : `${copyAfter.label}，disabled=${copyAfter.disabled}`,
  )

  const copyClicked = await clickByLabel('复制回复')
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

  stage(
    '页面不出现「已发表」',
    /已发表|发表成功|已在微博发表|已发布成功/.test(finalText) === false
      ? 'passed'
      : 'failed',
    /已发表|发表成功|已在微博发表|已发布成功/.test(finalText)
      ? '页面出现了「已发表」字样——离线流程没有发表能力，这句话是假的'
      : '没有任何「已发表」字样',
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

  // ── 拦截日志：真实网络请求为零 ──────────────────────────────────────
  if (interceptLog === '' || !existsSync(interceptLog)) {
    stage('拦截日志', 'skipped', `没有找到 ${interceptLog || '(未配置)'}`)
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
    const manualTabAgain = await clickByLabel('离线导入')
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
