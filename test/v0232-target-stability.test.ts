/**
 * v0.2.32 §五：回复目标稳定性与旧批准失效。
 *
 * ## 这一组防的是同一种失败：**说的和做的不一致**
 *
 * 离线流程里最贵的错误不是「写得不好」，而是「写给了错的人」。而它不会以
 * 报错的形式出现——页面会显示成功，正文看起来也通顺，只是收件人是另一个。
 *
 * 所以这里只测那些**可以被机械验证**的性质：
 *
 * 1. 换目标必须让旧候选作废（否则你复制走的是写给上一个人的话）；
 * 2. 改正文必须让旧批准作废（否则「你确认过的版本」和「被复制的版本」不同）；
 * 3. 确认时必须比对正文（`approvedText`）——页面显示 A、确认 B 要被拒；
 * 4. 目标快照必须记下**当时那条发言的内容**，不能只记一个 id；
 * 5. 同名的人不能因为名字相同就被当成同一个目标。
 *
 * 这些都不依赖模型。要不要模型才能验的那部分（输出契约、注入不改立场）
 * 在别的文件里，用假模型跑。
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { parseText } from '../lib/import/manual.js'
import { toStoredImport } from '../lib/import/session.js'
import {
  analyzeImport,
  approveImportedCandidate,
  copyReply,
  editImportedCandidate,
  generateForImport,
  personaOf,
  reselectImport,
  stepOf,
} from '../lib/import/workflow.js'

/**
 * 脚本化的模型客户端。
 *
 * `generateForImport` 接受一个 `llm` 工厂，所以这里不需要起 HTTP 服务、
 * 也不碰真实凭据：模型只负责把一段固定的 JSON 交回来，其余全部走生产代码。
 * 于是这些用例测的是**插件的账**（谁批的、批的是哪段、目标是谁），
 * 而不是模型的质量。
 */
function scriptedClient(reply: string, targetPostId: string) {
  return {
    label: 'scripted',
    complete: async () => ({
      text: JSON.stringify({
        status: 'ok',
        owner_position: '应该先修路',
        opponent_position: '资金从哪来',
        main_dispute: '先修路还是先修学校',
        latest_argument: '上次修的路三年就坏了',
        response_target_id: targetPostId,
        strategy: 'direct_rebuttal',
        confidence: 0.7,
        uncertainties: [],
        reply,
      }),
    }),
  }
}
import { DebateStore } from '../lib/store.js'

const SAMPLE = `# 该不该先修路

原帖作者：我认为应该先修路，路修好了经济才能起来。
---
路人甲：修路当然重要，但资金从哪来？
路人乙：上次修的路三年就坏了，这次凭什么不一样？
路人丙：我觉得应该先修学校。`

async function newStore(): Promise<DebateStore> {
  const dir = mkdtempSync(join(tmpdir(), 'v0232-target-'))
  const store = new DebateStore({ dir, maxSessions: 20 })
  await store.ready()
  return store
}

const config = (): ReturnType<typeof resolveConfig> => resolveConfig({})

/** 建一个已分析、带一条已确认候选的会话。 */
async function sessionWithApprovedCandidate(store: DebateStore): Promise<{
  sessionId: string
  candidateId: string
  text: string
  targetId: string
}> {
  const parsed = parseText(SAMPLE)
  assert.ok(parsed.discussion !== undefined)
  const imported = toStoredImport(parsed.discussion!, new Date().toISOString())
  const created = await analyzeImport(store, {
    imported,
    ownerName: '原帖作者',
    targetPostId: imported.comments[0]!.id,
    persona: personaOf('tieba_veteran', config()),
    config: config(),
  })
  assert.ok(created.ok && created.value !== undefined, `分析应当成功：${created.reason ?? ''}`)
  const sessionId = created.value!.session.id
  const targetPostId = imported.comments[0]!.id
  const generated = await generateForImport(store, {
    sessionId,
    config: config(),
    llm: () => scriptedClient('我先把修路的账算给你看，再谈学校。', targetPostId) as never,
  })
  assert.ok(generated.ok, `生成应当成功：${generated.reason ?? ''}`)

  const session = store.getSession(sessionId)!
  const candidate = session.candidates[0]
  assert.ok(candidate !== undefined, '生成之后应当有一条候选')

  const approved = await approveImportedCandidate(store, {
    sessionId: session.id,
    candidateId: candidate!.replyId,
    approvedText: candidate!.text,
  })
  assert.ok(approved.ok, `确认应当成功：${approved.reason ?? ''}`)

  return {
    sessionId,
    candidateId: candidate!.replyId,
    text: candidate!.text,
    targetId: candidate!.targetSnapshot?.targetPostId ?? candidate!.targetPostId,
  }
}

