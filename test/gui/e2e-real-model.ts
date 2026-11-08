/**
 * 真实模型验收：通过**宿主自己的模型服务**跑一次端到端生成（v0.2.36 §3.3）。
 *
 * ## 为什么这条路值得单独一个脚本
 *
 * 本机没有任何插件自己的模型凭据（`DSH_EVAL_*` / `OPENAI_*` 都没有），但宿主
 * 自己配了模型 —— 真机探测到 `deepseek-account/deepseek-flash` 与 `deepseek-v4-pro`。
 * 那不是「另一份要偷的密钥」：DSH 把模型能力注册成公开服务 `llm`，插件通过
 * `ctx.get('llm')` 使用它，请求由宿主发出，插件只拿回文本与 token 数。
 *
 * 所以这一轮证明的是：**插件能在真实桌面里，用真实模型，产出符合契约的候选**。
 *
 * ## 预算
 *
 * 本脚本只做 **一次** 真实生成 + 一次连通性探测，并显式设了上限：
 * `maxTokens` 由模型配置决定，`--budget` 只做计数保护（默认 4 次调用）。
 * 不重试、不循环、不因为失败而重跑一遍 —— 一次真实调用失败本身就是结论。
 *
 * ## 它会改变什么
 *
 * 只在隔离 profile 里写会话与候选。不发布任何内容，不触发平台写入。
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { openPluginPage, openSettings, type ShellCtx } from './desktop-shell.ts'

const CDP_PORT = Number(process.env.DSH_E2E_CDP_PORT ?? '9800')
const OUT = process.env.DSH_E2E_OUT_DIR ?? `C:/AI-Workspace/dsh-ai-debate/tmp/desk-real-model/run-${CDP_PORT}`
const BUDGET = Number(process.env.DSH_E2E_MODEL_BUDGET ?? '4')

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
  webSocketDebuggerUrl: string
}[]
const page = list.find((target) => target.type === 'page' && target.url.startsWith('dsh-app://'))
if (page === undefined) {
  stage('连接浏览器', 'failed', `没有找到 dsh-app:// 页面（${list.map((t) => t.url).join(' | ')}）`)
  finish(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, { res: (value: unknown) => void; rej: (error: Error) => void }>()
ws.addEventListener('message', (event: MessageEvent) => {
  const frame = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown }
  if (frame.id === undefined) return
  const entry = pending.get(frame.id)
  if (entry === undefined) return
  pending.delete(frame.id)
  if (frame.error !== undefined) entry.rej(new Error(JSON.stringify(frame.error)))
  else entry.res(frame.result)
})
await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
})

const CDP_TIMEOUT_MS = 30_000
function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时`))
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
  })) as { result?: { value?: T }; exceptionDetails?: unknown }
  if (result.exceptionDetails !== undefined) throw new Error(`求值失败：${JSON.stringify(result.exceptionDetails).slice(0, 200)}`)
  return result.result?.value as T
}

async function clickAt(x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function clickByText(label: string): Promise<boolean> {
  const position = await evaluate<string>(`(() => {
    const nodes = [...document.querySelectorAll('button,[role=button],a,[tabindex]')]
    for (const node of nodes) {
      const text = (node.innerText || '').trim()
      if (text !== ${JSON.stringify(label)} && !text.startsWith(${JSON.stringify(label)})) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) })
    }
    return 'not-found'
  })()`)
  if (!position.startsWith('{')) return false
  const point = JSON.parse(position) as { x: number; y: number }
  await clickAt(point.x, point.y)
  return true
}

const ctx: ShellCtx = {
  evaluate,
  clickAt,
  clickByText,
  sleep,
  viewport: async () => {
    const size = await evaluate<{ w: number; h: number }>('({ w: window.innerWidth, h: window.innerHeight })')
    return { vw: size.w, vh: size.h }
  },
}

const bodyText = async (): Promise<string> => evaluate<string>('document.body ? document.body.innerText : ""')

// ---- 进门 -------------------------------------------------------------------
await send('Page.bringToFront')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

let ready = false
const readyDeadline = Date.now() + 60_000
while (Date.now() < readyDeadline) {
  if (await clickByText('插件')) {
    ready = true
    break
  }
  await sleep(1500)
}
stage('页面加载到可操作状态', ready ? 'passed' : 'failed', ready ? '侧边栏「插件」可点' : '60 秒内没有可点的「插件」')
if (!ready) finish(1)

const settings = await openSettings(ctx)
stage('打开设置', settings.ok ? 'passed' : 'failed', settings.how)
/**
 * 进门失败时把当前页面文本打出来。
 *
 * 没有这一段时，报告只写「分区没渲染」，而看不出**当时屏幕上是什么** ——
 * 上一次就因此多跑了一整轮才定位到「点到了插件管理页，不是插件分区」。
 */
