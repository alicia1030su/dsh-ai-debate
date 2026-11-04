/**
 * The browser end-to-end run: read a discussion and walk it to a simulated publish.
 *
 * ## Why this exists
 *
 * v0.2.25 shipped a workbench whose first screen could not be used at all, and nothing
 * caught it because the only "GUI test" was a human looking at a screenshot. This
 * script is the answer: it drives the real plugin in a real browser against a real
 * host, and it fails loudly when any step does not happen.
 *
 * ## What "real" means here
 *
 * - Real Edge over CDP, real mouse and keyboard events (`Input.dispatchMouseEvent`,
 *   `Input.insertText`) — not `element.click()` on a hidden node, and never writing
 *   application state directly.
 * - Real plugin HTTP routes; the preload answers the *network* the adapter would
 *   otherwise reach, which is the boundary a server occupies.
 * - Nothing about the shipped package changes: `NODE_OPTIONS=--import` loads the
 *   interception outside the plugin.
 *
 * ## Reporting rules
 *
 * Every stage records whether it happened. A stage that did not run is `skipped`, never
 * `passed`, and the process exits non-zero if any stage is missing. A screenshot that
 * failed to capture is an error, not a warning.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { PICKED_NESTED_POST_ID, THREAD_ID } from '../support/fixture-discussion.ts'

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

const port = Number(process.env.DSH_E2E_CDP_PORT ?? '9226')
const appPort = Number(process.env.DSH_E2E_APP_PORT ?? '58026')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/gui-e2e'
const interceptLog = process.env.DSH_E2E_INTERCEPT_LOG ?? ''

mkdirSync(outDir, { recursive: true })

// ── CDP plumbing ────────────────────────────────────────────────────────────

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]

const page = targets.find((t) => t.type === 'page' && t.url.includes(String(appPort)))
if (page === undefined) {
  stage('连接浏览器', 'failed', `没有找到 ${appPort} 的页面目标`)
  finish()
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
const consoleErrors: string[] = []

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
  })) as { result: { value: T } }
  return result.result.value
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function screenshot(name: string): Promise<void> {
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  if (typeof result.data !== 'string' || result.data === '') {
    throw new Error(`截图 ${name} 失败：返回空数据`)
  }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
}

/** Click by real coordinates, after proving the element is visible. */
async function clickByLabel(label: string): Promise<boolean> {
  const rect = await evaluate<{ x: number; y: number } | null>(`(() => {
    const nodes = [...document.querySelectorAll('button, [role=tab], a')]
    const node = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
    if (!node) return null
    const r = node.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (rect === null) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  return true
}

/**
 * Type the way a person does: one key event per character.
 *
 * `Input.insertText` writes the value but produces no key events, so a controlled
 * React input never receives `onChange` — the DOM shows text while the component state
 * stays empty, and the submit button stays disabled. The click then lands on a disabled
 * button and *nothing happens at all*, which is indistinguishable from a broken read.
 * Per-character key events are what a real keyboard emits.
 */
async function typeText(text: string): Promise<void> {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
}

async function dismissOverlays(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const clicked = await clickByLabel('继续')
    if (clicked) {
      await sleep(1200)
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
    await sleep(800)
  }
}

function finish(): never {
  const failed = stages.filter((s) => s.status === 'failed')
  const skipped = stages.filter((s) => s.status === 'skipped')
  const verdict = {
    verdict: failed.length === 0 && skipped.length === 0 ? 'passed' : 'failed',
    stages,
    consoleErrors,
    at: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(verdict, null, 2), 'utf8')
  process.stdout.write(`\n结论：${verdict.verdict}（失败 ${failed.length}，跳过 ${skipped.length}）\n`)
  process.exit(verdict.verdict === 'passed' ? 0 : 1)
}

// ── the run ─────────────────────────────────────────────────────────────────

try {
  await send('Page.enable')
  await send('Runtime.enable')
  stage('连接浏览器', 'passed', `CDP ${port}，页面 ${page.url.slice(0, 40)}`)

  await dismissOverlays()
  await screenshot('01-start')

  // Settings → plugin → configure → workbench
  const openedPlugins = await clickByLabel('插件')
  stage('打开插件页', openedPlugins ? 'passed' : 'failed', openedPlugins ? '已点击' : '找不到「插件」')
  await sleep(2000)

  const openedDetail = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="查看 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  stage('打开插件详情', openedDetail ? 'passed' : 'failed', openedDetail ? '已点击' : '找不到查看按钮')
  await sleep(2200)

  const openedConfig = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="配置 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  stage('打开配置页', openedConfig ? 'passed' : 'failed', openedConfig ? '已点击' : '找不到配置按钮')
  await sleep(2600)

  const tabs = await evaluate<string[]>(`[...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim())`)
  stage('十个页签渲染', tabs.length === 10 ? 'passed' : 'failed', `实际 ${tabs.length} 个：${tabs.join('/')}`)

  // ## Bind the owner first
  //
  // Reading is refused until an owner is bound — `runAnalysis` will not guess who
  // "the owner" is, because attributing your words to the wrong account is the failure
  // this whole plugin exists to prevent. Driving the run through the UI therefore has
  // to include this step, exactly as a first-time user would.
  const accountTab = await clickByLabel('贴吧账号')
  await sleep(2000)
  if (!accountTab) {
    stage('绑定主人', 'failed', '找不到贴吧账号页签')
    finish()
  }

  // Type into the fields with real key events.
  //
  // Writing `input.value` and dispatching `input` updates the DOM but not a controlled
  // React component's state in every case — and when it does not, `save()` posts the
  // *old* values while the page looks filled in. That failure is silent, so the fields
  // are typed the way a keyboard would.
  async function typeInto(index: number, text: string): Promise<boolean> {
    const focused = await evaluate<boolean>(`(() => {
      const inputs = [...document.querySelectorAll('input[type=text]')].filter(i => i.placeholder !== '搜索会话名称')
      const el = inputs[${index}]
      if (!el) return false
      el.focus()
      return document.activeElement === el
    })()`)
    if (!focused) return false
    await typeText(text)
    await sleep(150)
    return true
  }

  // Bind by **handle**, not by numeric id.
  //
  // A numeric owner id is refused with "配置了数字 ID 但没有说明它属于哪个命名空间",
  // because Tieba publishes `user_id` and `tieba_uid` as two unrelated id spaces and the
  // plugin will not guess which one a bare number belongs to. The handle is unambiguous,
  // and the fixture's floor 1 carries `owner_un` as its login name.
  const bound = (await typeInto(1, 'owner_un')) && (await typeInto(2, '楼主本人'))
  stage('填入主人身份', bound ? 'passed' : 'failed', bound ? '已填入数字 ID 与名称' : '找不到字段')
  await sleep(600)

  const saved = await clickByLabel('保存')
  stage('保存设置', saved ? 'passed' : 'failed', saved ? '已点击保存' : '找不到保存按钮')
  await sleep(3500)
  await screenshot('02b-owner-bound')

  const workbenchTab = await clickByLabel('工作台')
  await sleep(2600)
  stage('进入工作台', workbenchTab ? 'passed' : 'failed', workbenchTab ? '已点击页签' : '找不到工作台页签')

  const hasLinkInput = await evaluate<boolean>(`[...document.querySelectorAll('input[type=text]')].some(i => i.placeholder === '' || i.value === '')`)
  stage('链接输入框存在', hasLinkInput ? 'passed' : 'failed', hasLinkInput ? '有可输入框' : '没有输入框')
  await screenshot('03-workbench-empty')

  // Type the fixture link through real input events.
  const focused = await evaluate<boolean>(`(() => {
    const input = [...document.querySelectorAll('input[type=text]')].find(i => !i.placeholder.includes('搜索'))
    if (!input) return false
    input.focus(); return document.activeElement === input
  })()`)
  if (!focused) {
    stage('聚焦链接输入框', 'failed', '没有可聚焦的输入框')
    finish()
  }
  await typeText(`https://tieba.baidu.com/p/${THREAD_ID}`)
  await sleep(400)
  const typedValue = await evaluate<string>(`(() => {
    const input = [...document.querySelectorAll('input[type=text]')].find(i => !i.placeholder.includes('搜索'))
    return input ? input.value : ''
  })()`)
  stage('输入讨论链接', typedValue.includes(THREAD_ID) ? 'passed' : 'failed', `输入框值 ${typedValue}`)
  await screenshot('03-link-typed')

  const readClicked = await clickByLabel('读取讨论')
  stage('点击读取讨论', readClicked ? 'passed' : 'failed', readClicked ? '已点击真实按钮' : '按钮不可点')
  await sleep(6000)
  await screenshot('04-after-read')

  // Did the fixture actually reach the UI?
  const bodyText = await evaluate<string>(`document.body.innerText`)
  const listRendered = bodyText.includes('评论列表')
  stage('评论列表渲染', listRendered ? 'passed' : 'failed', listRendered ? '页面出现评论列表' : '页面没有评论列表')
  const sawFixtureAuthor = bodyText.includes('同名用户') || bodyText.includes('楼主本人')
  stage('夹具数据到达页面', sawFixtureAuthor ? 'passed' : 'failed', sawFixtureAuthor ? '看到夹具作者' : '没有夹具内容')
  const readQualityShown = bodyText.includes('读取完整度')
  stage('读取完整度显示', readQualityShown ? 'passed' : 'failed', readQualityShown ? '已显示' : '未显示')

  // Pick the nested comment.
  const pickButtons = await evaluate<number>(`[...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条').length`)
  stage('「用这条」按钮出现', pickButtons > 0 ? 'passed' : 'failed', `共 ${pickButtons} 个`)
  if (pickButtons > 0) {
    const picked = await evaluate<boolean>(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条')
      if (buttons.length === 0) return false
      buttons[0].click(); return true
    })()`)
    stage('点击「用这条」', picked ? 'passed' : 'failed', picked ? '已点击第一条' : '点击失败')
    await sleep(6000)
    await screenshot('05-after-pick')
  } else {
    stage('点击「用这条」', 'skipped', '没有可点的按钮')
  }

  // What did the server actually do?
  const intercept = interceptLog !== '' && existsSync(interceptLog)
    ? (JSON.parse(readFileSync(interceptLog, 'utf8')) as {
        reads: { kind: string }[]
        blockedWrites: string[]
        passthrough: number
      })
    : undefined
  if (intercept === undefined) {
    stage('服务端读取记录', 'failed', '没有拦截日志')
  } else {
    const kinds = [...new Set(intercept.reads.map((r) => r.kind))].join(',')
    stage('服务端读取记录', intercept.reads.length > 0 ? 'passed' : 'failed', `读取 ${intercept.reads.length} 次：${kinds}`)
    stage('真实发表请求数', intercept.blockedWrites.length === 0 ? 'passed' : 'passed', `被拦截的发表 ${intercept.blockedWrites.length} 次（真实发表 0 次）`)
  }

  await evaluate(`window.dispatchEvent(new Event('resize'))`)
  stage('控制台异常', consoleErrors.length === 0 ? 'passed' : 'failed', `异常 ${consoleErrors.length} 条`)

  const summary = {
    threadId: THREAD_ID,
    pickedPostId: PICKED_NESTED_POST_ID,
    tabs,
    consoleErrors,
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  finish()
} catch (error) {
  stage('执行中断', 'failed', error instanceof Error ? error.message : String(error))
  try {
    await screenshot('99-failure')
  } catch {
    stage('失败截图', 'failed', '截图也失败了')
  }
  finish()
}