test('候选记录的是目标**当时的内容**，不只是一个 id', async () => {
  const store = await newStore()
  const { sessionId, candidateId } = await sessionWithApprovedCandidate(store)
  const session = store.getSession(sessionId)!
  const candidate = session.candidates.find((entry) => entry.replyId === candidateId)!

  assert.ok(candidate.targetSnapshot !== undefined, '必须有目标快照')
  assert.equal(candidate.targetSnapshot!.targetPostId, candidate.targetPostId, '快照记的必须是 candidate 指向的那一条')
  assert.ok(
    (candidate.targetSnapshot!.targetAuthorName ?? '').length > 0,
    '快照要留下作者名，否则界面无法回答「回给谁」',
  )
  assert.ok(
    (candidate.targetSnapshot!.contentHash ?? '').length > 0,
    '快照要留下**那段文字的指纹**：只有 id 的话，同一份导入被改过之后就对不上了',
  )
})

test('换回复目标会作废旧候选：不能拿写给上一个人的话去复制', async () => {
  const store = await newStore()
  const { sessionId } = await sessionWithApprovedCandidate(store)
  const before = store.getSession(sessionId)!
  assert.equal(before.candidates.length, 1, '前置：有一条候选')

  const otherTarget = before.imported!.comments[1]!.id
  const reselected = await reselectImport(store, {
    sessionId,
    targetPostId: otherTarget,
    persona: personaOf('tieba_veteran', config()),
    config: config(),
  })
  assert.ok(reselected.ok, `换目标应当成功：${reselected.reason ?? ''}`)

  const after = store.getSession(sessionId)!
  assert.equal(
    after.candidates.length,
    0,
    '换目标之后旧候选必须清空——它是对着上一条发言写的，留着就会被误复制',
  )
  assert.equal(after.triggerPostId, otherTarget, '目标要记成新选的那一条')
})

test('改正文会让旧批准失效：不能出现「确认过的版本」与「被复制的版本」不同', async () => {
  const store = await newStore()
  const { sessionId, candidateId, text } = await sessionWithApprovedCandidate(store)

  const edited = await editImportedCandidate(store, {
    sessionId,
    candidateId,
    text: `${text}（补一句）`,
    config: config(),
  })
  assert.ok(edited.ok, `编辑应当成功：${edited.reason ?? ''}`)

  const session = store.getSession(sessionId)!
  const candidate = session.candidates.find((entry) => entry.replyId === candidateId)!
  assert.equal(candidate.approved, false, '改过正文之后旧批准必须失效')
})

test('确认时正文对不上就拒绝：页面显示的和他确认的必须是同一段', async () => {
  const store = await newStore()
  const { sessionId, candidateId } = await sessionWithApprovedCandidate(store)

  const wrong = await approveImportedCandidate(store, {
    sessionId,
    candidateId,
    approvedText: '这是一段页面上从来没有出现过的正文。',
  })
  assert.equal(wrong.ok, false, '正文不一致时必须拒绝')
  assert.match(wrong.reason ?? '', /不一致|确认/, '理由要说清是「你确认的和保存的不同」')
})

