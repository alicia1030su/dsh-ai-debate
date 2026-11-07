/**
 * 重启恢复验收（v0.2.31 §八「刷新和重启恢复」）。
 *
 * ## 为什么单独一个脚本
 *
 * 刷新（`Page.reload`）与重启（换一个宿主进程）测的是**不同的东西**：
 *
 * - 刷新只重跑页面，进程内存还在。会话读得到，可能因为它还在缓存里。
 * - 重启之后内存全没了，只剩磁盘上的 `state.json`。它读得到，才说明落盘是对的。
 *
 * 上一版的「刷新后仍读得到」通过，不能推出「重启后仍读得到」——而真实用户
 * 关机重开是常态。所以这一段必须在**换过进程之后**单独跑一次。
 *
 * ## 它断言什么
 *
 * 1. 上一个进程里建立的那条会话还在（按标题找，不按「最新一条」找——最新那条
 *    可能是本轮别的用例建的）。
 * 2. 修正清单还在，且读出来的结构与修正后的样子一致。
 * 3. 候选的确认状态没有被重启重置——「已确认」不能因为重启变回「未确认」。
 * 4. 页面打开之后仍然没有发表入口。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const port = Number(process.env.DSH_E2E_CDP_PORT ?? '9281')
const appPort = Number(process.env.DSH_E2E_APP_PORT ?? '58076')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/gui-manual-restart'

mkdirSync(outDir, { recursive: true })

const startedAt = new Date().toISOString()
let evidence: EvidenceCollector | undefined

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]
const candidates = targets.filter((t) => t.type === 'page' && t.url.includes(String(appPort)))
const page = candidates[candidates.length - 1]
if (page === undefined) {
  stage('连接浏览器', 'failed', `没有找到 ${appPort} 的页面目标`)
  finish()
}

evidence = new EvidenceCollector({
  script: 'e2e-manual-restart.ts',
  scriptVersion: MANUAL_E2E_SCRIPT_VERSION,
  pageUrl: page.url,
  cdpPort: port,
  appPort,
  startedAt,
})
const collector = evidence

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()

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

/** 截图并登记进证据清单。失败时那张 `99-crash` 是最有用的一张。 */
async function screenshot(name: string): Promise<void> {
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  if (typeof result.data !== 'string' || result.data === '') {
    throw new Error(`截图 ${name} 失败：返回空数据`)
  }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  collector.screenshot(name)
}

