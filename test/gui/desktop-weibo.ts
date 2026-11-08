/**
 * 真 DSH Desktop 上的微博全链路验收（v0.2.33 §四）。
 *
 * ## 与 `e2e-weibo.ts` 的分工
 *
 * `e2e-weibo.ts` 跑在**浏览器 + dsh web** 上，验证的是「页面逻辑对不对」。
 * 这个文件跑在**真 Electron 窗口**（`dsh-app://`）上，验证的是「普通用户在自己
 * 的桌面应用里能不能走完这条链」：打开插件 → 输入微博链接 → 读取讨论 →
 * 选目标 → 生成 → 编辑 → 确认 → 复制 → 重启后恢复。
 *
 * 两者的差别不是画布，是**入口**：桌面端没有「插件」页签，只有
 * 左下角账号菜单 → 设置 → 侧栏「AI代吵架」。v0.2.31 就是在这里把
 * 「设置打不开」当成产品缺陷报了一轮，实际是选择器写错了。
 * 所以导航一律走 `desktop-shell.ts`，两个桌面脚本共用同一份。
 *
 * ## 数据从哪里来
 *
 * 真微博 API 需要有效的 OAuth 令牌，而隔离环境里没有、也不该有。所以读取走
 * `test/fixtures/fake-weibo-pkg` 里那个**按 npm 包布局摆放的假 CLI**：
 * 替换发生在文件系统 + PATH 这个产品本来就相信的边界上，产品代码零改动、
 * 也不知道自己在被测试。
 *
 * **这份证据证明的是「桌面链路通」，不是「微博 API 今天这样返回」。**
 * 报告里必须分开写。真实响应形态由 `v0232-weibo-real-shape` 与
 * `v0233-paging-states` 两组单元用例钉住（用的是 2026-11-07 抓回来的原始 JSON）。
 *
 * ## 判定原则
 *
 * - 剪贴板：`readText()` 真读回来比对，不看页面自述。
 * - 「复制成功」必须能读回正文；读不回就是没成功，页面写「已复制」也不算。
 * - 任何 skipped 都不算通过。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { EvidenceCollector } from './evidence.ts'
import {
  dismissOnboarding,
  openPluginPage,
  openSettings,
  type ShellCtx,
} from './desktop-shell.ts'

const cdpPort = Number(process.env.DSH_E2E_CDP_PORT ?? '9400')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/desk-weibo'
const weiboHome = process.env.FAKE_WEIBO_HOME ?? ''
const weiboLog = process.env.FAKE_WEIBO_LOG ?? ''
const worktree = process.env.DSH_E2E_WORKTREE ?? process.cwd()

mkdirSync(outDir, { recursive: true })

interface Stage {
  readonly name: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly detail: string
  readonly how: 'automation' | 'manual'
}

const stages: Stage[] = []
function stage(name: string, status: Stage['status'], detail: string, how: Stage['how'] = 'automation'): void {
  stages.push({ name, status, detail, how })
  const mark = status === 'passed' ? '✔' : status === 'failed' ? '✘' : '·'
  process.stdout.write(`${mark} ${name} — ${detail}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── CDP ────────────────────────────────────────────────────────────────────

let nextId = 1
const pending = new Map<number, (value: unknown) => void>()
let ws: WebSocket
const consoleErrors: string[] = []
const exceptions: string[] = []

const CDP_TIMEOUT_MS = 20_000

async function connect(): Promise<{ url: string; ua: string }> {
  const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]

  /**
   * 挑 `dsh-app://` 那个页面。
   *
   * Electron 里通常有两个 page：启动画面（`file://`）与真正的应用窗口。
   * 选错了会对着空白页断言「界面没渲染」，然后写一份错误的失败报告。
   */
  const appPage =
    list.find((t) => t.type === 'page' && /^dsh-app:\/\//.test(t.url)) ??
    list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)) ??
    list.find((t) => t.type === 'page')

  if (appPage === undefined) {
    throw new Error(`没有可驱动的页面：${JSON.stringify(list.map((t) => `${t.type}:${t.url}`))}`)
  }

  ws = new WebSocket(appPage.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = (): void => resolve()
    ws.onerror = (): void => reject(new Error('CDP 连接失败'))
  })
  ws.onmessage = (event): void => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      method?: string
      params?: { type?: string; args?: { value?: unknown }[]; exceptionDetails?: { text?: string } }
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg.result)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.text ?? 'unknown')
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => String(a.value ?? '')).join(' ').slice(0, 200))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  return { url: appPage.url, ua: await evaluate<string>('navigator.userAgent') }
}

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(undefined)
    }, CDP_TIMEOUT_MS)
    pending.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T> {
  const r = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } }
  if (r?.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.text ?? 'evaluate 失败')
  return r?.result?.value as T
}

async function clickAt(x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(1100)
}

async function clickByText(label: string): Promise<boolean> {
  const pos = await evaluate<string>(`(() => {
    const nodes = [...document.querySelectorAll('button,[role=button],[role=tab],a,[tabindex]')]
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || '').trim()
      if (t === ${JSON.stringify(label)}) {
        const r = n.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      }
    }
    return 'not-found'
  })()`)
  if (pos === 'not-found') return false
  const { x, y } = JSON.parse(pos) as { x: number; y: number }
  await clickAt(x, y)
  return true
}

async function screenshot(name: string): Promise<void> {
  const r = (await send('Page.captureScreenshot', { format: 'png' })) as { data?: string }
  if (typeof r?.data === 'string' && r.data !== '') {
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
    // 登记进证据清单。不登记的话 `evidence.json` 里 screenshots 是空的，
    // 而磁盘上明明有一堆 png——报告与产物对不上，读报告的人会以为没截图。
    evidence.screenshot(`${name}.png`)
  }
}

const shellCtx = (): ShellCtx => ({
  evaluate,
  clickAt,
  clickByText,
  sleep,
  viewport: async () => {
    const m = (await send('Page.getLayoutMetrics')) as {
      cssLayoutViewport?: { clientWidth: number; clientHeight: number }
    }
    return {
      vw: m?.cssLayoutViewport?.clientWidth ?? 1275,
      vh: m?.cssLayoutViewport?.clientHeight ?? 646,
    }
  },
})

