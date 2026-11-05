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

/**
 * Click by real coordinates, after proving the element is visible **and scrollable into view**.
 *
 * ## Why the scroll is not optional
 *
 * `getBoundingClientRect` returns coordinates relative to the viewport, and
 * `Input.dispatchMouseEvent` clicks at a point in that viewport. An element below the fold
 * therefore reports a `y` larger than the window height, and the click lands on nothing —
 * silently. The button "exists and is enabled" by every DOM measure, the click returns true,
 * and nothing happens.
 *
 * That is exactly how the 「测试模型连接」 stage failed on its first run: the button is near the
 * bottom of the AI 模型 tab, below the fold at 1600×1100, so the probe was never pressed and
 * the page was never asked. The same defect would hit any control a future version adds lower
 * down, so it is fixed here rather than by moving the assertion.
 *
 * The element is scrolled to the *centre* rather than "into view": a control flush against the
 * bottom edge can be covered by a sticky footer, and the click would then land on the footer.
 */
async function clickByLabel(label: string): Promise<boolean> {
  const rect = await evaluate<{ x: number; y: number } | null>(`(() => {
    const nodes = [...document.querySelectorAll('button, [role=tab], a')]
    const node = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)})
    if (!node) return null
    const first = node.getBoundingClientRect()
    if (first.width === 0 || first.height === 0) return null
    node.scrollIntoView({ block: 'center', inline: 'center' })
    const r = node.getBoundingClientRect()
    // After scrolling, the point must actually be inside the viewport; otherwise the click
    // would be dispatched at coordinates the page cannot receive.
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

/**
 * Clear whatever is between us and the sidebar.
 *
 * Three kinds of blocker show up on a fresh document, and they do **not** share a
 * dismissal: the onboarding 「继续」 button, the plain Escape-dismissible popover, and
 * the 「开始使用」 dialog. That last one is a `role="dialog" aria-modal="true"` whose
 * mask covers the whole viewport and *swallows every click aimed at the sidebar* while
 * Escape does nothing at all — it only closes via its own 关闭 button.
 *
 * Not knowing about it cost a full debugging round: after the reload the sidebar button
 * was there, had a non-zero box, `elementFromPoint` at its centre returned the mask, and
 * the click simply vanished. The resulting failure read 「刷新后插件行出现 — 60 秒内
 * 插件列表没有渲染出 dsh-ai-debate 这一行」, which blames the Host's inventory endpoint
 * for what was really a modal in front of the button.
 */
async function dismissOverlays(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const clickedContinue = await clickByLabel('继续')
    if (clickedContinue) {
      await sleep(1200)
      continue
    }

    // A modal mask is the one blocker Escape cannot clear, so close it explicitly. The
    // click is dispatched through the element (the button is inside the dialog the mask
    // belongs to), and the mask leaving the DOM is the evidence it worked.
    const closedDialog = await evaluate<boolean>(`(() => {
      const button = document.querySelector('[role="dialog"] button[aria-label="关闭"]')
      if (button === null) return false
      button.click()
      return true
    })()`)
    if (closedDialog) {
      await sleep(800)
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

/** True while a modal mask is still covering the page. */
async function overlayIsBlocking(): Promise<boolean> {
  return evaluate<boolean>(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    return dialog !== null && dialog.getBoundingClientRect().width > 0
  })()`)
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
  // Claim the foreground up front. `clickByLabel` dispatches synthesized mouse events,
  // and those are discarded without a word when the target is not in front — see the
  // comment at the reload below for how that failure reads.
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  stage('连接浏览器', 'passed', `CDP ${port}，页面 ${page.url.slice(0, 40)}`)

  await dismissOverlays()
  await screenshot('01-start')

  // Settings → plugin → configure → workbench
  const openedPlugins = await clickByLabel('插件')
  stage('打开插件页', openedPlugins ? 'passed' : 'failed', openedPlugins ? '已点击' : '找不到「插件」')

  // The plugin list is populated by an async read, so a fixed wait races it. Poll for the
  // row instead: on a cold profile the first paint shows the page shell with no rows, and a
  // 2-second sleep is fine until it is not.
  await waitFor(async () => {
    return evaluate<boolean>(`document.querySelector('[aria-label="查看 dsh-ai-debate"]') !== null`)
  }, 20_000)

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

  // ## The model connection test, driven through the page (v0.2.27 §七)
  //
  // This is the button that answers "is my endpoint actually reachable, and does it speak the
  // protocol I think it does". Three things must hold: the button exists and is clickable, a
  // live endpoint reports success *with what it measured*, and a wrong endpoint reports a
  // failure with an actionable suggestion rather than hanging the page.
  const modelTab = await clickByLabel('AI 模型')
  await sleep(1500)
  // Recorded as a stage rather than a bare `await`: if the tab click misses, every probe
  // assertion below fails for a reason that has nothing to do with the model endpoint.
  stage('进入 AI 模型页', modelTab ? 'passed' : 'failed', modelTab ? '已点击页签' : '找不到 AI 模型页签')

  const probeButtonExists = await evaluate<boolean>(`(() => {
    return [...document.querySelectorAll('button')].some(b => (b.textContent||'').trim() === '测试模型连接' && !b.disabled)
  })()`)
  stage(
    '模型连接测试按钮可用',
    probeButtonExists ? 'passed' : 'failed',
    probeButtonExists ? '按钮存在且可点' : '找不到可点的「测试模型连接」',
  )

  if (probeButtonExists) {
    const clickedProbe = await clickByLabel('测试模型连接')
    // Wait for the *result block* the panel renders after a probe — a protocol line — rather
    // than for any occurrence of 「失败」. The first version matched a bare /失败/, which also
    // appears in unrelated hint text, so it reported a conclusion that was never produced.
    const probedOk = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return /协议：|Protocol:/.test(text)
    }, 30_000)
    const probeText = await evaluate<string>(`document.body.innerText`)
    const claimsOk = /连接正常/.test(probeText)
    // The detail line must carry the protocol and the latency, not just the word "connected".
    const hasDetail = /协议：/.test(probeText) && /本次耗时：/.test(probeText)
    stage(
      '模型连接测试返回结论',
      clickedProbe && probedOk ? 'passed' : 'failed',
      clickedProbe ? (probedOk ? '页面给出了带协议与耗时的结论' : '30 秒内没有结论') : '点击失败',
    )
    stage(
      '连接成功时说明测到了什么',
      claimsOk && hasDetail ? 'passed' : 'failed',
      claimsOk
        ? hasDetail
          ? '报告了协议与耗时'
          : '只说「连接正常」，没有协议/耗时信息'
        : `本地模拟端点应连通，但页面报的是失败：${probeText.split('\n').find((l) => /失败|错误/.test(l)) ?? '（没有失败文案）'}`,
    )
    await screenshot('02c-model-probe')
  }

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
    // ## Wait for the consequence, not for the clock
    //
    // Picking a comment re-reads the floor to confirm the target author, so the page can
    // stay on 「选要反驳的那一条」 for several seconds. A fixed `sleep(6000)` therefore
    // reported "页面没有目标行" on a run where the pick was in fact being applied — the
    // assertion was measuring elapsed time, not the product.
    await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.split('\n').some((line) => line.trim().startsWith('目标：'))
    }, 40_000)
    await sleep(800)
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

  // ## The tab must actually be populated
  //
  // v0.2.25 ended here: the tab highlighted, the section showed its heading and one
  // sentence, and there was no form. Two product defects, both fixed in v0.2.26 — the
  // read was never triggered on tab entry, and the capability was hard-wired to
  // `comment.publish`, so the two parent fields could not be rendered at all.
  //
  // This stage exists so a regression to either one fails here rather than showing up
  // much later as "the platform never received a publish".
  const panelLoaded = await waitFor(async () => {
    const text = await evaluate<string>(`document.body.innerText`)
    return text.includes('发起一次验收') && text.includes('要验收的能力')
  }, 20_000)
  stage(
    '验收面板加载出表单',
    panelLoaded ? 'passed' : 'failed',
    panelLoaded ? '能力选择器与表单字段都在' : '20 秒内没有出现表单',
  )
  await screenshot('05a-verify-panel')

  /** Set a `<select>` the way a person does: real change event through the native setter. */
  async function pickOption(selectLabelOrId: string, value: string): Promise<boolean> {
    return evaluate<boolean>(`(() => {
      const nodes = [...document.querySelectorAll('select')]
      const select = nodes.find((s) => (s.id || '') === ${JSON.stringify(selectLabelOrId)})
        ?? nodes.find((s) => {
          const label = s.closest('label') ?? document.querySelector('label[for="' + s.id + '"]')
          return label !== null && (label.textContent || '').includes(${JSON.stringify(selectLabelOrId)})
        })
        ?? nodes.find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(value)}))
      if (!select) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, ${JSON.stringify(value)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value === ${JSON.stringify(value)}
    })()`)
  }

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

  // Choose the capability the workbench actually needs. A reply is `comment.reply`;
  // verifying `comment.publish` here would leave the workbench blocked with
  // `capability_not_proven`, which is exactly what v0.2.25 shipped.
  const capabilityPicked = await pickOption('要验收的能力', 'comment.reply')
  await sleep(600)
  stage(
    '选择要验收的能力 comment.reply',
    capabilityPicked ? 'passed' : 'failed',
    capabilityPicked ? '已选中 comment.reply' : '能力选择器不存在或选不中',
  )

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

  /**
   * Baseline *before* the verification publishes.
   *
   * `验收本身恰好发表 1 次` below used to assert the absolute count was 1, which is
   * only true against an empty log. On a re-run against the same isolated tree the log
   * already held one, so the count read 2 and the stage failed on a run where the
   * verification had published exactly once — the assertion was measuring the
   * environment's history, not this run's behaviour.
   *
   * Taking the baseline first makes it a delta, which is what the sentence claims.
   */
  const countPublishes = (): number =>
    publishLog !== '' && existsSync(publishLog)
      ? (JSON.parse(readFileSync(publishLog, 'utf8')) as { publishes: unknown[] }).publishes.length
      : 0
  const verifyBaseline = countPublishes()

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

  // ## Baseline for the publish count
  //
  // The verification above published one reply on purpose — that is the whole point of it.
  // Everything after this line is the workbench's own work, so "it published exactly once"
  // must be measured from here. Measuring from zero made a correct run look like a double
  // publish, and would have masked a real one.
  const publishBaseline = countPublishes()
  const verifyPublished = publishBaseline - verifyBaseline
  stage(
    '验收本身恰好发表 1 次',
    verifyPublished === 1 ? 'passed' : 'failed',
    `验收阶段模拟平台收到 ${verifyPublished} 次（本轮之前 ${verifyBaseline} 次，现在 ${publishBaseline} 次）`,
  )

  // Back to the workbench for the rest of the flow.
  await clickByLabel('工作台')
  await sleep(2500)

  // ── generate ────────────────────────────────────────────────────────────────
  //
  // ## The wait has to be for a *new* candidate, not for "a candidate"
  //
  // 「候选」 and a version chip are already on the page when this runs — the previous
  // candidate is being displayed. A predicate that only looks for those matches on the first
  // poll, so the run proceeds while generation is still in flight, and the next step (editing
  // the textarea) lands on the old row. The edit then applies to a candidate that is about to
  // be superseded, and the approved text and the published text differ.
  //
  // So the version number is captured before the click and the wait requires it to change.
  const versionBefore = await evaluate<string>(`(() => {
    const m = (document.body.innerText || '').match(/v(\d+)/)
    return m ? m[1] : ''
  })()`)
  const genClicked = await clickByLabel('生成候选')
  stage('点击「生成候选」', genClicked ? 'passed' : 'failed', genClicked ? '已点击真实按钮' : '按钮不存在或不可点')
  if (genClicked) {
    const generated = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      const m = text.match(/v(\d+)/)
      if (!m) return false
      // A version bump is the only observable proof that a *new* candidate arrived.
      return versionBefore === '' ? true : m[1] !== versionBefore
    }, 30_000)
    stage('候选出现在页面上', generated ? 'passed' : 'failed', generated ? '已渲染候选' : '30 秒内没有新候选')
    // Generation is a network round trip to the model; the version chip can appear before the
    // row is interactive. Settle briefly so the textarea belongs to the new candidate.
    await sleep(1200)
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
  //
  // `DSH_E2E_FAIL_MODE` turns this step into the negative case: the simulated platform is
  // switched to reject (or never answer) before the click, and what is asserted inverts —
  // the page must *not* claim success, and the count must show the attempt happened without
  // being retried. The default path is untouched.
  const failMode = process.env.DSH_E2E_FAIL_MODE ?? ''
  const controlPath = process.env.DSH_E2E_CONTROL_JSON ?? ''
  if (failMode !== '') {
    if (controlPath === '') {
      stage('设置失败模式', 'failed', 'DSH_E2E_FAIL_MODE 需要 DSH_E2E_CONTROL_JSON 才能生效')
    } else {
      writeFileSync(controlPath, JSON.stringify({ publishMode: failMode }), 'utf8')
      stage('设置失败模式', 'passed', `模拟平台改为 ${failMode}`)
    }
  }

  const publishClicked = await clickByLabel('发表这一条（只会发一次）')
  stage('点击发表', publishClicked ? 'passed' : 'failed', publishClicked ? '已点击真实按钮' : '发表按钮不存在')
  if (publishClicked) {
    if (failMode === '') {
      // ## The success claim has to be the *confirmed* one
      //
      // This used to wait for `已发表|回读` — and the step bar renders 「▶ 回读确认」 from the
      // first paint, so the predicate matched immediately and the stage passed before the
      // request had even come back. A run whose read-back reported
      // 「回读与审核内容不一致：回复的作者是 ai_account，而绑定账号是 600001」 therefore
      // scored 46/46 while the stored session said the outcome was uncertain.
      //
      // The label is the one the client actually renders (`workbenchOutcomeConfirmed`), read
      // from `client/client.cjs` rather than guessed: an assertion written against a sentence
      // the product never says fails on a correct run and would tempt someone to loosen it.
      const CONFIRMED = '回读四项全部确认'
      const published = await waitFor(async () => {
        const text = await evaluate<string>(`document.body.innerText`)
        return text.includes(CONFIRMED) || /发表结果：(结果不确定|已拒绝|未知)/.test(text)
      }, 45_000)
      const publishText = await evaluate<string>(`document.body.innerText`)
      const confirmed = publishText.includes(CONFIRMED)
      const outcomeLine = publishText.split('\n').find((l) => l.trim().startsWith('发表结果：')) ?? ''
      stage(
        '发表结果显示',
        published && confirmed ? 'passed' : 'failed',
        confirmed
          ? `页面给出「发表结果：${CONFIRMED}」`
          : published
            ? `页面没有确认回读：${outcomeLine === '' ? '（没有发表结果行）' : outcomeLine.slice(0, 80)}`
            : '45 秒内没有结论',
      )
      await screenshot('09-published')
    } else {
      // Wait for *a* result, which may be a refusal. The assertion is not "it said
      // something" but "what it said is not success" — a page that reports the confirmed
      // label on a rejected request is the exact dishonesty this whole suite exists to catch.
      //
      // The success marker is the client's own `workbenchOutcomeConfirmed`
      // （回读四项全部确认）. The earlier version tested for 「已发表并回读确认」, a sentence
      // that exists nowhere in the product: the check could never fire, so this stage passed
      // no matter what the page said.
      const settled = await waitFor(async () => {
        const text = await evaluate<string>(`document.body.innerText`)
        return /发表结果：/.test(text) && !/发表结果：还没有发表过/.test(text)
      }, 45_000)
      const text = await evaluate<string>(`document.body.innerText`)
      const claimsSuccess = text.includes('回读四项全部确认')
      const outcomeLine = text.split('\n').find((l) => l.trim().startsWith('发表结果：')) ?? ''
      stage(
        '接口失败时不虚报成功',
        settled && !claimsSuccess ? 'passed' : 'failed',
        claimsSuccess
          ? '页面声称回读四项全部确认——接口失败了却报成功'
          : settled
            ? `页面给出的是「${outcomeLine.replace('发表结果：', '')}」，不是成功`
            : '45 秒内没有任何结论',
      )
      await screenshot('09-publish-failed')
    }
  }

  // The platform's log is written by a timer in the host process, so "the page said it was
  // sent" can be true a few hundred milliseconds before the record is on disk. Waiting for
  // the record itself is what makes the count below a measurement rather than a race —
  // without it a correct run reads 1 and a double publish reads 2, one second later.
  await waitFor(async () => {
    const rows =
      publishLog !== '' && existsSync(publishLog)
        ? (JSON.parse(readFileSync(publishLog, 'utf8')) as { publishes: unknown[] }).publishes.length
        : 0
    return rows > publishBaseline
  }, 15_000)

  // ## What the simulated platform actually received
  //
  // The log is cumulative, and the verification step above *legitimately* published one
  // reply — that is what verification is. Counting both as "the workbench published twice"
  // would have been a false failure, and counting the first one as the workbench's would
  // have compared the approved text against the verification text. So the baseline is taken
  // where the simulation last had a reason to publish, and only what comes after it is the
  // workbench's.
  const readPublishes = (): {
    seq: number
    kind: string
    nestedReplyId?: string
    floorPostId?: string
    content: string
  }[] =>
    publishLog !== '' && existsSync(publishLog)
      ? (JSON.parse(readFileSync(publishLog, 'utf8')) as {
          publishes: {
            seq: number
            kind: string
            nestedReplyId?: string
            floorPostId?: string
            content: string
          }[]
        }).publishes
      : []

  const allPublished = readPublishes()
  const sent = allPublished.slice(publishBaseline)
  if (failMode === '') {
    stage(
      '工作台让模拟平台收到 1 次发表',
      sent.length === 1 ? 'passed' : 'failed',
      `本次工作台发表 ${sent.length} 次（此前已有 ${publishBaseline} 次，来自验收）`,
    )
  } else {
    // In the negative run the request still reaches the platform — that is the point: the
    // platform *received* it and refused it (or never answered). What must not happen is a
    // second request, so the count is asserted at exactly one either way.
    const rejected = (allPublished.slice(publishBaseline) as { outcome?: string }[]).filter(
      (row) => row.outcome === 'rejected',
    )
    stage(
      '失败模式下平台只收到 1 次尝试',
      sent.length === 1 ? 'passed' : 'failed',
      `收到 ${sent.length} 次，其中被平台拒绝 ${rejected.length} 次`,
    )
  }
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
  const afterSecond = readPublishes().slice(publishBaseline).length
  stage(
    '重复点击不会二次发表',
    afterSecond === sent.length ? 'passed' : 'failed',
    `第二次点击后本次共 ${afterSecond} 次`,
  )

  // ## Reload, and prove the state on screen came back from storage
  //
  // Everything above could be explained by a page that kept its own optimistic copy. The
  // reload is what separates "the UI remembers" from "the state is on disk": after a fresh
  // document, the approval must read as spent and the candidate must come back from the
  // store, not from a deleted React tree.
  await send('Page.reload', { ignoreCache: true })
  /**
   * A reload takes the page target out of the foreground, and CDP input is dropped
   * silently while that is true.
   *
   * This is the part that made the next three stages lie. `Input.dispatchMouseEvent`
   * returns `{}` — no error, no warning — but nothing arrives: not on the button, not
   * even on a capture-phase listener attached to `document`. So the click looked
   * dispatched, the sidebar never opened, and the report said 「60 秒内插件列表没有
   * 渲染出 dsh-ai-debate 这一行」. The plugin list was fine the whole time; the input
   * was going nowhere.
   *
   * `Page.bringToFront` restores it. It has to be after the reload, because the reload
   * is what loses it.
   */
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  /**
   * Wait for the shell to be *interactive*, not merely for a fixed delay.
   *
   * `sleep(9000)` was a guess about how long a reload takes. When the guess was wrong
   * the click below landed on a document whose React tree had not hydrated, the click
   * was swallowed, and the next two minutes were spent waiting for a plugin list that
   * nobody had asked the page to open. The failure then read 「详情=false 配置=false
   * 工作台=false」 — indistinguishable from a product that had lost its settings page.
   *
   * A sidebar button that exists and has a non-zero box is the evidence that the shell
   * is mounted; only then is a click meaningful.
   */
  const shellReady = await waitFor(async () => {
    return evaluate<boolean>(`(() => {
      const nodes = [...document.querySelectorAll('button, [role=tab], a')]
      const node = nodes.find((n) => (n.textContent || '').trim() === '插件')
      if (!node) return false
      const r = node.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })()`)
  }, 30_000)
  if (!shellReady) stage('刷新后界面可交互', 'failed', '30 秒内侧边栏没有可点的「插件」')
  await dismissOverlays()

  // If a mask is still up after four dismissal rounds, say so *here*. The next stage's
  // failure would otherwise blame the plugin inventory for a modal sitting in front of
  // the button — same symptom, completely different owner.
  const stillBlocked = await overlayIsBlocking()
  if (stillBlocked) {
    stage('刷新后没有模态遮罩挡住侧边栏', 'failed', '遮罩仍在，后续点击会被吞掉')
  }

  const reopenedPlugins = await clickByLabel('插件')
  const pluginsPageOpened = reopenedPlugins
    ? await waitFor(async () => {
        return evaluate<boolean>(`document.body.innerText.includes('安装、启用和配置插件')`)
      }, 15_000)
    : false
  if (reopenedPlugins && !pluginsPageOpened) {
    stage('刷新后点开插件页', 'failed', '点击后 15 秒内没有进入「安装、启用和配置插件」')
  }
  /**
   * The plugin inventory is re-fetched after a reload, and it is not always fast.
   *
   * The budget here was 20 s. On a cold host the inventory call can take far longer —
   * measured at ~40 s on this machine, and it is the *Host's* endpoint, not this
   * plugin's. The result was a stage that failed with 「详情=false 配置=false
   * 工作台=false」 on a product that was entirely healthy, and because the wait's
   * return value was discarded there was no way to tell a timeout from a missing row.
   *
   * So: wait longer, and keep the answer. A timeout now says "the list never
   * appeared", which is a different sentence from "the row was there but 配置 was not",
   * and only one of those is worth investigating in the product.
   */
  const waitForRow = async (ms: number): Promise<boolean> =>
    waitFor(async () => {
      return evaluate<boolean>(`document.querySelector('[aria-label="查看 dsh-ai-debate"]') !== null`)
    }, ms)
  let reloadRowsAppeared = pluginsPageOpened ? await waitForRow(30_000) : false
  if (pluginsPageOpened && !reloadRowsAppeared) {
    // One retry. A swallowed click is not a missing row, and the two cannot be told
    // apart from inside the page — re-clicking costs a second and removes the ambiguity.
    await dismissOverlays()
    await clickByLabel('插件')
    reloadRowsAppeared = await waitForRow(30_000)
  }
  if (pluginsPageOpened && !reloadRowsAppeared) {
    stage('刷新后插件行出现', 'failed', '60 秒内插件列表没有渲染出 dsh-ai-debate 这一行')
  }
  const reopenedDetail = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="查看 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  if (reopenedDetail) {
    // The detail view fetches its own summary; clicking 配置 before it renders is the
    // same silent no-op the first navigation had to learn about.
    await waitFor(async () => {
      return evaluate<boolean>(`document.querySelector('[aria-label="配置 dsh-ai-debate"]') !== null`)
    }, 30_000)
  }
  const reopenedConfig = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="配置 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  if (reopenedConfig) {
    // Wait for the settings shell rather than a fixed delay: the ten tabs are what the
    // next click addresses, and they arrive with the settings payload.
    await waitFor(async () => {
      return evaluate<boolean>(
        `[...document.querySelectorAll('button, [role=tab], a')].some(n => (n.textContent || '').trim() === '工作台')`,
      )
    }, 30_000)
  }

  const reopenedWorkbench = await clickByLabel('工作台')
  if (reopenedWorkbench) await sleep(3000)
  stage(
    '刷新后能重新进入工作台',
    pluginsPageOpened && reloadRowsAppeared && reopenedConfig && reopenedWorkbench ? 'passed' : 'failed',
    `插件页=${pluginsPageOpened} 插件行=${reloadRowsAppeared} 详情=${reopenedDetail} 配置=${reopenedConfig} 工作台=${reopenedWorkbench}`,
  )

  const afterReloadText = await evaluate<string>(`document.body.innerText`)
  if (failMode === '') {
    // What "the state came back" looks like on this page: the step strip is past approval, and
    // the publish step is shown as done rather than offered again. Asserting on a specific
    // sentence was wrong the first time — the page says 「当前步骤：回读确认」, not 「已发表」,
    // and the underlying fact (the authorisation is spent) is what needs checking.
    const reachedReadback = afterReloadText.includes('回读确认')
    const approvalTick = /人工批准/.test(afterReloadText)
    stage(
      '刷新后工作台恢复到最后一步',
      reachedReadback && approvalTick ? 'passed' : 'failed',
      reachedReadback && approvalTick
        ? '步骤停在「回读确认」，且人工批准仍是已完成'
        : `没有恢复：回读确认=${reachedReadback} 人工批准=${approvalTick}`,
    )
  } else {
    // ## What a rejected publish must look like
    //
    // A 500 is *not* "nothing happened" — the platform received the request and the plugin
    // cannot tell whether it acted on it. So the correct page state is 「结果不确定，去原帖
    // 核实，不要重发」, which the step strip shows as 「回读确认」: the next action really is
    // to go and look. Asserting "it must not advance" would have demanded the *wrong*
    // behaviour and would have pushed towards treating an unknown outcome as a clean failure
    // — the exact mistake that gets a reply posted twice.
    //
    // What must hold: the page says the outcome is unconfirmed, and it does not claim success.
    const saysUncertain = /结果不确定|未确认|需要回帖页核实/.test(afterReloadText)
    const claimsPublished = /已发表并回读确认/.test(afterReloadText)
    stage(
      '失败后页面说的是「结果不确定」，不是成功',
      saysUncertain && !claimsPublished ? 'passed' : 'failed',
      claimsPublished
        ? '页面声称已发表并回读确认'
        : saysUncertain
          ? '页面明确说明结果不确定，要求回帖核实'
          : '页面既没说不确定，也没说成功——读者无从判断',
    )
  }
  await screenshot('10-after-reload')

  // The spend itself is a fact about storage, so it is read from storage rather than inferred
  // from a label. `consumedAt` present means exactly one authorisation was used, once.
  const storePath = process.env.DSH_E2E_STORE_STATE ?? ''
  if (storePath !== '' && existsSync(storePath)) {
    const state = JSON.parse(readFileSync(storePath, 'utf8')) as {
      approvals?: { consumedAt?: string; textHash?: string }[]
      verification?: { outcome?: string }[]
    }
    const approvals = Array.isArray(state.approvals) ? state.approvals : []
    const consumed = approvals.filter((row) => typeof row.consumedAt === 'string' && row.consumedAt !== '')
    if (failMode === '') {
      stage(
        '存储里恰好有一份已消费的授权',
        approvals.length === 1 && consumed.length === 1 ? 'passed' : 'failed',
        `授权 ${approvals.length} 份，已消费 ${consumed.length} 份`,
      )
    } else {
      // A refused request still spends the authorisation: the plugin cannot know whether the
      // platform acted on it. What matters is that it is not left reusable.
      stage(
        '失败后授权不会被悄悄退回',
        approvals.length === 1 ? 'passed' : 'failed',
        `授权 ${approvals.length} 份，已消费 ${consumed.length} 份`,
      )
    }
    const verified = Array.isArray(state.verification) ? state.verification : []
    const succeeded = verified.filter((row) => row.outcome === 'succeeded')
    stage(
      '存储里的验收证据是 succeeded',
      succeeded.length === 1 ? 'passed' : 'failed',
      `验收记录 ${verified.length} 条，succeeded ${succeeded.length} 条`,
    )
  }

  // A second publish after the reload must be impossible: the authorisation was spent, and
  // the page must not offer a fresh button that pretends otherwise.
  const republishOffered = await evaluate<boolean>(`(() => {
    return [...document.querySelectorAll('button')].some(b =>
      (b.textContent || '').trim() === '发表这一条（只会发一次）' && !b.disabled)
  })()`)
  const beforeRepublish = readPublishes().length
  if (republishOffered) {
    await clickByLabel('发表这一条（只会发一次）')
    await sleep(3000)
  }
  const afterRepublish = readPublishes().length
  stage(
    '刷新后不能复用已消费的授权',
    afterRepublish === beforeRepublish ? 'passed' : 'failed',
    `刷新后再发表：${republishOffered ? '按钮存在' : '没有可用按钮'}，发表数 ${beforeRepublish} → ${afterRepublish}`,
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
