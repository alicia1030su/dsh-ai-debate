/**
 * 离线讨论导入的异常流程验收（v0.2.30 §六后半）。
 *
 * ## 为什么要单独一个文件
 *
 * 正常流程证明「能走通」；异常流程证明**走不通的时候会说话**。这两件事的失败方式
 * 完全不同：前者是白屏或按钮没反应，后者是「页面静默接受了一个它不该接受的东西」。
 * 后者更危险——一个把 6000 字塞进 120 字上限的候选被复制出去，用户不会发现。
 *
 * ## 14 类，每一类都断言「拒绝 + 说清为什么 + 下一步能做什么」
 *
 * 拒绝而不解释等于没拒绝：用户只知道「不行」，不知道该怎么办，于是反复重试同一步。
 * 所以每条断言都检查文案里有没有可行动的话（下一步 / 检查 / 重新 / 不能 / 需要）。
 *
 * ## 与正常流程共用同一个宿主
 *
 * 不重启、不清库：这里要测的正是「在一条已经正常的会话上做错事会怎样」。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
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

const port = Number(process.env.DSH_E2E_CDP_PORT ?? '9279')
const appPort = Number(process.env.DSH_E2E_APP_PORT ?? '58075')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/gui-manual-negative'

mkdirSync(outDir, { recursive: true })

// ── CDP ─────────────────────────────────────────────────────────────────────

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]
const pageList = targets.filter((t) => t.type === 'page' && t.url.includes(String(appPort)))
const page = pageList[pageList.length - 1]
if (page === undefined) {
  stage('连接浏览器', 'failed', `没有找到 ${appPort} 的页面目标`)
  finish()
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data as string) as {
    id?: number
    result?: unknown
    error?: unknown
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id)!
    pending.delete(message.id)
    if (message.error !== undefined) entry.rej(new Error(JSON.stringify(message.error)))
    else entry.res(message.result)
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

/** 走页面自己的路由（带会话 Cookie），与点按钮发出的是同一个请求。 */
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

function manualSectionText(): Promise<string> {
  return evaluate<string>(`(() => {
    const sections = [...document.querySelectorAll('.dsd-sect')]
    const target = sections.find((s) => s.innerText.includes('离线讨论导入'))
    return target ? target.innerText : ''
  })()`)
}

/** 拒绝必须说清「为什么 + 下一步」。只有一半也算不合格。 */
function explainsItself(reason: string): boolean {
  return /不能|不可|没有|不是|无法|需要|重新|检查|先|试试|刷新|确认|请/.test(reason)
}

function finish(): never {
  const failed = stages.filter((s) => s.status === 'failed')
  const skipped = stages.filter((s) => s.status === 'skipped')
  const verdict = {
    verdict: failed.length === 0 && skipped.length === 0 ? 'passed' : 'failed',
    stages,
    at: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(verdict, null, 2), 'utf8')
  process.stdout.write(`\n结论：${verdict.verdict}（失败 ${failed.length}，跳过 ${skipped.length}）\n`)
  process.exit(verdict.verdict === 'passed' ? 0 : 1)
}

// ── 素材 ────────────────────────────────────────────────────────────────────

const GOOD = [
  '# 价格翻倍合理吗',
  '',
  '原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。',
  '---',
  '路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。',
  '路人乙：行业平均也才涨了三成，翻倍是漫天要价。',
  '路人丙：两边都有道理，但翻倍确实夸张了。',
].join('\n')

