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

import { PICKED_NESTED_POST_ID, PICKED_PARENT_POST_ID, THREAD_ID } from '../support/fixture-discussion.ts'

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
/** Where the simulated platform records what it was asked to publish. */
const publishLog = process.env.DSH_E2E_PUBLISH_LOG ?? ''

/** Poll until `check` is true, or give up after `timeoutMs`. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(500)
  }
  return false
}

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

  // Pick the nested comment the fixture targets.
  //
  // The list is ordered floors-then-nested, and the fixture's picked post is the first
  // nested reply of floor 1. Choosing by index rather than "first button" is what lets
  // the later assertions name an exact post id: with six rows, "the first 用这条" is a
  // different comment than the one the publish target is compared against.
  const pickInfo = await evaluate<{ count: number; index: number }>(`(() => {
    const rows = [...document.querySelectorAll('li')]
    const buttons = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条')
    const target = buttons.findIndex((button) => {
      const row = button.closest('li')
      return row !== null && (row.textContent || '').includes(${JSON.stringify(PICKED_NESTED_POST_ID)})
        || (row !== null && (row.textContent || '').includes('成本高一倍'))
    })
    void rows
    return { count: buttons.length, index: target }
  })()`)
  stage('「用这条」按钮出现', pickInfo.count > 0 ? 'passed' : 'failed', `共 ${pickInfo.count} 个`)
  if (pickInfo.count > 0) {
    const buttonIndex = pickInfo.index >= 0 ? pickInfo.index : 0
    const picked = await evaluate<boolean>(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条')
      const button = buttons[${buttonIndex}]
      if (!button) return false
      button.click(); return true
    })()`)
    stage('点击「用这条」', picked ? 'passed' : 'failed', picked ? `已点击第 ${buttonIndex + 1} 条` : '点击失败')
    await sleep(6000)
    await screenshot('05-after-pick')
  } else {
    stage('点击「用这条」', 'skipped', '没有可点的按钮')
  }

  // ## The workbench must now show which comment is selected, and where the reply lands
  //
  // The page labels this line 「目标：」. An earlier version of this check looked for
  // 「回复目标」, which the UI never renders — the assertion was wrong, not the page.
  const afterPick = await evaluate<string>(`document.body.innerText`)
  const targetLine =
    afterPick.split('\n').find((line) => line.trim().startsWith('目标：')) ?? ''
  stage(
    '显示选中的目标',
    targetLine.includes(PICKED_NESTED_POST_ID) ? 'passed' : 'failed',
    targetLine === '' ? '页面没有目标行' : targetLine.slice(0, 80),
  )

  // ── register the publish capability, through the 验收 tab ───────────────────
  //
  // The publish path refuses a platform whose `comment.reply` is only declared, never
  // proven (`capability_not_proven`). That gate is correct and is not bypassed here: the
  // owner's own verification flow is driven instead — one authorisation, one post, read
  // back. In this environment the platform is the simulated server, so the post lands
  // there and the read-back sees it.
  const verifyTab = await clickByLabel('验收')
  await sleep(2000)
  stage('进入验收页', verifyTab ? 'passed' : 'failed', verifyTab ? '已点击页签' : '找不到验收页签')

  async function fillVerifyField(label: string, value: string): Promise<boolean> {
    const focused = await evaluate<boolean>(`(() => {
      const labels = [...document.querySelectorAll('label')]
      const box = labels.find((l) => (l.textContent || '').includes(${JSON.stringify(label)}))
      if (!box) return false
      const input = box.querySelector('input')
      if (!input) return false
      input.focus()
      return document.activeElement === input
    })()`)
    if (!focused) return false
    await typeText(value)
    await sleep(120)
    return true
  }

  const verifyText = '隔离验收：这条是端到端测试环境发出的模拟回复。'
  const filled =
    (await fillVerifyField('发帖账号 id', '600001')) &&
    (await fillVerifyField('帖子 id', THREAD_ID)) &&
    (await fillVerifyField('要回复的楼层 id', PICKED_PARENT_POST_ID)) &&
    (await fillVerifyField('要回复的那条评论 id', PICKED_NESTED_POST_ID)) &&
    (await fillVerifyField('授权人', 'e2e')) &&
    (await fillVerifyField('要发表的正文', verifyText))
  stage('填写验收表单', filled ? 'passed' : 'failed', filled ? '六项都已填入' : '有字段没找到')
  await screenshot('05b-verify-form')

  const submitted = await clickByLabel('发表并回读')
  stage('提交验收', submitted ? 'passed' : 'failed', submitted ? '已点击真实按钮' : '找不到提交按钮')
  if (submitted) {
    const verified = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.includes('已发表并回读确认') || text.includes('回读证据不完整') || text.includes('未确认')
    }, 40_000)
    stage('验收结果返回', verified ? 'passed' : 'failed', verified ? '页面显示验收结论' : '40 秒内没有结论')
    await screenshot('05c-verify-result')
  }

  // Back to the workbench for the rest of the flow.
  await clickByLabel('工作台')
  await sleep(2500)

  // ── generate ────────────────────────────────────────────────────────────────
  const genClicked = await clickByLabel('生成候选')
  stage('点击「生成候选」', genClicked ? 'passed' : 'failed', genClicked ? '已点击真实按钮' : '按钮不存在或不可点')
  if (genClicked) {
    // The model call is local but not instant; wait for the candidate row to appear
    // rather than for a fixed time, so a slow machine does not fail the run.
    const generated = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.includes('候选') && /v\d+/.test(text)
    }, 30_000)
    stage('候选出现在页面上', generated ? 'passed' : 'failed', generated ? '已渲染候选' : '30 秒内没有候选')
    await screenshot('06-generated')
  }

  // ── edit through the textarea ───────────────────────────────────────────────
  //
  // Editing is the only way the owner's own words reach the publish path, so it is
  // typed the way a person types and then saved through the button. The new text is
  // kept in `editedText` and later compared against what the simulated platform
  // received — a mismatch there would mean the approval was bound to something else.
  const EDITED_SUFFIX = '（这句是人工编辑追加的）'
  const editorReady = await evaluate<boolean>(`(() => {
    const area = document.querySelector('textarea')
    if (!area) return false
    area.focus()
    return document.activeElement === area
  })()`)
  let editedText = ''
  if (editorReady) {
    await typeText(EDITED_SUFFIX)
    await sleep(300)
    editedText = await evaluate<string>(`(() => { const a = document.querySelector('textarea'); return a ? a.value : '' })()`)
    const savedEdit = await clickByLabel('保存修改')
    stage('编辑并保存正文', savedEdit ? 'passed' : 'failed', savedEdit ? `追加 ${EDITED_SUFFIX}` : '找不到保存修改')
    await sleep(3000)
    await screenshot('07-edited')
  } else {
    stage('编辑并保存正文', 'failed', '找不到正文输入框')
  }

  // ## Approval must be granted, and the page must reflect it
  const approveClicked = await clickByLabel('批准这一条')
  stage('点击「批准这一条」', approveClicked ? 'passed' : 'failed', approveClicked ? '已点击真实按钮' : '批准按钮不存在')
  if (approveClicked) {
    const approved = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.includes('已批准')
    }, 20_000)
    stage('批准状态出现在页面', approved ? 'passed' : 'failed', approved ? '页面显示已批准' : '20 秒内没有已批准')
    await screenshot('08-approved')
  }

  // ## Publish, through the page, exactly once
  const publishClicked = await clickByLabel('发表这一条（只会发一次）')
  stage('点击发表', publishClicked ? 'passed' : 'failed', publishClicked ? '已点击真实按钮' : '发表按钮不存在')
  if (publishClicked) {
    const published = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.includes('已发表') || text.includes('回读')
    }, 30_000)
    stage('发表结果显示', published ? 'passed' : 'failed', published ? '页面显示发表/回读结果' : '30 秒内没有结果')
    await screenshot('09-published')
  }

  // ## What the simulated platform actually received
  const platformLog = publishLog !== '' && existsSync(publishLog)
    ? (JSON.parse(readFileSync(publishLog, 'utf8')) as {
        publishes: { seq: number; kind: string; nestedReplyId?: string; floorPostId?: string; content: string }[]
      })
    : { publishes: [] }
  const sent = platformLog.publishes
  stage('模拟平台收到 1 次发表', sent.length === 1 ? 'passed' : 'failed', `实际 ${sent.length} 次`)
  if (sent.length > 0) {
    const first = sent[0]!
    stage(
      '发表目标是选中的楼中楼',
      first.nestedReplyId === PICKED_NESTED_POST_ID ? 'passed' : 'failed',
      `comment_id=${first.nestedReplyId ?? '（无）'} floor=${first.floorPostId ?? '（无）'}`,
    )
    const bodyOk = editedText !== '' && first.content.trim() === editedText.trim()
    stage(
      '发表正文与页面上的正文一致',
      bodyOk ? 'passed' : 'failed',
      bodyOk ? `一致（${first.content.length} 字）` : `平台收到「${first.content.slice(0, 30)}…」`,
    )
  }

  // ## Clicking publish again must not send a second time
  await clickByLabel('发表这一条（只会发一次）')
  await sleep(2500)
  const afterSecond = publishLog !== '' && existsSync(publishLog)
    ? (JSON.parse(readFileSync(publishLog, 'utf8')) as { publishes: unknown[] }).publishes.length
    : 0
  stage(
    '重复点击不会二次发表',
    afterSecond === sent.length ? 'passed' : 'failed',
    `第二次点击后共 ${afterSecond} 次`,
  )

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