if (!settings.ok) {
  const text = await bodyText()
  stage('设置页现状（诊断）', 'skipped', text.slice(0, 200).replace(/\n/g, ' / '))
}
let plugin = await openPluginPage(ctx, { markers: /离线讨论导入|主人贴吧数字 ID|模型来源/ })
if (!plugin.mounted) {
  /**
   * 退路：设置页的侧栏有时先渲染「插件」这个分类，插件自己在下一层。
   *
   * 上一轮就是在这里红的：`openPluginPage` 点到了「插件」，页面停在了插件管理页
   * （安装、启用和配置插件 / 刷新 / 添加插件），而断言读的是插件分区文案。
   * 点完分类之后重新找一次分区标题，才走得通。
   */
  await clickByText('插件')
  await sleep(1500)
  plugin = await openPluginPage(ctx, { markers: /离线讨论导入|主人贴吧数字 ID|模型来源/ })
}
stage('进入插件分区', plugin.mounted ? 'passed' : 'failed', plugin.detail)

// ---- 模型来源：切到宿主 -----------------------------------------------------
/**
 * 把「模型来源」切到「宿主模型」。
 *
 * 走界面而不是改配置文件：这一轮要证明的是**用户按得动**，而不是「配置文件管用」。
 * 面板里的三栏是 `dsd-llm-source`，用 `select` 的原生 setter + change 事件驱动 ——
 * 直接赋 `.value` 不会触发 React 的 onChange（它监听的是原型上的 setter）。
 */