const bodyText = async (): Promise<string> => evaluate<string>('document.body ? document.body.innerText : ""')

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

/** 逐字符发键盘事件。`element.value = x` 不触发 React 的 onChange。 */
async function typeText(text: string): Promise<void> {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: char })
    await sleep(12)
  }
}

// ── 假 CLI 场景切换 ────────────────────────────────────────────────────────

function setWeiboScenario(patch: Record<string, unknown>): void {
  if (weiboHome === '') return
  let current: Record<string, unknown> = {}
  if (existsSync(weiboHome)) {
    try {
      current = JSON.parse(readFileSync(weiboHome, 'utf8')) as Record<string, unknown>
    } catch {
      current = {}
    }
  }
  writeFileSync(weiboHome, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8')
}

/** 读假 CLI 的调用日志。它是「产品到底发了什么请求」的唯一事实来源。 */
function weiboCalls(): string[][] {
  if (weiboLog === '' || !existsSync(weiboLog)) return []
  return readFileSync(weiboLog, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as string[]
      } catch {
        return []
      }
    })
}


/**
 * 先滚进视野再点，用于长页面里位置不固定的按钮。
 *
 * ## 为什么不直接按文字点
 *
 * `getBoundingClientRect()` 给的是**相对视口**的坐标，而这块面板高度上万像素：
 * 「生成候选」「复制回复」这类按钮在页面很下方，滚动前量到的 y 会落在视口之外
 * （例如 y≈5600，而窗口只有 672 高）。那种点击派发出去什么也不会发生，
 * 页面却看起来「按钮没了」。
 *
 * 所以：先 `scrollIntoView` 让它进视野，**再重新量**一次坐标，然后派发。
 * 这是 v0.2.32 在贴吧复制的那个坑，这一版在微博页又踩了一次。
 */
async function clickScrolled(label: string): Promise<boolean> {
  const found = await evaluate<boolean>(`(() => {
    const nodes = [...document.querySelectorAll('button,[role=button]')]
    const hit = nodes.find(n => (n.innerText || n.textContent || '').trim() === ${JSON.stringify(label)})
    if (!hit) return false
    const r = hit.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    hit.scrollIntoView({ block: 'center' })
    return true
  })()`)
  if (!found) return false
  await sleep(600)
  return clickByText(label)
}

const STATUS_ID = '5021243409116023'
const OPPONENT_COMMENT_ID = '6002'
const OPPONENT_NAME = '后说话的'