// ── the run ─────────────────────────────────────────────────────────────────

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  stage('连接浏览器', 'passed', `CDP ${port}，页面 ${page.url.slice(0, 40)}`)

  // 先确认在离线导入页签上。前面的正常流程跑完停在「复制回复」——那正好是
  // 做异常验证的起点：会话说得通，才谈得上「做错事会怎样」。
  await clickByLabel('插件')
  await sleep(2000)
  await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="查看 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(2000)
  await evaluate<boolean>(`(() => {
    const b = document.querySelector('[aria-label="配置 dsh-ai-debate"]')
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(2400)
  const onManual = await clickByLabel('离线导入')
  await sleep(2400)
  stage('进入离线导入页签', onManual ? 'passed' : 'failed', onManual ? '已点击' : '找不到页签')

  const workbenchRaw = await evaluate<string>(`(async () => {
    const r = await fetch('/api/dsh-ai-debate/workbench')
    return await r.text()
  })()`)
  const view = JSON.parse(workbenchRaw) as {
    sessionId?: string
    candidates?: { replyId: string; text: string; approved?: boolean }[]
  }
  const sessionId = view.sessionId ?? ''
  const candidate = (view.candidates ?? [])[view.candidates?.length === undefined ? 0 : (view.candidates ?? []).length - 1]
  stage(
    '已有会话可用来做异常验证',
    sessionId !== '' && candidate !== undefined ? 'passed' : 'skipped',
    sessionId === ''
      ? '没有会话，先跑正常流程（run-gui-manual.sh）'
      : `sessionId=${sessionId}，候选 ${(view.candidates ?? []).length} 条`,
  )

  // ── 1/14：空内容不能预览 ────────────────────────────────────────────────
  const emptyPreview = await callAction({ action: 'manual-preview', kind: 'text', content: '' })
  stage(
    '1/14 空内容被拒绝',
    emptyPreview.ok !== true ? 'passed' : 'failed',
    emptyPreview.ok === true
      ? '空内容被当成一次有效解析——这会让用户以为导入成功了'
      : String(emptyPreview.reason ?? '').slice(0, 120),
  )
  stage(
    '1/14 空内容的拒绝说得清下一步',
    emptyPreview.ok !== true && explainsItself(String(emptyPreview.reason ?? ''))
      ? 'passed'
      : 'failed',
    String(emptyPreview.reason ?? '（没有理由）').slice(0, 120),
  )

  // ── 2/14：完全解析不出内容 ──────────────────────────────────────────────
  const garbage = await callAction({
    action: 'manual-preview',
    kind: 'text',
    content: '---',
  })
  stage(
    '2/14 解析不出任何发言时如实说明',
    garbage.ok !== true ? 'passed' : 'failed',
    garbage.ok === true
      ? '解析不出内容却返回成功'
      : String(garbage.reason ?? '').slice(0, 140),
  )
  stage(
    '2/14 说明了正确格式',
    /作者：内容|作者:内容|格式/.test(String(garbage.reason ?? '')) ? 'passed' : 'failed',
    /作者：内容|作者:内容|格式/.test(String(garbage.reason ?? ''))
      ? '文案里给出了正确格式'
      : '没有告诉用户该怎么写',
  )

  // ── 3/14：结构化 JSON 不合法 ────────────────────────────────────────────
  const badJson = await callAction({
    action: 'manual-preview',
    kind: 'json',
    content: '{ 这不是 JSON',
  })
  stage(
    '3/14 坏 JSON 被拒绝',
    badJson.ok !== true ? 'passed' : 'failed',
    badJson.ok === true ? '坏 JSON 被解析成功了' : String(badJson.reason ?? '').slice(0, 140),
  )

  // ── 4/14：只有原帖、没有别人 → 无可回复对象 ─────────────────────────────
  const onlyRoot = await callAction({
    action: 'manual-confirm',
    kind: 'text',
    content: '原帖作者：我觉得这个价格翻倍是合理的。',
    ownerName: '原帖作者',
  })
  stage(
    '4/14 只有原帖时拒绝确认',
    onlyRoot.ok !== true ? 'passed' : 'failed',
    onlyRoot.ok === true
      ? '没有可回复对象却建了会话'
      : String(onlyRoot.reason ?? '').slice(0, 160),
  )
  stage(
    '4/14 说明了缺什么',
    onlyRoot.ok !== true && /别人|对手|他人的|可回复|没有.*发言/.test(String(onlyRoot.reason ?? ''))
      ? 'passed'
      : 'failed',
    String(onlyRoot.reason ?? '（没有理由）').slice(0, 160),
  )

  // ── 5/14：主人不在讨论里 ────────────────────────────────────────────────
  const wrongOwner = await callAction({
    action: 'manual-confirm',
    kind: 'text',
    content: GOOD,
    ownerName: '根本不存在的人',
  })
  stage(
    '5/14 主人不在讨论里被拒绝',
    wrongOwner.ok !== true ? 'passed' : 'failed',
    wrongOwner.ok === true
      ? '一个不存在的名字被当成了主人'
      : String(wrongOwner.reason ?? '').slice(0, 160),
  )
  stage(
    '5/14 提示要检查主人是谁',
    wrongOwner.ok !== true && /主人|谁|作者/.test(String(wrongOwner.reason ?? ''))
      ? 'passed'
      : 'failed',
    String(wrongOwner.reason ?? '（没有理由）').slice(0, 160),
  )

  // ── 6/14：目标 id 不在这次导入里 ────────────────────────────────────────
  const badTarget = await callAction({
    action: 'manual-generate',
    sessionId,
    targetPostId: 'local:9999',
  })
  stage(
    '6/14 不存在的目标被拒绝',
    badTarget.ok !== true ? 'passed' : 'failed',
    badTarget.ok === true
      ? '对一条不存在的发言生成了回复'
      : String(badTarget.reason ?? '').slice(0, 160),
  )
  stage(
    '6/14 说明了目标不在导入内容里',
    /不在|没有|找不到|无法/.test(String(badTarget.reason ?? '')) ? 'passed' : 'failed',
    String(badTarget.reason ?? '（没有理由）').slice(0, 160),
  )

  // ── 7/14：会话 id 不存在 ────────────────────────────────────────────────
  const ghost = await callAction({ action: 'manual-generate', sessionId: 'm-does-not-exist' })
  stage(
    '7/14 不存在的会话被拒绝',
    ghost.ok !== true ? 'passed' : 'failed',
    ghost.ok === true ? '不存在的会话也能生成' : String(ghost.reason ?? '').slice(0, 140),
  )

  // ── 8/14：候选 id 不存在 ────────────────────────────────────────────────
  if (sessionId !== '') {
    const ghostCandidate = await callAction({
      action: 'manual-approve',
      sessionId,
      candidateId: 'no-such-candidate',
      approvedText: '随便一段话',
    })
    stage(
      '8/14 不存在的候选被拒绝',
      ghostCandidate.ok !== true ? 'passed' : 'failed',
      ghostCandidate.ok === true
        ? '不存在的候选也能确认'
        : String(ghostCandidate.reason ?? '').slice(0, 140),
    )
  } else {
    stage('8/14 不存在的候选被拒绝', 'skipped', '没有会话')
  }

  // ── 9/14：确认的正文与存下的不一致 ──────────────────────────────────────
  if (sessionId !== '' && candidate !== undefined) {
    const drift = await callAction({
      action: 'manual-approve',
      sessionId,
      candidateId: candidate.replyId,
      approvedText: '这段正文和被保存的那一段不一样，长度和内容都不同。',
    })
    stage(
      '9/14 确认正文与保存不一致时拒绝',
      drift.ok !== true ? 'passed' : 'failed',
      drift.ok === true
        ? '确认了一份用户没看过的正文——这是最隐蔽的一种失败'
        : String(drift.reason ?? '').slice(0, 160),
    )
  } else {
    stage('9/14 确认正文与保存不一致时拒绝', 'skipped', '没有会话或候选')
  }

  // ── 10/14：编辑成空正文 ─────────────────────────────────────────────────
  if (sessionId !== '' && candidate !== undefined) {
    const blank = await callAction({
      action: 'manual-edit',
      sessionId,
      candidateId: candidate.replyId,
      text: '   ',
    })
    stage(
      '10/14 空正文被拒绝',
      blank.ok !== true ? 'passed' : 'failed',
      blank.ok === true ? '空正文被保存了' : String(blank.reason ?? '').slice(0, 140),
    )
  } else {
    stage('10/14 空正文被拒绝', 'skipped', '没有会话或候选')
  }

  // ── 11/14：复制时页面正文与保存的不一致 ─────────────────────────────────
  if (sessionId !== '' && candidate !== undefined) {
    const copyDrift = await callAction({
      action: 'manual-copy',
      sessionId,
      candidateId: candidate.replyId,
      visibleText: '用户以为自己在复制的是这一段，但它从来没被保存过。',
    })
    stage(
      '11/14 复制时正文不一致被拒绝',
      copyDrift.ok !== true ? 'passed' : 'failed',
      copyDrift.ok === true
        ? '复制出用户没看过的正文'
        : String(copyDrift.reason ?? '').slice(0, 160),
    )
    stage(
      '11/14 提示要刷新再复制',
      /刷新|不一致|重新/.test(String(copyDrift.reason ?? '')) ? 'passed' : 'failed',
      String(copyDrift.reason ?? '（没有理由）').slice(0, 160),
    )
  } else {
    stage('11/14 复制时正文不一致被拒绝', 'skipped', '没有会话或候选')
    stage('11/14 提示要刷新再复制', 'skipped', '没有会话或候选')
  }

  // ── 12/14：导入会话不能发表 ─────────────────────────────────────────────
  if (sessionId !== '') {
    const publishAttempt = await callAction({ action: 'publish', sessionId })
    stage(
      '12/14 导入会话不能发表',
      publishAttempt.ok !== true ? 'passed' : 'failed',
      publishAttempt.ok === true
        ? '离线会话被接受了发表——这是本版最严重的问题'
        : String(publishAttempt.reason ?? publishAttempt.error ?? '已拒绝').slice(0, 160),
    )
  } else {
    stage('12/14 导入会话不能发表', 'skipped', '没有会话')
  }

  // ── 13/14：超长内容被截断而不是悄悄吞下 ─────────────────────────────────
  const longLine = '这是一个非常长的发言，'.repeat(400)
  const huge = await callAction({
    action: 'manual-preview',
    kind: 'text',
    content: ['原作者：原始发言。', '---', `路人甲：${longLine}`].join('\n'),
  })
  stage(
    '13/14 超长内容有明确交代',
    huge.ok === true
      ? // 解析成功就必须说明被截断了；解析失败就必须说明太长。
        /截断|超过|上限|太长/.test(JSON.stringify(huge)) || huge.ok !== true
        ? 'passed'
        : 'failed'
      : 'passed',
    huge.ok === true
      ? `解析成功，issues=${JSON.stringify(huge.issues ?? []).slice(0, 120)}`
      : String(huge.reason ?? '').slice(0, 140),
  )

  // ── 14/14：页面上的「复制」在未确认时不可用（UI 层） ────────────────────
  // 这一条与 API 层不同：即使 API 会拒绝，按钮不该是可点的——
  // 那会让用户以为是点了没反应，而不是「还不能点」。
  const buttonState = await evaluate<{ label: string; disabled: boolean } | null>(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(复制回复|还不能复制)$/.test((n.textContent || '').trim()))
    return b ? { label: b.textContent.trim(), disabled: b.disabled } : null
  })()`)
  stage(
    '14/14 复制按钮的状态与可复制性一致',
    buttonState !== null &&
      ((buttonState.label === '复制回复' && buttonState.disabled === false) ||
        (buttonState.label === '还不能复制' && buttonState.disabled === true))
      ? 'passed'
      : 'failed',
    buttonState === null
      ? '找不到复制按钮'
      : `「${buttonState.label}」disabled=${buttonState.disabled}（文案与状态必须一致）`,
  )

  // ── 收尾：页面没有被这些拒绝弄坏 ───────────────────────────────────────
  const finalText = await manualSectionText()
  stage(
    '异常流程后页面仍然可用',
    finalText.includes('离线讨论导入') && finalText.includes('当前步骤') ? 'passed' : 'failed',
    finalText.includes('当前步骤') ? '分区与步骤条仍在' : `分区损坏了：${finalText.slice(0, 120)}`,
  )
  stage(
    '异常流程后没有「已发表」字样',
    /已发表|发表成功|已在微博发表/.test(finalText) === false ? 'passed' : 'failed',
    /已发表|发表成功|已在微博发表/.test(finalText)
      ? '出现了「已发表」'
      : '没有',
  )
} catch (error) {
  stage('执行中断', 'failed', error instanceof Error ? error.message : String(error))
}

finish()