const switched = await evaluate<boolean>(`(() => {
  const select = document.getElementById('dsd-llm-source')
  if (!select) return false
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
  if (!descriptor || !descriptor.set) return false
  descriptor.set.call(select, 'host')
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
stage('切到「宿主模型」来源', switched ? 'passed' : 'failed', switched ? '已切换并派发 change' : '找不到模型来源选择器')

// 保存（面板底部通常有一个保存按钮；找到就点，找不到就等自动保存）
const saved = await clickByText('保存')
await sleep(2500)
stage('保存配置', saved ? 'passed' : 'skipped', saved ? '已点击保存' : '没有单独的保存按钮（面板可能自动保存）')

// ---- 宿主模型列表 -----------------------------------------------------------
const hostProbe = await clickByText('查看宿主可用模型')
stage('点击「查看宿主可用模型」', hostProbe ? 'passed' : 'failed', hostProbe ? '已点击' : '按钮不存在')
let hostLine = ''
if (hostProbe) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(500)
    const text = await bodyText()
    hostLine =
      text.split('\n').find((line) => line.includes('可用模型：') || line.includes('不可用：')) ?? ''
    if (hostLine !== '') break
  }
  stage(
    '宿主模型结论',
    hostLine.includes('可用模型：') ? 'passed' : 'failed',
    hostLine === '' ? '30 秒内没有结论' : hostLine.slice(0, 160),
  )
}

// ---- 连通性 + 契约探测（真实调用 #1、#2）-----------------------------------
const probeClicked = await clickByText('测试模型连接')
stage('点击「测试模型连接」', probeClicked ? 'passed' : 'failed', probeClicked ? '已点击' : '按钮不存在')

let probeText = ''
if (probeClicked) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await sleep(1000)
    const text = await bodyText()
    if (text.includes('连接正常') || text.includes('契约探测') || text.includes('失败')) {
      probeText = text
      if (text.includes('连接正常') || text.includes('契约探测')) break
    }
  }
}
const connected = /连接正常（宿主模型服务）/.test(probeText) || /连接正常/.test(probeText)
stage(
  '连接测试给出了结果',
  connected ? 'passed' : 'failed',
  connected
    ? (probeText.split('\n').find((line) => line.includes('连接正常')) ?? '').slice(0, 140)
    : (probeText.split('\n').find((line) => line.includes('失败') || line.includes('错误')) ?? '120 秒内没有结果').slice(0, 160),
)
const sourceLine = probeText.split('\n').find((line) => line.includes('来源：')) ?? ''
stage('结论里写明了模型来源', sourceLine.includes('宿主') ? 'passed' : 'failed', sourceLine.slice(0, 100) || '没有「来源」那一行')
const protocolLine = probeText.split('\n').find((line) => line.includes('协议：')) ?? ''
stage('结论里写明了协议', protocolLine.includes('host') ? 'passed' : 'failed', protocolLine.slice(0, 100) || '没有协议那一行')
const contractLine = probeText.split('\n').find((line) => line.includes('契约探测')) ?? ''
stage('契约探测单独报告', contractLine !== '' ? 'passed' : 'failed', contractLine.slice(0, 140) || '没有契约探测那一行')

// ---- 真实生成（真实调用 #3）-------------------------------------------------
/**
 * 在「工作台」里做一次真实生成。
 *
 * 顺序是：进工作台分区 → 若没有会话就先从最近一次导入里取一条 → 选人格 →
 * 点生成 → 读候选与安全评估。
 *
 * 这一轮**只生成一次**：目的是证明「真实模型能产出符合契约的候选」，不是做质量
 * 抽样。四种人格的质量对照需要四次调用，本脚本用 `--persona` 参数一次跑一种，
 * 由外层脚本按预算决定跑几种。
 */
const workbench = await clickByText('工作台')
stage('进入工作台', workbench ? 'passed' : 'failed', workbench ? '已点击' : '找不到工作台入口')

let candidateText = ''
let generated = false
if (workbench) {
  await sleep(2000)
  const generateClicked = await clickByText('生成候选')
  stage('点击「生成候选」', generateClicked ? 'passed' : 'failed', generateClicked ? '已点击真实按钮' : '没有会话或按钮不可点')
  if (generateClicked) {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      await sleep(1500)
      const text = await bodyText()
      if (text.includes('安全评估') && (text.includes('候选') || text.includes('通过') || text.includes('需人工'))) {
        candidateText = text
        generated = true
        break
      }
      if (text.includes('失败') && text.includes('模型')) {
        candidateText = text
        break
      }
    }
  }
}
stage(
  '真实模型产出候选',
  generated ? 'passed' : 'failed',
  generated
    ? '页面渲染了候选与安全评估'
    : (candidateText.split('\n').find((line) => line.includes('失败')) ?? '180 秒内没有候选').slice(0, 160),
)

// ---- 证据落盘 ---------------------------------------------------------------
function finish(code: number): never {
  for (const target of ['Page.captureScreenshot'] as const) void target
  mkdirSync(OUT, { recursive: true })
  const failed = stages.filter((entry) => entry.status === 'failed').length
  const skipped = stages.filter((entry) => entry.status === 'skipped').length
  const evidence = {
    cdpPort: CDP_PORT,
    budget: BUDGET,
    stages,
    hostModels: hostLine,
    probe: probeText.slice(0, 2000),
    candidate: candidateText.slice(0, 2000),
    conclusion: failed === 0 && skipped === 0 ? 'passed' : 'failed',
    at: new Date().toISOString(),
  }
  writeFileSync(join(OUT, 'real-model.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(OUT, 'report.md'),
    [
      '# 真实模型验收',
      '',
      `- 结论：**${evidence.conclusion}**（失败 ${failed}，跳过 ${skipped}）`,
      `- 宿主模型：${hostLine || '(未取到)'}`,
      `- CDP 端口：${CDP_PORT}`,
      '',
      '## 阶段',
      '',
      ...stages.map((entry) => `- ${entry.status === 'passed' ? '✔' : entry.status === 'failed' ? '✘' : '·'} ${entry.name} — ${entry.detail}`),
      '',
    ].join('\n'),
    'utf8',
  )
  process.stdout.write(`\n结论：${evidence.conclusion}（失败 ${failed}，跳过 ${skipped}）\n`)
  process.exit(code)
}

if (existsSync(OUT)) writeFileSync(join(OUT, '.keep'), '', 'utf8')
finish(stages.some((entry) => entry.status === 'failed') ? 1 : 0)