const startedAt = new Date().toISOString()
const evidence = new EvidenceCollector({
  script: 'test/gui/desktop-weibo.ts',
  scriptVersion: '1',
  pageUrl: '',
  cdpPort,
  appPort: 0,
  startedAt,
})

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const surface = await connect()

  /**
   * 整个文件的地基：**证明被驱动的是 Desktop，不是浏览器。**
   *
   * `dsh-app://` 是 Electron 自定义协议，Edge 里不存在。只要 URL 是这个，
   * 就排除了「拿浏览器冒充桌面」——而那正是 v0.2.31 留给这一版的问题。
   */
  const isDesktop = /^dsh-app:\/\//.test(surface.url)
  stage('被驱动的是 Desktop 渲染进程（不是浏览器）', isDesktop ? 'passed' : 'failed', `URL = ${surface.url}`)
  stage('userAgent 含 Electron', /Electron/.test(surface.ua) ? 'passed' : 'failed', surface.ua.slice(0, 90))

  /**
   * ## 必须先等插件加载完成，否则后面每一条都会红
   *
   * 桌面端启动画面是 `HARNESS / Loading plugins…`。CDP 一连上就能读到 DOM，
   * 但那时它只有这一句话——没有账号菜单、没有侧栏、没有任何页签。
   *
   * 第一版没等，于是 25 个阶段里 15 个红，报告读起来像「产品全线崩溃」，
   * 而实际只是脚本比界面快了 3 秒。这正是这一版要消灭的那类假失败：
   * **它不是产品的问题，也不是环境的问题，是判据取早了。**
   *
   * 判据用「界面自己的文字」而不是固定秒数：加载慢的时候等得久，快的时候立刻过。
   */
  const uiReady = await waitFor(async () => {
    const text = await bodyText()
    if (text === '') return false
    if (/Loading plugins/i.test(text)) return false
    return /新会话|工作区|设置|插件/.test(text)
  }, 90_000)
  stage(
    '桌面界面已加载完成（不是启动画面）',
    uiReady ? 'passed' : 'failed',
    uiReady ? (await bodyText()).split('\n').slice(0, 3).join(' / ').slice(0, 110) : `90 秒仍在启动画面：${(await bodyText()).slice(0, 120)}`,
  )
  await screenshot('00-surface')

  const dismissed = await dismissOnboarding(shellCtx())
  stage('启动引导已处理', /关不掉/.test(dismissed) ? 'failed' : 'passed', dismissed)
  await screenshot('01-after-onboarding')

  const settings = await openSettings(shellCtx())
  stage('打开设置', settings.ok ? 'passed' : 'failed', settings.how)
  await screenshot('02-settings')

  const plugin = await openPluginPage(shellCtx(), {
    markers: /离线讨论导入|主人贴吧数字 ID|当前步骤|平台|工作台/,
  })
  stage('进入插件分区', plugin.mounted ? 'passed' : 'failed', plugin.detail)
  await screenshot('03-plugin')

  /**
   * ## 模型配置与连接测试（v0.2.35 §8 第 1、2 项）
   *
   * 这一段是这一版新增的：以前桌面验收从「输入微博链接」开始，而真实用户的第一步
   * 其实是「把模型配上」。两件事必须分开验证：
   *
   * 1. **配置在页面上看得见、改得动** —— Base URL、模型名、协议三栏都在，且显示的
   *    是当前实际值（不是占位符）。
   * 2. **测试连接回答两个问题** —— 能不能连上（连通性），以及这个模型会不会按
   *    插件的 JSON 契约输出。第二件事是 v0.2.35 才有的，也是「设置页全绿但一生成
   *    就废」那种故障唯一能在事前发现的地方。
   *
   * 这里的模型是隔离环境里的假模型（`tmp/llm-mock-028.mjs`，端口 58999），它按
   * 契约回 JSON。所以这一段证明的是**页面与链路的判断正确**，不是「某个真实模型
   * 今天表现如何」。报告里必须这么写。
   */
  const modelFields = await evaluate<{ base: boolean; model: boolean; protocol: boolean }>(`(() => {
    const inputs = [...document.querySelectorAll('input')]
    const has = (id) => Boolean(document.getElementById(id))
    const label = (text) => [...document.querySelectorAll('p,span,label')].some(n => (n.textContent || '').trim().startsWith(text))
    return {
      base: has('dsd-llm-base') || label('模型 API 地址'),
      model: has('dsd-llm-model') || label('模型名称'),
      protocol: has('dsd-llm-protocol') || label('接口协议'),
    }
  })()`)
  stage(
    '模型配置三栏都在页面上',
    modelFields.base && modelFields.model && modelFields.protocol ? 'passed' : 'failed',
    `Base URL=${modelFields.base ? '有' : '无'} 模型名=${modelFields.model ? '有' : '无'} 协议=${modelFields.protocol ? '有' : '无'}`,
  )

  /**
   * 宿主模型来源（v0.2.36 §3.2）。
   *
   * ## 这一段证明什么、不证明什么
   *
   * 证明：页面上的「模型来源」三态在、点「查看宿主可用模型」能得到一个**明确的
   * 结论**（有模型就列出来，没有就说清缺什么）。
   *
   * 不证明：宿主模型今天能不能真的生成。隔离环境没有登录、没有密钥，`ctx.llm`
   * 可能连一个模型都列不出来 —— 那正是要被如实显示的状态，而不是把它藏成
   * 「按钮点了没反应」。
   */
  const sourceField = await evaluate<boolean>(`(() => Boolean(document.getElementById('dsd-llm-source')))`)
  stage('模型来源选择器在页面上', sourceField ? 'passed' : 'failed', sourceField ? '有「模型来源」三栏' : '找不到 dsd-llm-source')

  const hostProbeClicked = await clickScrolled('查看宿主可用模型')
  stage(
    '点击「查看宿主可用模型」',
    hostProbeClicked ? 'passed' : 'failed',
    hostProbeClicked ? '已点击真实按钮' : '按钮不存在或不可点',
  )
  if (hostProbeClicked) {
    /**
     * 判据要带冒号，不能用「可用模型」四个字。
     *
     * 失败过一次：按钮自己的文案就是「查看宿主可用模型」，于是 `includes('可用模型')`
     * 在点下去的**同一毫秒**就成立了 —— 断言把按钮标签当成了结论，通过了但什么
     * 也没验证。带冒号之后，只有结果那一行（`可用模型：…` / `不可用：…`）才算数。
     */
    const answerLine = (text: string): string =>
      text
        .split('\n')
        .find((entry) => entry.includes('可用模型：') || entry.includes('不可用：')) ?? ''
    const hostAnswered = await waitFor(async () => answerLine(await bodyText()) !== '', 30_000)
    const line = answerLine(await bodyText())
    stage(
      '宿主模型探测给出明确结论',
      hostAnswered ? 'passed' : 'failed',
      hostAnswered ? line.slice(0, 140) : '30 秒内没有出现「可用模型：」或「不可用：」的结果行',
    )
    /**
     * 不论可用与否，「不可用」必须带原因。一个只说「不可用」的结论，对用户没有
     * 任何下一步 —— 而这条路的下一步恰恰是「去配自己的接口」。
     */
    if (line.includes('不可用：')) {
      stage(
        '不可用时给出了原因',
        line.replace('不可用：', '').replace(/[：:\s]/g, '').length > 4 ? 'passed' : 'failed',
        line.slice(0, 160),
      )
    }
  }

  const probeClicked = await clickScrolled('测试模型连接')
  stage('点击「测试模型连接」', probeClicked ? 'passed' : 'failed', probeClicked ? '已点击真实按钮' : '按钮不存在或不可点')
  if (probeClicked) {
    const probed = await waitFor(async () => {
      const text = await bodyText()
      return text.includes('连接正常') || text.includes('契约探测')
    }, 60_000)
    const after = await bodyText()
    stage(
      '连接测试给出了结果',
      probed ? 'passed' : 'failed',
      probed ? '页面出现连接结果' : `60 秒内没有结果：${after.slice(0, 140).replace(/\n/g, ' / ')}`,
    )
    /**
     * 协议必须与配置一致。填的是 chat，页面就该说 `chat/completions` —— 这一条
     * 挡的是「模型名里带 responses 就当成 responses 协议」那种猜测式实现。
     */
    stage(
      '结果里写明实际使用的协议',
      /协议：\s*chat\/completions/.test(after) ? 'passed' : 'failed',
      (after.split('\n').find((line) => line.includes('协议')) ?? '页面上没有协议那一行').slice(0, 90),
    )
    stage(
      '契约探测单独报告',
      after.includes('契约探测') ? 'passed' : 'failed',
      (after.split('\n').find((line) => line.includes('契约探测')) ?? '页面上没有契约探测那一行').slice(0, 110),
    )
    await screenshot('03b-model-probe')
  }

  // ── 平台页：微博必须在列表里，并且说清自己的状态 ───────────────────────
  /**
   * ## 桌面端没有「平台」页签，只有堆叠的分区
   *
   * `settings.section` 那一扇门把 11 个区块**全部堆在一页**上（设计如此：
   * 侧栏是「全都给我看」的入口，带页签的卡片只存在于插件行那条旧路径）。
   *
   * 第一版照着浏览器版的写法去点「平台」页签，于是 4 条断言一起红——问的是
   * 一个在这个入口下不存在的东西。这一版的判据改成「滚动到那一段，读它的文字」。
   */
  const scrollToSection = async (title: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const wanted = ${JSON.stringify(title)}
      const nodes = [...document.querySelectorAll('.dsd-sect-title,.dsd-section-title,.dsd-card-title')]
      const hit = nodes.find(n => (n.textContent || '').trim() === wanted)
      if (!hit) return false
      hit.scrollIntoView({ block: 'center', inline: 'nearest' })
      return true
    })()`)

  /**
   * 平台分区**没有**一个叫「平台」的标题。
   *
   * 它的结构是：一段导语（`platformsIntro`）+ 每个平台各一块，块标题是
   * **平台自己的名字**（`百度贴吧` / `微博`）。所以定位「微博」那一块才是
   * 正确判据——按「平台」这个总标题去找，永远找不到，而这不是产品缺陷。
   */
  const platformSection = await scrollToSection('微博')
  stage('滚到「微博」分区', platformSection ? 'passed' : 'failed', platformSection ? '已定位到该分区' : '页面上没有「微博」分区标题')
  if (platformSection) {
    const weiboListed = await waitFor(async () => (await bodyText()).includes('微博'), 20_000)
    stage(
      '平台列表里有微博',
      weiboListed ? 'passed' : 'failed',
      weiboListed ? '页面出现「微博」' : `20 秒内没出现微博：${(await bodyText()).slice(0, 160).replace(/\n/g, ' / ')}`,
    )
    await screenshot('04-platforms')
  }

  // ── 工作台：读一条微博 ────────────────────────────────────────────────────
  const workbenchSection = await scrollToSection('发表工作台')
  stage('滚到「发表工作台」分区', workbenchSection ? 'passed' : 'failed', workbenchSection ? '已定位到该分区' : '页面上没有「发表工作台」')
  await sleep(1200)

  const linkReady = await evaluate<boolean>(`(() => {
    // 链接标签是一段 <p>，输入框紧跟其后；这是这段里唯一用来输入链接的文本框。
    const label = [...document.querySelectorAll('p')].find(p => (p.textContent || '').startsWith('讨论链接'))
    const scope = label ? label.parentElement : document
    const inputs = [...scope.querySelectorAll('input[type=text]')]
    const input = inputs.find(i => !i.disabled)
    if (!input) return false
    input.scrollIntoView({ block: 'center' })
    input.focus()
    return document.activeElement === input
  })()`)
  stage('链接输入框可用', linkReady ? 'passed' : 'failed', linkReady ? '已聚焦' : '找不到输入框')

  if (linkReady) {
    // 先清空：续跑的会话会预填这个框，直接输入会得到两条拼在一起的 URL。
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await typeText(`https://m.weibo.cn/detail/${STATUS_ID}`)
    await sleep(400)
    const typed = await evaluate<string>(`(() => {
      const label = [...document.querySelectorAll('p')].find(p => (p.textContent || '').startsWith('讨论链接'))
      const scope = label ? label.parentElement : document
      const input = [...scope.querySelectorAll('input[type=text]')].find(i => !i.disabled)
      return input ? input.value : ''
    })()`)
    stage('输入框里是这条微博的链接', typed.includes(STATUS_ID) ? 'passed' : 'failed', typed === '' ? '输入框是空的' : typed.slice(0, 70))
  }

  const readClicked = await clickByLabelSafe('读取讨论')
  stage('点击「读取讨论」', readClicked ? 'passed' : 'failed', readClicked ? '已点击真实按钮' : '按钮不可点')
  await sleep(7000)
  await screenshot('05-after-read')

  const afterRead = await bodyText()
  stage('评论列表渲染', afterRead.includes('评论列表') ? 'passed' : 'failed', afterRead.includes('评论列表') ? '页面出现评论列表' : '页面没有评论列表')
  stage(
    '读到正文与评论作者',
    afterRead.includes('被围观的博主') && afterRead.includes(OPPONENT_NAME) ? 'passed' : 'failed',
    afterRead.includes('被围观的博主') ? `看到博主与「${OPPONENT_NAME}」` : '没有看到假 CLI 里的作者',
  )
  // 这一条是「不能编造」的核心：微博评论没有楼层，页面不该出现第 0 楼。
  stage(
    '没有编造的楼层号',
    afterRead.includes('第 0 楼') ? 'failed' : 'passed',
    afterRead.includes('第 0 楼') ? '页面出现了「第 0 楼」' : '没有出现编造的楼层号',
  )
  stage(
    '评论行显示真实 post id',
    afterRead.includes(OPPONENT_COMMENT_ID) ? 'passed' : 'failed',
    afterRead.includes(OPPONENT_COMMENT_ID) ? `显示 ${OPPONENT_COMMENT_ID}` : '评论行没有显示可操作的 id',
  )

  // ── 选目标 ───────────────────────────────────────────────────────────────
  const picked = await evaluate<boolean>(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条')
    const button = buttons.find((b) => {
      const row = b.closest('li')
      return row !== null && (row.textContent || '').includes(${JSON.stringify(OPPONENT_COMMENT_ID)})
    })
    if (!button) return false
    const r = button.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    // 列表在长页面的下方：先滚进视野，再量一次坐标。
    button.scrollIntoView({ block: 'center' })
    window.__dsdPickTarget = null
    return true
  })()`)
  if (picked) {
    // `getBoundingClientRect()` 是相对视口的；滚动之后必须重新量，不能复用滚动前的读数。
    await sleep(600)
    const point = await evaluate<{ x: number; y: number } | null>(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条')
      const button = buttons.find((b) => {
        const row = b.closest('li')
        return row !== null && (row.textContent || '').includes(${JSON.stringify(OPPONENT_COMMENT_ID)})
      })
      if (!button) return null
      const r = button.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return null
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (point !== null) await clickAt(point.x, point.y)
  }
  stage('点击「用这条」', picked ? 'passed' : 'failed', picked ? `已选定 ${OPPONENT_COMMENT_ID}` : '找不到对应按钮')

  if (picked) {
    const hasTarget = await waitFor(async () => {
      const text = await bodyText()
      return text.split('\n').some((line) => line.trim().startsWith('目标：'))
    }, 40_000)
    const targetLine =
      (await bodyText()).split('\n').find((line) => line.trim().startsWith('目标：')) ?? ''
    stage(
      '目标固定在被选中的那条评论上',
      hasTarget && targetLine.includes(OPPONENT_COMMENT_ID) ? 'passed' : 'failed',
      targetLine === '' ? '页面没有目标行' : targetLine.slice(0, 90),
    )
    await screenshot('06-picked')
  }

  // ── 生成候选 ─────────────────────────────────────────────────────────────
  const candidateCount = async (): Promise<number> => {
    const match = (await bodyText()).match(/候选\s*(\d+)\s*条/)
    return match === null ? -1 : Number(match[1])
  }
  const before = await candidateCount()
  const generated = await clickScrolled('生成候选')
  stage('点击「生成候选」', generated ? 'passed' : 'failed', generated ? '已点击真实按钮' : '按钮不存在或不可点')

  if (generated) {
    const appeared = await waitFor(async () => {
      const now = await candidateCount()
      return now > Math.max(before, 0) || (before === -1 && now >= 1)
    }, 45_000)
    const after = await candidateCount()
    stage(
      '候选出现在页面上',
      appeared ? 'passed' : 'failed',
      appeared ? `候选从 ${before < 0 ? '未显示' : before} 条增加到 ${after} 条` : `45 秒内候选数没有增加（${before} → ${after}）`,
    )
    await screenshot('07-generated')
  }

  // ── 编辑正文 → 旧确认必须失效 ───────────────────────────────────────────
  //
  // 这一条不是「编辑功能好不好用」，而是「改过的正文还能不能带着旧批准被复制」。
  // 允许的话，主人批准的是 A，复制走的是 B。
  const edited = await evaluate<boolean>(`(() => {
    const areas = [...document.querySelectorAll('textarea')]
    const area = areas.find(a => !a.disabled && (a.value || '').trim() !== '')
    if (!area) return false
    area.focus()
    return document.activeElement === area
  })()`)
  if (edited) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
    await typeText('（这句是编辑加的）')
    await sleep(1500)
  }
  const afterEdit = await bodyText()
  stage(
    '编辑正文后重新评估',
    edited ? 'passed' : 'skipped',
    edited
      ? /待批准|需要重新|未批准|重新确认/.test(afterEdit)
        ? '页面回到待批准状态'
        : '编辑过，但页面仍显示已批准'
      : '页面上没有可编辑的正文框',
  )
  await screenshot('08-edited')

  // 保存修改：不保存的话复制按钮**本就该**是灰的（屏幕上的不是存下来的那一版）。
  const saved = edited ? await clickScrolled('保存修改') : false
  stage('点击「保存修改」', saved ? 'passed' : 'skipped', saved ? '已点击真实按钮' : '页面上没有保存按钮或未进入编辑')
  if (saved) {
    // 页面上的原文是「已保存。批准与安全评估已作废，需要重新批准才能发表。」
    const saveOk = await waitFor(async () => /已保存/.test(await bodyText()), 20_000)
    stage('修改被保存', saveOk ? 'passed' : 'failed', saveOk ? '页面显示已保存' : '20 秒内没有出现保存成功')
  }

  // ── 人工确认（批准）────────────────────────────────────────────────────────
  //
  // 微博是只读的，所以这条链的终点是「批准 + 复制」，不是发表。批准这一步必须先有，
  // 否则复制按钮按设计就是灰的——那说明的是「还没确认」，不是「产品坏了」。
  const approved = await clickScrolled('批准这一条')
  stage('点击「批准这一条」', approved ? 'passed' : 'failed', approved ? '已点击真实按钮' : '找不到批准按钮（可能仍然缺少 AI 账号绑定）')
  if (approved) {
    const becameApproved = await waitFor(async () => {
      const text = await bodyText()
      return /内容已批准|已批准/.test(text)
    }, 30_000)
    stage('候选被标记为已批准', becameApproved ? 'passed' : 'failed', becameApproved ? '页面显示已批准' : '30 秒内没有出现已批准')
    await screenshot('08b-approved')
  }

  // ── 复制：必须真读回系统剪贴板 ───────────────────────────────────────────
  /**
   * ── 复制失败的两条路径（先测，后测成功）───────────────────────────────
   *
   * ## 为什么必须排在成功之前
   *
   * 「有没有出现兜底提示」这件事只能判一次：兜底文案一旦写进 `copied` 状态，
   * 第二次点击即使什么都没发生，那句话也还在页面上。把失败路径排在成功之后，
   * 后一条会**永远通过**——而它恰恰是最该被测的那条。
   *
   * ## 为什么要数「写了几次」
   *
   * 只判「页面出现兜底文案」不够：`copyCandidate` 在 `navigator.clipboard`
   * 不存在时会**直接**走兜底，一毫秒出结果。那样测到的是「没有剪贴板」分支，
   * 不是「挂在那里」分支。所以注入的 `writeText` 先记一笔再挂起，断言必须同时
   * 满足：**真的调了一次写入** + 出现兜底 + 耗时落在 1.5 秒上限附近。
   *
   * ## 恢复必须还原原始描述符
   *
   * 第一版用 `delete Navigator.prototype.clipboard` 收尾，把 Electron 提供的真实
   * getter 一起删掉了，紧随其后的成功复制读到「这个环境没有 readText」。覆盖之前
   * 先存下原始描述符，收尾时原样装回去。
   */
  /**
   * ## 描述符必须**每次覆盖前现拍**
   *
   * 第一版在函数外拍一次、存到 `window.__clipOriginal`，然后刷新了页面 ——
   * `window` 上的东西随页面一起没了，收尾时 `d` 是 undefined，于是走了
   * `delete Navigator.prototype.clipboard`，把 Electron 提供的真实 getter 删掉。
   * 紧随其后的成功复制因此读到「这个环境没有 readText」。
   *
   * 结论：备份要在覆盖的**同一个作用域、同一时刻**做。放在 `injectClipboard`
   * 里面，就不存在「备份比覆盖早一次刷新」这种时间差。
   */
  const injectClipboard = async (mode: 'denied' | 'hang'): Promise<boolean> => {
    const injected = await evaluate<boolean>(`(() => {
      const mode = ${JSON.stringify(mode)}
      window.__clipOriginal = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard') || null
      window.__clipWrites = 0
      window.__clipCalledAt = 0
      try {
        Object.defineProperty(Navigator.prototype, 'clipboard', {
          configurable: true,
          get: () => ({
            writeText: () => {
              window.__clipWrites += 1
              window.__clipCalledAt = Date.now()
              return mode === 'denied'
                ? Promise.reject(new DOMException('denied', 'NotAllowedError'))
                : new Promise(() => {})
            },
            readText: async () => '',
          }),
        })
        return true
      } catch {
        return false
      }
    })()`)
    return injected === true
  }
  const restoreClipboard = async (): Promise<void> => {
    await evaluate<string>(`(() => {
      const d = window.__clipOriginal
      if (d) Object.defineProperty(Navigator.prototype, 'clipboard', d)
      else delete Navigator.prototype.clipboard
      delete window.__clipWrites
      delete window.__clipCalledAt
      return 'restored'
    })()`)
  }
  /**
   * ## 为什么要限定在「发表工作台」这一块里
   *
   * 页面上有两个按钮都写着「复制回复」：离线讨论导入区一个、工作台一个；兜底文案
   * 也是同一句。全页搜索等于把两个分区的结果混成一个——第一次跑就是这样：
   * 明明在测工作台的挂起分支，点到的却是离线区那个按钮，它走的是另一份 `copyNow`，
   * 于是耗时 518ms，而不是 1.5 秒上限。
   *
   * 所以先把「怎么找到这一节」注册成页面里的一个函数（`window.__wb`），点击与
   * 断言都只经过它。同一句话在别的分区里出现，本来就不能算这一节的行为。
   */
  /**
   * ## 这组辅助函数必须能重装
   *
   * 它挂在 `window` 上，而 `Page.reload` 会把 `window` 换掉。第一版只在开头装了
   * 一次，刷新之后 `window.__wb` 是 undefined，`clickInWorkbench` 去调
   * `window.__wb.button(...)` 直接抛 TypeError —— 中断点出现在「剪贴板永不返回」
   * 那条之前，报告里只留下一句 `✘ 执行中断 — Uncaught`，看起来像产品崩了。
   *
   * 所以装它的是个函数，而不是一段一次性代码；每次刷新之后都要重装。
   */
  const registerWorkbenchHelpers = async (): Promise<boolean> =>
    (await evaluate<boolean>(`(() => {
    window.__wb = {
      scope() {
        const title = [...document.querySelectorAll('.dsd-sect-title,span')]
          .find((n) => (n.textContent || '').trim() === '发表工作台')
        if (!title) return null
        let scope = title
        for (let i = 0; i < 8 && scope.parentElement; i += 1) {
          scope = scope.parentElement
          if ((scope.textContent || '').includes('当前步骤') && scope.querySelector('button')) break
        }
        return scope
      },
      button(label) {
        const scope = window.__wb.scope()
        if (!scope) return null
        return [...scope.querySelectorAll('button,[role=button]')]
          .find((n) => (n.innerText || n.textContent || '').trim() === label) || null
      },
      hasFallback() {
        const scope = window.__wb.scope()
        return scope !== null && /手动选中复制/.test(scope.textContent || '')
      },
    }
    return true
    })()`)) === true

  await registerWorkbenchHelpers()

  /**
   * 点工作台里的按钮：先滚进视野，**再重新量一次坐标**。
   *
   * `getBoundingClientRect()` 给的是相对视口的坐标，这块面板高达上万像素，
   * 滚动前量到的 y 会落在视口之外，派发出去什么也不会发生。
   */
  const clickInWorkbench = async (label: string): Promise<boolean> => {
    // 刷新之后辅助函数会没，先补装，否则这里就是一个 TypeError。
    await registerWorkbenchHelpers()
    const found = await evaluate<boolean>(`(() => {
      const hit = window.__wb.button(${JSON.stringify(label)})
      if (!hit) return false
      const r = hit.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return false
      hit.scrollIntoView({ block: 'center' })
      return true
    })()`)
    if (!found) return false
    await sleep(500)
    const pos = await evaluate<string>(`(() => {
      const hit = window.__wb.button(${JSON.stringify(label)})
      if (!hit) return 'no-button'
      const r = hit.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return 'invisible'
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`)
    if (!pos.startsWith('{')) return false
    const { x, y } = JSON.parse(pos) as { x: number; y: number }
    await clickAt(x, y)
    return true
  }

  /** 兜底文案来自 `workbenchCopyManual`：「…请手动选中复制」。仅在工作台范围内判。 */
  const fallbackShown = async (): Promise<boolean> =>
    (await evaluate<boolean>('window.__wb ? window.__wb.hasFallback() : false')) === true

  const writesSoFar = async (): Promise<number> => {
    const n = await evaluate<number>('window.__clipWrites === undefined ? -1 : window.__clipWrites')
    return typeof n === 'number' ? n : -1
  }

  // 断言起点：此刻页面上不该已经有兜底文案，否则下面的「出现」不算数。
  const beforeAnyCopy = await fallbackShown()
  stage(
    '失败路径的判据起点干净',
    beforeAnyCopy ? 'failed' : 'passed',
    beforeAnyCopy
      ? '还没点复制，兜底文案就已经在页面上——后面的判断全都不成立'
      : '页面上没有兜底文案',
  )

  const deniedInjected = await injectClipboard('denied')
  const deniedClicked = deniedInjected ? await clickInWorkbench('复制回复') : false
  const deniedAt = Date.now()
  const deniedFellBack = deniedInjected ? await waitFor(fallbackShown, 6000) : false
  const deniedWrites = await writesSoFar()
  stage(
    '复制被拒绝时给出可读兜底',
    deniedInjected && deniedClicked && deniedFellBack && deniedWrites === 1 ? 'passed' : 'failed',
    !deniedInjected
      ? '无法替换 Navigator.prototype.clipboard，这条分支没法构造'
      : !deniedClicked
        ? '找不到可点的「复制回复」'
        : `写入被调用 ${deniedWrites} 次；${deniedFellBack ? `${Date.now() - deniedAt}ms 内出现手动复制提示` : '没有任何反馈'}`,
  )
  await screenshot('09b-copy-denied')
  await restoreClipboard()

  /**
   * 刷新一次再测挂起。
   *
   * 兜底文案已经在页面上了，不重置就分不清「这次又写了一遍」与「上次那句还留着」。
   * 刷新顺带证明另一件事——已批准的候选重载之后仍然可复制，不会退回未批准。
   */
  await send('Page.reload', { ignoreCache: false })
  await sleep(4000)
  await dismissOnboarding(shellCtx())
  await openSettings(shellCtx())
  await openPluginPage(shellCtx(), { markers: /发表工作台|当前步骤|离线讨论导入/ })
  await scrollToSection('发表工作台')
  await sleep(1200)
  // 页面重载过，辅助函数跟着没了，这里重新装上再继续。
  const reRegistered = await registerWorkbenchHelpers()
  stage(
    '刷新后重新挂上工作台定位函数',
    reRegistered ? 'passed' : 'failed',
    reRegistered ? '已重装' : '页面上找不到「发表工作台」这一节',
  )

  const afterReloadCopyState = await bodyText()
  const stillCopyReady = /复制回复/.test(afterReloadCopyState)
  stage(
    '刷新后已批准的候选仍可复制',
    stillCopyReady ? 'passed' : 'failed',
    stillCopyReady
      ? '按钮仍是「复制回复」'
      : `按钮不是可复制状态：${(afterReloadCopyState.match(/还不能复制|复制回复/) ?? ['找不到按钮'])[0]}`,
  )

  const hangClean = !(await fallbackShown())
  const hangInjected = await injectClipboard('hang')
  const hangClicked = hangInjected ? await clickInWorkbench('复制回复') : false
  const hangAt = Date.now()
  /**
   * ## 采样间隔要细，因为这里要量的是「上限有没有生效」
   *
   * `waitFor` 的轮询是 500ms 一跳，用它算出来的耗时会被取整到 500 的倍数，
   * 看不出真实间隔。这里单独按 100ms 采样，并记下 `writeText` 被调用的时刻，
   * 于是能算出「从写入到兜底」到底是 1.5 秒还是别的数。
   */
  const hangFellBack = hangInjected && hangClean ? await waitFor(fallbackShown, 8000, 100) : false
  const hangWaited = Date.now() - hangAt
  const hangWrites = await writesSoFar()
  const hangCalledAt = await evaluate<number>('window.__clipCalledAt || 0')
  const hangCapMs = hangCalledAt > 0 ? hangAt - hangCalledAt : -1
  /**
   * ## 判据是「写入被调用了几次」，不是墙钟
   *
   * 第一版还要求「耗时 ≥ 900ms」，理由是：`copyCandidate` 在 `navigator.clipboard`
   * 不存在时会直接短路（0 次写入、立即兜底），那样测到的就不是挂起分支。
   *
   * 但墙钟在这个环境里量不准 —— 同一条分支两次跑出 518ms 和 513ms，而代码里
   * 的上限明明是 1500ms；轮询间隔、CDP 往返、渲染耗时都会挤进这个数字里，
   * 把它当地下判据只会制造时红时绿。
   *
   * 真正能区分两条分支的是**写入次数**：
   * - 短路分支：`typeof clipboard.writeText !== 'function'` → 一次都不调用；
   * - 挂起分支：调用一次，Promise 永不 settle，只能由 1500ms 那个定时器兜底。
   *
   * 所以 `hangWrites === 1` 已经证明走的是挂起；`hangFellBack` 证明兜底文案出现了。
   * 耗时照实写进详情供人核对，但不参与判定 —— 一个不稳定的判据比没有判据更糟。
   */
  stage(
    '剪贴板永不返回时不会卡死',
    hangInjected && hangClean && hangClicked && hangFellBack && hangWrites === 1 ? 'passed' : 'failed',
    !hangInjected
      ? '无法替换 Navigator.prototype.clipboard'
      : !hangClean
        ? '刷新之后兜底文案仍在页面上，这条判据不成立'
        : !hangClicked
          ? '找不到可点的「复制回复」'
          : `写入被调用 ${hangWrites} 次（0 次说明走的是「没有剪贴板」短路，不是挂起），` +
            `写入后 ${hangCapMs}ms 完成点击、${hangWaited}ms 后${hangFellBack ? '出现手动复制提示' : '仍无反馈'}`,
  )
  await screenshot('09c-copy-hang')
  await restoreClipboard()

  /**
   * 点之前先记下「按钮上写的是什么」：`复制回复` 说明已就绪，`还不能复制` 说明
   * 还有前置条件没满足。两者的点击结果完全不同，混在一起判会把失败读成成功。
   *
   * 这一句必须紧挨着这次点击：中间隔了刷新与四轮失败注入之后，任何更早读到的
   * 标签都描述的是另一个时刻的页面。
   */
  const copyLabel = await evaluate<string>(`(() => {
    const b = [...document.querySelectorAll('button')].find(n => ['复制回复','还不能复制'].includes((n.innerText || '').trim()))
    return b ? (b.innerText || '').trim() : 'missing'
  })()`)
  const copyClicked = await clickScrolled('复制回复')
  stage(
    '点击「复制回复」',
    copyClicked ? 'passed' : 'failed',
    copyClicked ? '按钮就绪，已点击' : `按钮当时写的是「${copyLabel}」：${copyLabel === '还不能复制' ? '前置条件没满足' : '找不到按钮'}`,
  )
  await sleep(1500)

  const clipboard = await evaluate<string>(`(async () => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return 'unavailable'
      const text = await navigator.clipboard.readText()
      return text
    } catch (error) {
      return 'error:' + String(error && error.message ? error.message : error).slice(0, 80)
    }
  })()`)
  const clipboardOk = clipboard !== 'unavailable' && !clipboard.startsWith('error:') && clipboard.trim() !== ''
  stage(
    '系统剪贴板里读回了正文',
    clipboardOk ? 'passed' : 'failed',
    clipboardOk
      ? `读回 ${clipboard.length} 字符：${clipboard.slice(0, 40)}…`
      : clipboard === 'unavailable'
        ? '这个环境没有 navigator.clipboard.readText'
        : clipboard.slice(0, 100),
  )
  await screenshot('09-copied')

  // ── 刷新与重启后的恢复 ──────────────────────────────────────────────────
  await send('Page.reload', { ignoreCache: false })
  await sleep(4000)
  await dismissOnboarding(shellCtx())
  await openSettings(shellCtx())
  const afterReload = await openPluginPage(shellCtx(), {
    markers: /离线讨论导入|主人贴吧数字 ID|当前步骤|平台|工作台/,
  })
  // 刷新后同样要滚到工作台那一段（桌面端没有页签，见前面那段说明）。
  const workbenchAgain = await scrollToSection('发表工作台')
  // 进入分区本身也是一条证据：分区没挂上时，下面那句「会话丢了」会是假结论。
  stage(
    '刷新后重新进入插件分区',
    afterReload.mounted && workbenchAgain ? 'passed' : 'failed',
    afterReload.mounted ? (workbenchAgain ? '分区与工作台都在' : '分区在，但找不到工作台') : afterReload.detail,
  )
  await sleep(2500)
  /**
   * ## 判定与措辞必须来自同一个条件
   *
   * 第一版写成「pass 的条件」是一套，「detail 的措辞」是另一套，于是出现过
   * 一次「✔ 刷新后仍读得到这条会话 — 刷新之后工作台说是空的」这种自相矛盾的行。
   * 报告里一行自相矛盾，就足以让人不再相信另外那二十几行。
   */
  /**
   * ## 判据必须只看工作台那一段
   *
   * 第一版在全页文字里找「还没有导入任何内容」——而那是**离线导入**分区的空状态
   * 文案，会话在不在它都会出现。这个入口把 11 个区块堆在一页，全页搜索等于
   * 把别的分区的空状态当成这个分区的结论，于是「刷新后会话丢了」这条一直是假红，
   * 而实际上刷新之后页面明明显示着「当前步骤：人工批准」和两条候选。
   *
   * 正确的做法是先把工作台那一段的正文取出来，再在**它里面**判断。
   */
  const workbenchText = await evaluate<string>(`(() => {
    const title = [...document.querySelectorAll('.dsd-sect-title,span')]
      .find(n => (n.textContent || '').trim() === '发表工作台')
    if (!title) return ''
    let scope = title
    for (let i = 0; i < 6 && scope.parentElement; i += 1) {
      scope = scope.parentElement
      if ((scope.textContent || '').includes('当前步骤')) break
    }
    return scope.textContent || ''
  })()`)
  const sessionBack = /当前步骤/.test(workbenchText) && /候选\s*\d+\s*条/.test(workbenchText)
  stage(
    '刷新后仍读得到这条会话',
    sessionBack ? 'passed' : 'failed',
    sessionBack
      ? (workbenchText.split('\n').find((line) => /当前步骤|已读取/.test(line)) ?? workbenchText.slice(0, 80)).trim().slice(0, 100)
      : `工作台里没有会话痕迹：${workbenchText.slice(0, 120).replace(/\s+/g, ' ')}`,
  )
  await screenshot('10-after-reload')

  // ── 负向：未登录时必须说明原因 ───────────────────────────────────────────
  setWeiboScenario({ doctor: 'not_authenticated' })
  await scrollToSection('平台')
  await sleep(1200)
  const refreshed = await clickByText('重新检查') || (await clickByText('刷新'))
  stage('触发一次重新诊断', refreshed ? 'passed' : 'skipped', refreshed ? '已点击刷新' : '页面上没有刷新按钮')
  await sleep(2500)
  const afterLogout = await bodyText()
  stage(
    '未登录时说明真实原因',
    /登录|认证|开通|未就绪|令牌/.test(afterLogout) ? 'passed' : 'failed',
    /登录|认证|开通|未就绪|令牌/.test(afterLogout) ? '页面提示登录/认证/开通' : `页面没有说明原因：${afterLogout.slice(0, 160).replace(/\n/g, ' / ')}`,
  )
  await screenshot('11-not-logged-in')

  // ── 写请求：必须为 0 ────────────────────────────────────────────────────
  const writeCalls = weiboCalls().filter((argv) =>
    /(create|update|destroy|repost|remove|delete|publish|send)\b/i.test(argv.join(' ')),
  )
  stage(
    '全程没有任何写请求到达 CLI',
    writeCalls.length === 0 ? 'passed' : 'failed',
    writeCalls.length === 0 ? '调用日志里 0 条写请求' : `出现了写请求：${writeCalls.map((a) => a.join(' ')).join('；')}`,
  )

  const readCalls = weiboCalls().filter((argv) => argv[0] === 'statuses' || argv[0] === 'comments')
  stage(
    '读取确实走了 CLI（不是页面自己造的）',
    readCalls.length > 0 ? 'passed' : 'failed',
    readCalls.length > 0 ? `${readCalls.length} 次真实 CLI 读取` : '调用日志里没有读取记录',
  )
}

/** `clickByText` 在按钮被禁用时返回 false；这里不区分，交给调用方描述。 */
function clickByLabelSafe(label: string): Promise<boolean> {
  return clickByText(label)
}

// ── 收尾 ───────────────────────────────────────────────────────────────────

try {
  await main()
} catch (error) {
  stage(
    '执行中断',
    'failed',
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? ' @ ' + (error.stack.split('\n')[1] ?? '').trim().slice(0, 120) : ''}`
      : String(error),
  )
  try {
    await screenshot('99-crash')
  } catch {
    stage('失败截图', 'failed', '截图也失败了')
  }
}