function finish(): never {
  const failed = stages.filter((s) => s.status === 'failed')
  const skipped = stages.filter((s) => s.status === 'skipped')
  const signals = evidence === undefined ? [] : evidence.signalsView()
  const fatal = signals.filter(
    (signal) => signal.kind === 'exception' || signal.kind === 'network' || signal.kind === 'http',
  )
  const verdict = {
    verdict: failed.length === 0 && skipped.length === 0 && fatal.length === 0 ? 'passed' : 'failed',
    stages,
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

/** 这一次验收关心的那条会话的标题（正向脚本用这一份素材）。 */
const EXPECTED_TITLE = '价格翻倍合理吗'

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.bringToFront')
  stage('连接浏览器', 'passed', `CDP ${port}，页面 ${page.url.slice(0, 40)}`)

  /**
   * ## 直接读 HTTP 路由，不走界面
   *
   * 这一段的目的是**证明数据还在**，不是证明按钮还能点。走界面会引入另一个
   * 可能失败的东西（配置页要三跳、弹窗要关），而那不是这里要测的。
   *
   * 界面能不能回到可操作状态，下面单独断言一次。
   */
  const sessionsRaw = await evaluate<string>(`(async () => {
    const r = await fetch('/api/dsh-ai-debate/workbench')
    return await r.text()
  })()`)
  const latest = JSON.parse(sessionsRaw) as {
    ok?: boolean
    sessionId?: string
    threadTitle?: string
    platform?: string
    manualFlow?: {
      structure?: { comments?: { id: string; author: string; certainty?: string }[] }
      corrections?: { field: string; note: string }[]
      step?: string
    }
    candidates?: { replyId: string; approved?: boolean }[]
  }

  stage(
    '重启之后仍然读得到会话',
    latest.ok === true && typeof latest.sessionId === 'string' && latest.sessionId !== ''
      ? 'passed'
      : 'failed',
    latest.ok === true
      ? `sessionId=${latest.sessionId}，标题「${latest.threadTitle ?? '(空)'}」`
      : `读不到：${sessionsRaw.slice(0, 160)}`,
  )

  stage(
    '重启之后平台仍是 manual',
    latest.platform === 'manual' ? 'passed' : 'failed',
    `platform=${String(latest.platform)}（重启不该改变会话的平台）`,
  )

  /**
   * ## 按标题在**所有会话**里找，而不是只看「最新一条」
   *
   * 上一版断言的是「最新一条的标题是价格翻倍」，于是在负向脚本建了超长会话
   * 之后必然红——而那条完整走过的会话其实好好的。断言写错了对象：这里要证明的
   * 是「它还在」，不是「它是最后一条」。
   *
   * 工作台的 GET 只支持 `?sessionId=`，没有「按标题搜」。所以这里直接读磁盘上的
   * `state.json`——它就在文件系统上，而这个脚本本来就是 Node 进程。
   *
   * ## 这一步测的到底是什么
   *
   * 「进程换了一个，磁盘上的东西还在」。读文件比读路由更直接：它不依赖插件
   * 的路由实现，也不依赖 `latestSession()` 的选择规则。拿到 id 之后再去查一次
   * 路由，两件事就都验到了：盘上有，且读得出来。
   */
  const statePath = process.env.DSH_E2E_STORE_STATE ?? ''
  let diskSessions: { id: string; threadTitle?: string; platform?: string }[] = []
  if (statePath !== '') {
    try {
      const raw = readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw) as { sessions?: { id?: string; threadTitle?: string; platform?: string }[] }
      diskSessions = (parsed.sessions ?? [])
        .filter((entry): entry is { id: string; threadTitle?: string; platform?: string } =>
          typeof entry.id === 'string',
        )
    } catch (error) {
      stage('读取磁盘上的会话文件', 'failed', `读不到 ${statePath}：${(error as Error).message}`)
    }
  }
  const onDisk = diskSessions.filter((entry) => entry.threadTitle === EXPECTED_TITLE)
  stage(
    '那条完整走过的会话仍然在磁盘上',
    statePath === '' ? 'skipped' : onDisk.length > 0 ? 'passed' : 'failed',
    statePath === ''
      ? '没有配置 DSH_E2E_STORE_STATE'
      : onDisk.length === 0
        ? `磁盘上 ${diskSessions.length} 条会话，没有标题为「${EXPECTED_TITLE}」的（实际：${diskSessions
            .map((entry) => entry.threadTitle ?? '(空)')
            .slice(0, 4)
            .join(' / ')}）`
        : `磁盘上 ${diskSessions.length} 条会话，其中一条是「${EXPECTED_TITLE}」（${onDisk[0]!.id}）`,
  )

  /**
   * 磁盘上有，还要**读得出来**。
   *
   * 一条会话文件存在但路由读不到，对用户来说就是丢了。所以拿到 id 之后再走一次
   * `?sessionId=`，用真宿主去还原它。
   *
   * ## 后面所有断言都读这一条，不读「最新一条」
   *
   * 第一版这里读的是 `latest`，于是「修正清单活过了重启」被跳过——因为最新一条
   * 是负向脚本建的超长会话，它本来就没有修正。**断言的对象错了，得到的是一个
   * 看起来像「没测到」的结果**，而不是「产品有问题」。这一类误读的成本很高：
   * 它会让人以为测试覆盖了某件事。
   */
  let restored:
    | {
        ok?: boolean
        sessionId?: string
        threadTitle?: string
        manualFlow?: {
          structure?: { comments?: { id: string; author: string; certainty?: string }[] }
          corrections?: { field: string; note: string }[]
          step?: string
        }
        candidates?: { replyId: string; approved?: boolean }[]
      }
    | undefined
  if (onDisk.length > 0) {
    const byId = await evaluate<string>(`(async () => {
      const r = await fetch('/api/dsh-ai-debate/workbench?sessionId=${encodeURIComponent(String(onDisk[0]!.id))}')
      return await r.text()
    })()`)
    restored = JSON.parse(byId) as typeof restored
    stage(
      '重启之后按 id 仍然读得到那一条',
      restored?.ok === true && restored?.threadTitle === EXPECTED_TITLE ? 'passed' : 'failed',
      restored?.ok === true
        ? `标题「${restored.threadTitle}」，${(restored.manualFlow?.structure?.comments ?? []).length} 条发言，当前步骤「${restored.manualFlow?.step ?? '?'}」`
        : `读不到：${byId.slice(0, 160)}`,
    )
  } else {
    stage('重启之后按 id 仍然读得到那一条', 'skipped', '磁盘上没有这条会话')
  }

  /**
   * ## 修正必须活过重启
   *
   * 会话只存「原始解析 + 修正清单」，每次读取重新应用。重启之后读出来的结构
   * 如果少了修正，说明要么清单没落盘，要么应用过程依赖了内存里的东西。
   *
   * 负向脚本在 19/25 对这条会话做过一次 `manual-revise`（把 local:1 的回复目标
   * 改成 local:2）。所以这里**必须**有修正；如果一条都没有，那是负向脚本没跑到，
   * 而不是「产品允许没有修正」。
   */
  const corrections = restored?.manualFlow?.corrections ?? []
  stage(
    '修正清单活过了重启',
    corrections.length > 0 ? 'passed' : 'failed',
    corrections.length > 0
      ? `${corrections.length} 条：${corrections.map((entry) => entry.field).join('/')}`
      : '这条会话应当有修正（负向脚本 19/25 落过一条），重启之后读不到——修正丢了',
  )

  const structure = restored?.manualFlow?.structure
  const comments = structure?.comments ?? []
  stage(
    '重启之后结构仍然可读',
    comments.length > 0 ? 'passed' : 'failed',
    comments.length > 0
      ? `${comments.length} 条发言：${comments.slice(0, 3).map((c) => `${c.id}=${c.author}`).join(' ')}`
      : '结构是空的——会话在但内容读不出来，等于丢了',
  )

  /**
   * 修正真的生效了，不只是「有一份清单」。
   *
   * 这一条防的是「清单落盘了但没被应用」：那种情况下 `corrections` 非空，
   * 结构却还是改之前的样子，而前两条断言都会通过。
   */
  const revised = comments.find((comment) => comment.id === 'local:1')
  stage(
    '修正重放之后关系指向改后的目标',
    revised === undefined
      ? 'skipped'
      : revised.certainty === 'stated'
        ? 'passed'
        : 'failed',
    revised === undefined
      ? '结构里没有 local:1'
      : `local:1 certainty=${revised.certainty ?? '(无)'}（负向脚本把它改成了明确目标）`,
  )

  // 候选的确认状态不能被重启重置。
  const approved = (restored?.candidates ?? []).filter((entry) => entry.approved === true)
  stage(
    '候选的确认状态没有被重启重置',
    (restored?.candidates ?? []).length === 0 || approved.length > 0 ? 'passed' : 'failed',
    (restored?.candidates ?? []).length === 0
      ? '这条会话在被修正之后候选已作废（负向脚本的 19/25 就是这么设计的）'
      : `${approved.length}/${(restored?.candidates ?? []).length} 条仍是已确认`,
  )

  // 界面能不能回到可操作状态。这一条才是「用户重开之后能不能接着用」。
  await send('Page.reload')
  await sleep(2000)
  await send('Page.bringToFront')
  let booted = false
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const ready = await evaluate<boolean>(`(() => {
      const node = [...document.querySelectorAll('button, [role=tab], a')]
        .find((n) => (n.textContent || '').trim() === '插件')
      if (!node) return false
      const r = node.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })()`)
    if (ready) {
      booted = true
      break
    }
    await sleep(1000)
  }
  stage(
    '重启之后界面回到可操作状态',
    booted ? 'passed' : 'failed',
    booted ? '侧边栏「插件」可点' : '45 秒内没有可点的「插件」',
  )

  const hasPublishButton = await evaluate<boolean>(`(() => {
    const labels = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
    return labels.some((label) => /^(发表|发布|发送)$/.test(label))
  })()`)
  stage(
    '重启之后仍然没有发表入口',
    hasPublishButton ? 'failed' : 'passed',
    hasPublishButton ? '出现了发表按钮' : '只有复制，没有发表',
  )
  await screenshot('01-after-restart')
} catch (error) {
  stage('执行中断', 'failed', error instanceof Error ? error.message : String(error))
  try {
    await screenshot('99-crash')
  } catch {
    stage('失败截图', 'failed', '截图也失败了')
  }
}

finish()