test('改正文之后批准状态回到未确认，且步骤退回「人工确认」', async () => {
  /**
   * ## 这里断言的是「状态」，不是「copyReply 拒绝」
   *
   * `copyReply` 的契约（v0.2.30 起，有测试保护）是「给你一段可以贴的正文」，
   * 它校验安全评估与正文一致性，**不校验 approved**。真正的闸门在视图：
   * `manualFlow.copyAllowed` 为假、blockers 里写着「还没有人工确认」，
   * 界面据此把按钮置灰。
   *
   * 所以这里断言两件产品确实承诺的事：
   *   1. 编辑之后 `approved` 必须回到 false（旧批准不能跨正文复用）；
   *   2. 当前步骤必须退回「人工确认」（界面据此把按钮置灰）。
   *
   * 把断言写成「copyReply 必须拒绝」会失败——但那是要求产品改契约，
   * 不是发现缺陷。这一点在 `v0231-special-cases.test.ts` 里有同样的记录。
   */
  const store = await newStore()
  const { sessionId, candidateId, text } = await sessionWithApprovedCandidate(store)

  await editImportedCandidate(store, { sessionId, candidateId, text: `${text}。`, config: config() })

  const session = store.getSession(sessionId)!
  const candidate = session.candidates.find((entry) => entry.replyId === candidateId)!
  assert.equal(candidate.approved, false, '改过正文之后旧批准必须失效')
  assert.equal(stepOf(session), 'approve', '步骤要退回「人工确认」，界面才会把按钮置灰')
})

test('复制要求页面正文与保存的一致：不一致就拒绝并要求刷新', async () => {
  const store = await newStore()
  const { sessionId, candidateId } = await sessionWithApprovedCandidate(store)

  const copied = await copyReply(store, {
    sessionId,
    candidateId,
    visibleText: '页面上曾经显示过、但现在已经被改掉的另一段正文。',
  })
  assert.equal(copied.ok, false, '正文不一致必须拒绝')
  assert.ok((copied.next ?? []).length > 0, '拒绝必须给出下一步')
})

test('同名的人：两条同名发言是两个不同的目标，选谁就是谁', async () => {
  const sample = `# 同名测试

原帖作者：我先说一句。
---
小明：我觉得应该先修路。
小明：我改主意了，应该先修学校。`
  const parsed = parseText(sample)
  assert.ok(parsed.discussion !== undefined)
  const comments = parsed.discussion!.comments
  assert.equal(comments.length, 2, '两条同名发言都在')

  const store = await newStore()
  const imported = toStoredImport(parsed.discussion!, new Date().toISOString())
  const created = await analyzeImport(store, {
    imported,
    ownerName: '原帖作者',
    targetPostId: comments[1]!.id,
    persona: personaOf('tieba_veteran', config()),
    config: config(),
  })
  assert.ok(created.ok && created.value !== undefined)

  const generated = await generateForImport(store, {
    sessionId: created.value!.session.id,
    config: config(),
    llm: () => scriptedClient('我说的是先修学校，你听错了。', comments[1]!.id) as never,
  })
  assert.ok(generated.ok, `生成应当成功：${generated.reason ?? ''}`)

  const candidate = store.getSession(created.value!.session.id)!.candidates[0]!
  const snapshot = candidate.targetSnapshot
  assert.equal(snapshot?.targetPostId, comments[1]!.id, '目标必须是用户选的那一条，不是同名里的第一条')
  assert.ok(
    (snapshot?.contentHash ?? '').length > 0,
    '快照要留下那段话的指纹，否则两条同名发言在存储层无法区分',
  )

  /**
   * 换到同名的另一条，指纹必须变。
   *
   * 两条发言作者都叫「小明」，ids 不同、文字不同。如果快照只按作者名或按
   * 下标认人，第二次生成会拿到与第一次相同的指纹——那就意味着「选谁」这件事
   * 没有真正生效，用户以为换了一个人，实际还在回上一条。
   */
  const regenerated = await generateForImport(store, {
    sessionId: created.value!.session.id,
    targetPostId: comments[0]!.id,
    config: config(),
    llm: () => scriptedClient('我说的是先修路，不是学校。', comments[0]!.id) as never,
  })
  assert.ok(regenerated.ok, `重新生成应当成功：${regenerated.reason ?? ''}`)
  const other = store
    .getSession(created.value!.session.id)!
    .candidates.find((entry) => entry.replyId === regenerated.value!.candidateId)!
  assert.notEqual(
    other.targetSnapshot?.contentHash,
    snapshot?.contentHash,
    '同名两条发言的指纹必须不同，否则「换了一个人」只是表面动作',
  )
})