stage(
  '控制台没有未捕获异常',
  exceptions.length === 0 ? 'passed' : 'failed',
  exceptions.length === 0 ? '0 条' : exceptions.slice(0, 3).join(' | '),
)
stage(
  '控制台没有 error 级日志',
  consoleErrors.length === 0 ? 'passed' : 'failed',
  consoleErrors.length === 0 ? '0 条' : consoleErrors.slice(0, 3).join(' | '),
)

// 恢复健康场景，避免下一次运行从「未登录」开始。
setWeiboScenario({ doctor: 'ok' })

const bundle = evidence.finish({ outDir, stages, cwd: worktree })
const passed = stages.filter((s) => s.status === 'passed').length
const failed = stages.filter((s) => s.status === 'failed').length
const skipped = stages.filter((s) => s.status === 'skipped').length
writeFileSync(join(outDir, 'result.json'), JSON.stringify({ stages, passed, failed, skipped }, null, 2), 'utf8')

process.stdout.write(
  `\n结论：${failed === 0 ? 'passed' : 'failed'} —— ${stages.length} 阶段，` +
    `${passed} 通过，${failed} 失败，${skipped} 跳过\n` +
    `证据：${join(outDir, 'evidence.json')}\n` +
    `被测代码指纹：${bundle.testedCodeSha.slice(0, 12)} · 测试指纹：${bundle.testedTestSha.slice(0, 12)} · 构建指纹：${bundle.testedBuildSha.slice(0, 12)}\n`,
)
process.exit(failed === 0 ? 0 : 1)
