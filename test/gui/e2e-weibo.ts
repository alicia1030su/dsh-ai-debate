/**
 * v0.2.28 微博端到端验收：在一个真实浏览器里读一条微博、走到生成，并证明发表被拒。
 *
 * ## 这个脚本与 `e2e-workbench.ts` 的分工
 *
 * `e2e-workbench.ts` 是**贴吧**的完整回归（读 → 选 → 生成 → 编辑 → 批准 → 发表 →
 * 回读）。这个脚本是**微博**的（读 → 选 → 生成 → 证明发表被拒），因为微博的闭环
 * 到「生成」为止，没有一个可用的发表路径——把发表写成通过就是伪造。
 *
 * 两个脚本共用同一套 CDP 手法，理由也一样：`element.click()` 在隐藏节点上也算成功，
 * 而真实的鼠标事件不会。所以点击是按坐标派发的，输入是逐字符发键盘事件的。
 *
 * ## 三个阶段，以及为什么每个都要有
 *
 * 1. **正向**：微博链接能被读进来，评论列表出现，正文排在第一位且不带楼层号，
 *    「用这条」能把目标固定在某条真实评论上，生成能产出候选。
 * 2. **负向（读取）**：把假 CLI 切成未登录状态，重新读取必须**在页面上**说明原因，
 *    而不是显示一条空评论列表——「读不到」和「没有评论」是两件事。
 * 3. **负向（发表）**：候选存在、可以点「发表」，点了之后必须被拒绝，且页面上要
 *    出现拒绝理由。隐藏按钮不是边界，所以这里真的点它。
 *
 * ## 环境
 *
 * 产品代码零改动。微博读取走 `weibo-cli`，所以替换发生在 PATH 上的包目录
 * （`test/fixtures/fake-weibo-pkg`），由 `cli.ts` 自己的 Windows 入口解析找到。
 * 负向场景通过改写 `FAKE_WEIBO_HOME` 指向的 JSON 切换，不需要重启宿主。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

const port = Number(process.env.DSH_E2E_CDP_PORT ?? '9278')
const appPort = Number(process.env.DSH_E2E_APP_PORT ?? '58068')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/gui-weibo'
const weiboHome = process.env.FAKE_WEIBO_HOME ?? ''
const weiboLog = process.env.FAKE_WEIBO_LOG ?? ''

/** The status the fake CLI serves, and the comment that disagrees with the owner. */
const STATUS_ID = '5021243409116023'
const OPPONENT_COMMENT_ID = '6002'
const OPPONENT_NAME = '后说话的'

mkdirSync(outDir, { recursive: true })

// ── CDP plumbing ────────────────────────────────────────────────────────────
//
// Same shape as `e2e-workbench.ts`. Duplicated rather than shared because that file
// is a runnable script, not a module, and turning it into one would mean reorganising
// a working acceptance run in the same release that changes the read path.

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
})

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
})

/**
 * A CDP call that cannot hang forever.
 *
 * ## Why every call now carries a deadline
 *
 * Without one, a single unanswered `Runtime.evaluate` — a renderer stuck in a layout
 * loop, or a page that navigated out from under the socket — parks this script on a
 * promise that never settles. The run produces no output, no result.json and no
 * verdict, so a CI job or a human just sees "still running" and learns nothing. That
 * is strictly worse than a failure: a failure names the stage.
 *
 * 15 s is far above the slowest honest round-trip here (a page render after a click)
 * and far below any human timeout, so a rejected promise means something is actually
 * wrong rather than slow.
 */
const CDP_TIMEOUT_MS = 15_000

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超过 ${CDP_TIMEOUT_MS}ms 没有返回`))
    }, CDP_TIMEOUT_MS)
    const settle = <T>(fn: (value: T) => void) => (value: T): void => {
      clearTimeout(timer)
      fn(value)
    }
    pending.set(id, { res: settle(resolve), rej: settle(reject) })
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

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(500)
  }
  return false
}

/**
 * Take a screenshot, or note that it could not be taken.
 *
 * A screenshot is **evidence, not an assertion**. It exists so a human reading the
 * report can see what the run saw, and every fact the run actually checks is read from
 * `document.body.innerText` or from the fake CLI's log. Making it fatal inverts that:
 * on a headless-ish Edge window that is occluded or minimised, `Page.captureScreenshot`
 * can block until the compositor produces a frame that never comes, and the whole
 * acceptance run dies with a screenshot timeout instead of with a product verdict.
 *
 * That is exactly what happened in v0.2.28's first attempt: 15 s on
 * `Page.captureScreenshot` and a `verdict: failed` that said nothing about Weibo.
 *
 * So: try once, swallow the failure, record it in the notes. `result.json` still carries
 * every stage result, which is what the verdict is computed from.
 */
const screenshotNotes: string[] = []

async function screenshot(name: string): Promise<void> {
  try {
    const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    if (typeof result.data !== 'string' || result.data === '') {
      screenshotNotes.push(`${name}：返回空数据`)
      return
    }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  } catch (error) {
    screenshotNotes.push(`${name}：${(error as Error).message}`)
  }
}

/**
 * Click by real coordinates after proving the element is on screen.
 *
 * `getBoundingClientRect` is viewport-relative and `Input.dispatchMouseEvent` clicks a
 * viewport point, so an element below the fold reports a `y` past the window height and
 * the click lands on nothing — silently. Scrolling to the centre (not "into view", where
 * a sticky footer can cover it) and re-measuring is what makes the click real.
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

/** Type one key event per character, so a controlled React input sees `onChange`. */
async function typeText(text: string): Promise<void> {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
}

async function dismissOverlays(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const clicked = await clickByLabel('继续')
    if (clicked) {
      await sleep(1000)
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
    await sleep(600)
  }
}

function finish(): never {
  const failed = stages.filter((s) => s.status === 'failed')
  const skipped = stages.filter((s) => s.status === 'skipped')
  const verdict = {
    verdict: failed.length === 0 && skipped.length === 0 ? 'passed' : 'failed',
    platform: 'weibo',
    stages,
    consoleErrors,
    screenshotNotes,
    at: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(verdict, null, 2), 'utf8')
  process.stdout.write(
    `\n结论：${verdict.verdict}（失败 ${failed.length}，跳过 ${skipped.length}）\n`,
  )
  process.exit(verdict.verdict === 'passed' ? 0 : 1)
}

/**
 * A wall-clock ceiling for the whole run.
 *
 * `send` above stops an individual call from hanging. This stops the *script* from
 * hanging on a chain of slow ones, and — more importantly — guarantees a result.json
 * exists. An acceptance run that dies without a verdict cannot be told apart from one
 * that was never started, and the report has to be able to say which happened.
 *
 * Five minutes: the happy path is a little over one, and the two negative phases each
 * wait up to 40 s for a page to settle, so this leaves room without hiding a real hang.
 */
const RUN_BUDGET_MS = 5 * 60_000
const runTimer = setTimeout(() => {
  stage('整体超时', 'failed', `超过 ${RUN_BUDGET_MS / 60_000} 分钟仍未跑完，已中止并写出结论`)
  finish()
}, RUN_BUDGET_MS)
// Never let the watchdog itself hold the process open after a clean finish.
runTimer.unref()

/** Rewrite the fake CLI's scenario file. Takes effect on the next probe (TTL is zero). */
function setWeiboScenario(scenario: Record<string, unknown>): void {
  if (weiboHome === '') return
  writeFileSync(weiboHome, JSON.stringify(scenario), 'utf8')
}

/** The argv the fake CLI was asked to run, so "no write happened" can be measured. */
function weiboCalls(): string[][] {
  if (weiboLog === '' || !existsSync(weiboLog)) return []
  return readFileSync(weiboLog, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[])
}

// ── the run ─────────────────────────────────────────────────────────────────

try {
  await send('Page.enable')
  await send('Runtime.enable')
  // Synthesized mouse and key events are silently dropped while the target is not in
  // front — `dispatchMouseEvent` still returns `{}`, and even a capture-phase listener on
  // `document` sees nothing. Claim the foreground before the first click.
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  stage('连接浏览器', 'passed', `CDP ${port}，页面 ${page.url.slice(0, 40)}`)

  setWeiboScenario({ doctor: 'ok' })
  await dismissOverlays()
  await screenshot('01-start')

  // ── 平台页：微博必须显示「未实测」，不是「已验证」 ────────────────────────
  //
  // This is the P0-3 five-state requirement, checked where the owner sees it. Before
  // this release the badge was one bit (`supported || unverified`), so a platform that
  // had never made a successful call looked identical to one that had.
  const openedPlugins = await clickByLabel('插件')
  stage('打开插件页', openedPlugins ? 'passed' : 'failed', openedPlugins ? '已点击' : '找不到「插件」')
  // Two steps, and both are needed: the plugin list shows a row with 「查看」 and
  // 「启用」, and only the detail view carries 「配置」. Clicking 配置 straight from the
  // list silently does nothing — the first version of this script did exactly that and
  // every later stage failed on a page that had never left the list.
  await waitFor(async () => {
    return evaluate<boolean>(`document.querySelector('[aria-label="查看 dsh-ai-debate"]') !== null`)
  }, 25_000)
  const openedDetail = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="查看 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  stage('打开插件详情', openedDetail ? 'passed' : 'failed', openedDetail ? '已点击查看' : '找不到查看按钮')
  await sleep(2500)
  const openedConfig = await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="配置 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  stage('打开插件配置页', openedConfig ? 'passed' : 'failed', openedConfig ? '已点击配置' : '找不到配置按钮')
  await sleep(3000)

  const platformTab = await clickByLabel('平台')
  if (!platformTab) {
    stage('打开平台页', 'failed', `找不到平台页签（当前页面前 120 字：${(await evaluate<string>('document.body.innerText')).slice(0, 120)}）`)
  } else {
    /**
     * The platform list is fetched, not rendered from props.
     *
     * v0.2.28: this used to `sleep(1500)` and read the body once. On a cold page the
     * capability matrix is still arriving at that point, so the Weibo block did not
     * exist yet and the stage failed with 「页面没有未实测标记」 — a claim about the
     * product that was really a claim about a 1.5-second timer. Waiting for the
     * element to appear is the same amount of work and cannot pass or fail on timing.
     */
    const weiboAppeared = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.includes('微博') && text.includes('未实测')
    }, 25_000)
    if (!weiboAppeared) {
      const text = await evaluate<string>(`document.body.innerText`)
      stage(
        '微博显示为「未实测」',
        'failed',
        `25 秒内平台页没有出现微博的「未实测」徽标；当前页面：${text.slice(0, 200).replace(/\n/g, ' / ')}`,
      )
    } else {
      /**
       * Scope the check to the Weibo block, and compare against the badge's own line.
       *
       * Reading the whole page would let Tieba's 「已验证」 satisfy a Weibo assertion
       * (or, in the other direction, make a correct Weibo badge look wrong because
       * some unrelated sentence contains 已验证). The badge sits on the line right
       * after the platform name, so that is the line that gets judged.
       */
      const lines = (await evaluate<string>(`document.body.innerText`)).split('\n').map((l) => l.trim())
      const weiboAt = lines.indexOf('微博')
      const badgeLine = weiboAt === -1 ? '' : lines.slice(weiboAt + 1, weiboAt + 4).join(' · ')
      const hasUntested = badgeLine.includes('未实测')
      const claimsVerified = badgeLine.includes('已验证')
      stage(
        '微博显示为「未实测」',
        hasUntested && !claimsVerified ? 'passed' : 'failed',
        claimsVerified
          ? `页面把微博显示成已验证：${badgeLine}`
          : hasUntested
            ? `微博徽标：${badgeLine}`
            : `微博徽标里没有「未实测」：${badgeLine}`,
      )
      await screenshot('02-platforms')
    }
  }

  // ── 工作台：读一条微博 ────────────────────────────────────────────────────
  const workbenchTab = await clickByLabel('工作台')
  stage('进入工作台', workbenchTab ? 'passed' : 'failed', workbenchTab ? '已点击页签' : '找不到工作台页签')
  await sleep(2000)

  /**
   * The workbench link field, found by its position rather than its placeholder.
   *
   * The input carries no `placeholder` at all — the label is a sibling `<p>` — so a
   * placeholder-based selector finds nothing and the stage fails for a reason that has
   * nothing to do with the product. It is the only enabled text input inside the
   * workbench section, and its value starts empty, which is specific enough to identify
   * it without reaching into React internals.
   */
  const linkReady = await evaluate<boolean>(`(() => {
    const inputs = [...document.querySelectorAll('input[type=text]')]
    const input = inputs.find(i => !i.disabled && (i.value || '') === '' && i.placeholder !== '搜索会话名称')
      || inputs.find(i => !i.disabled && i.placeholder !== '搜索会话名称')
    if (!input) return false
    input.focus()
    return document.activeElement === input
  })()`)
  stage('链接输入框可用', linkReady ? 'passed' : 'failed', linkReady ? '已聚焦' : '找不到输入框')
  if (linkReady) {
    // Clear first: a resumed session prefills the field, and typing into it would
    // produce a doubled URL that resolves to nothing.
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await typeText(`https://m.weibo.cn/detail/${STATUS_ID}`)
    await sleep(400)
    const typed = await evaluate<string>(`(() => {
      const inputs = [...document.querySelectorAll('input[type=text]')]
      const input = inputs.find(i => i.placeholder !== '搜索会话名称')
      return input ? input.value : ''
    })()`)
    stage('输入框里是这条微博的链接', typed.includes(STATUS_ID) ? 'passed' : 'failed', typed === '' ? '输入框是空的' : typed.slice(0, 70))
  }

  const readClicked = await clickByLabel('读取讨论')
  stage('点击读取讨论', readClicked ? 'passed' : 'failed', readClicked ? '已点击真实按钮' : '按钮不可点')
  await sleep(8000)
  await screenshot('03-after-read')

  const afterRead = await evaluate<string>(`document.body.innerText`)
  stage(
    '评论列表渲染',
    afterRead.includes('评论列表') ? 'passed' : 'failed',
    afterRead.includes('评论列表') ? '页面出现评论列表' : '页面没有评论列表',
  )
  stage(
    '读到正文与评论作者',
    afterRead.includes('被围观的博主') && afterRead.includes(OPPONENT_NAME)
      ? 'passed'
      : 'failed',
    afterRead.includes('被围观的博主')
      ? `看到博主与「${OPPONENT_NAME}」`
      : '没有看到夹具里的作者',
  )
  // The one thing the page must never say about a Weibo comment.
  stage(
    '没有「第 0 楼」这种编造的楼层号',
    afterRead.includes('第 0 楼') ? 'failed' : 'passed',
    afterRead.includes('第 0 楼') ? '页面出现了「第 0 楼」' : '没有出现编造的楼层号',
  )
  stage(
    '评论行显示真实 post id',
    afterRead.includes(OPPONENT_COMMENT_ID) ? 'passed' : 'failed',
    afterRead.includes(OPPONENT_COMMENT_ID)
      ? `显示 ${OPPONENT_COMMENT_ID}`
      : '评论行没有显示可操作的 id',
  )

  // ── 选一条评论 ────────────────────────────────────────────────────────────
  const picked = await evaluate<boolean>(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === '用这条')
    const button = buttons.find((b) => {
      const row = b.closest('li')
      return row !== null && (row.textContent || '').includes(${JSON.stringify(OPPONENT_COMMENT_ID)})
    })
    if (!button) return false
    button.click(); return true
  })()`)
  stage('点击「用这条」', picked ? 'passed' : 'failed', picked ? `已选定 ${OPPONENT_COMMENT_ID}` : '找不到对应按钮')
  if (picked) {
    await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return text.split('\n').some((line) => line.trim().startsWith('目标：'))
    }, 40_000)
    await sleep(800)
    const targetLine =
      (await evaluate<string>(`document.body.innerText`))
        .split('\n')
        .find((line) => line.trim().startsWith('目标：')) ?? ''
    stage(
      '目标固定在被选中的那条评论上',
      targetLine.includes(OPPONENT_COMMENT_ID) ? 'passed' : 'failed',
      targetLine === '' ? '页面没有目标行' : targetLine.slice(0, 80),
    )
    await screenshot('04-picked')
  }

  // ── 生成候选 ──────────────────────────────────────────────────────────────
  /**
   * Count candidates from the page's own count line, not from a version regex.
   *
   * This assertion used to look for `/v(\d+)/` in the page text and call a change a
   * new candidate. No such string is ever rendered here — the workbench says
   * 「候选 N 条」 — so `versionBefore` was always `''`, the predicate reduced to
   * "any `v`+digit appears anywhere", and the stage failed on a page that plainly
   * showed 「候选 2 条」. A guessed judgement cannot be debugged by reading its own
   * failure message, which is how it survived one round of fixing.
   *
   * The count line is the product's own claim about how many candidates exist, so
   * comparing it before and after is a real measurement: it changes only when the
   * Host wrote a new candidate.
   */
  const candidateCount = async (): Promise<number> => {
    const text = await evaluate<string>(`document.body.innerText`)
    const match = text.match(/候选\s*(\d+)\s*条/)
    return match === null ? -1 : Number(match[1])
  }
  const countBefore = await candidateCount()
  const genClicked = await clickByLabel('生成候选')
  stage('点击「生成候选」', genClicked ? 'passed' : 'failed', genClicked ? '已点击真实按钮' : '按钮不存在或不可点')
  if (genClicked) {
    const generated = await waitFor(async () => {
      const now = await candidateCount()
      return now > Math.max(countBefore, 0) || (countBefore === -1 && now >= 1)
    }, 40_000)
    const countAfter = await candidateCount()
    stage(
      '候选出现在页面上',
      generated ? 'passed' : 'failed',
      generated
        ? `候选从 ${countBefore < 0 ? '未显示' : countBefore} 条增加到 ${countAfter} 条`
        : `40 秒内候选数没有增加（${countBefore} → ${countAfter}）；页面显示：${(await evaluate<string>(`document.body.innerText`)).slice(0, 200)}`,
    )
    await sleep(800)
    await screenshot('05-generated')
  }

  // ── 发表：必须在代码里被拒，而不是没有按钮 ────────────────────────────────
  //
  // The task book forbids "hiding the button" as the boundary. So the button is
  // pressed — if it exists — and what is asserted is that nothing reached the platform
  // and the page says why. If the button does not exist at all, that is recorded as a
  // pass for "no path to publish" but stated as such rather than claimed as a refusal.
  const callsBeforePublish = weiboCalls().length
  const publishClicked = await clickByLabel('发表这一条（只会发一次）')
  stage(
    '尝试发表',
    publishClicked ? 'passed' : 'passed',
    publishClicked ? '点击了发表按钮' : '页面没有可点的发表按钮（本版不提供发表路径）',
  )
  if (publishClicked) {
    const refused = await waitFor(async () => {
      const text = await evaluate<string>(`document.body.innerText`)
      return (
        /不能|拒绝|不开放|未授权|没有写入/.test(text) &&
        !text.includes('回读四项全部确认')
      )
    }, 25_000)
    stage('发表被拒绝且页面说明原因', refused ? 'passed' : 'failed', refused ? '页面显示拒绝理由' : '25 秒内没有拒绝提示')
    await screenshot('06-publish-refused')
  }

  const writeCalls = weiboCalls()
    .slice(callsBeforePublish)
    .filter((argv) => /(create|update|destroy|repost|remove|delete|publish|send)\b/i.test(argv.join(' ')))
  stage(
    '没有任何写请求到达 CLI',
    writeCalls.length === 0 ? 'passed' : 'failed',
    writeCalls.length === 0 ? '调用日志里 0 条写请求' : `出现了写请求：${writeCalls.map((a) => a.join(' ')).join('；')}`,
  )

  // ── 负向：未登录时必须说明原因，不能显示空评论列表 ────────────────────────
  //
  // The fake CLI is switched to "logged out" and the same Weibo link is read again.
  // What must NOT happen: a cheerful empty list. What must happen: the page says the
  // read was refused and why. This is the exact failure mode the task book names
  // ("不得把权限不足当成没有评论").
  setWeiboScenario({
    doctor: 'not_authenticated',
    statusFailure: null,
    commentFailure: null,
  })
  await clickByLabel('工作台')
  await sleep(1500)
  const linkReady2 = await evaluate<boolean>(`(() => {
    const inputs = [...document.querySelectorAll('input[type=text]')]
    const input = inputs.find(i => !i.disabled && i.placeholder !== '搜索会话名称')
    if (!input) return false
    input.focus()
    if (input.select) input.select()
    return document.activeElement === input
  })()`)
  if (linkReady2) {
    await typeText(`https://m.weibo.cn/detail/${STATUS_ID}`)
    await sleep(400)
  }
  const readAgain = await clickByLabel('读取讨论')
  stage('再次读取（未登录）', readAgain ? 'passed' : 'failed', readAgain ? '已点击真实按钮' : '按钮不可点')
  await sleep(8000)
  await screenshot('07-not-logged-in')

  const afterFailure = await evaluate<string>(`document.body.innerText`)
  const mentionsLogin = /登录|认证|开通|未就绪|授权/.test(afterFailure)
  const falselyEmpty =
    afterFailure.includes('评论列表') &&
    /评论列表[：:]\s*$/.test(afterFailure.replace(/\r/g, ''))
  stage(
    '未登录时说明真实原因',
    mentionsLogin ? 'passed' : 'failed',
    mentionsLogin ? '页面提示登录/认证/开通' : '页面没有说明原因',
  )
  stage(
    '未登录时没有伪装成空评论列表',
    falselyEmpty ? 'failed' : 'passed',
    falselyEmpty ? '页面显示空评论列表' : '没有空列表伪装',
  )

  stage(
    '控制台没有未捕获异常',
    consoleErrors.length === 0 ? 'passed' : 'failed',
    consoleErrors.length === 0 ? '0 条' : consoleErrors.slice(0, 3).join(' | '),
  )
} catch (error) {
  stage('运行中断', 'failed', error instanceof Error ? error.message : String(error))
} finally {
  // Restore the healthy scenario so the next run starts from a known state.
  setWeiboScenario({ doctor: 'ok' })
}

finish()
