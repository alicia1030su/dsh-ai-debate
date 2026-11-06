/**
 * v0.2.30 §二：完整离线工作流（导入→预览→确认→分析→选中→人格→生成→编辑→安全评估→人工确认→复制）。
 *
 * ## 这个文件在防什么
 *
 * 1. **「已经在微博发表成功」这句话**。整条链路里不存在一个能成功发表的调用：
 *    平台是 `manual`（注册表没有它）、`runPublish` 对导入会话直接拒绝、
 *    `copyReply` 只返回文本。任何一处出现「已发表」都是伪造。
 * 2. **绕过安全评估的复制**。复制前必须看得到：这是哪家的评估、通过了没、
 *    连同被标 `review` 的原因。评估被 `block` 时 `safe` 为假且 blockers 非空。
 * 3. **复制了没看过的正文**。`copyReply` 比对 `visibleText`，不一致就拒绝——
 *    用户看到的是 A、复制走的是 B，是这个流程最隐蔽的一种失败。
 * 4. **四个只是名字不同的「人格」**。这里直接从 `PERSONAS` 生成选项，
 *    并断言四种的 id、name、approach 都不相同。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'
import { PERSONAS } from '../lib/persona.js'
import { parseText } from '../lib/import/manual.js'
import { toStoredImport } from '../lib/import/session.js'
import {
  STEP_TITLES,
  analyzeImport,
  approveImportedCandidate,
  completedSteps,
  copyReply,
  editImportedCandidate,
  generateForImport,
  personaOf,
  personaOptions,
  reselectImport,
  stepOf,
} from '../lib/import/workflow.js'
import { runPublish } from '../lib/runtime.js'

const SAMPLE = `# 价格翻倍合理吗

原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。
---
路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。
路人乙：行业平均也才涨了三成，翻倍是漫天要价。
路人丙：两边都有道理，但翻倍确实夸张了。`

function configOf(overrides: Record<string, unknown> = {}) {
  return resolveConfig({ ...overrides })
}

async function newStore(): Promise<DebateStore> {
  const dir = mkdtempSync(join(tmpdir(), 'v0230-'))
  const store = new DebateStore({ dir, maxSessions: 20 })
  await store.ready()
  return store
}

function importedOf(text: string = SAMPLE) {
  const parsed = parseText(text)
  assert.ok(parsed.discussion !== undefined, '测试素材必须能解析')
  return toStoredImport(parsed.discussion, new Date('2026-11-06T00:00:00Z').toISOString())
}

/** 一个只按固定 JSON 回话的模型客户端。 */
function scriptedClient(reply: string, targetPostId: string) {
  return {
    label: 'scripted',
    complete: async () => ({
      text: JSON.stringify({
        status: 'ok',
        owner_position: '价格翻倍是合理的',
        opponent_position: '翻倍是漫天要价',
        main_dispute: '涨幅是否合理',
        latest_argument: '行业平均才涨三成',
        response_target_id: targetPostId,
        strategy: 'direct_rebuttal',
        confidence: 0.7,
        uncertainties: [],
        reply,
      }),
    }),
  }
}

// ---------------------------------------------------------------------------
// 十一步全链路
// ---------------------------------------------------------------------------

test('链路 1：十一步都有中文名，顺序即流程', () => {
  const steps = Object.keys(STEP_TITLES)
  assert.deepEqual(steps, [
    'import',
    'preview',
    'confirm',
    'analyze',
    'select',
    'persona',
    'generate',
    'edit',
    'assess',
    'approve',
    'copy',
  ])
  for (const [id, title] of Object.entries(STEP_TITLES)) {
    assert.ok(title.length > 0, `${id} 缺中文名`)
  }
})

test('链路 2：四种人格全部可选，且互不相同', () => {
  const options = personaOptions()
  assert.equal(options.length, 4)
  assert.deepEqual(
    options.map((option) => option.id).sort(),
    Object.keys(PERSONAS).sort(),
  )
  // 名字与说明必须真的有区别，否则「四种人格」只是四个按钮。
  assert.equal(new Set(options.map((option) => option.name)).size, 4)
  assert.equal(new Set(options.map((option) => option.approach)).size, 4)
  for (const option of options) {
    assert.ok(option.summary.length > 0)
  }
})

test('链路 3：未知人格被拒绝，并列出可选值', () => {
  assert.throws(
    () => personaOf('does_not_exist', configOf()),
    /未知的人格.*tieba_veteran/s,
  )
})

test('链路 4：分析之后会话落在 ANALYZING，不是 READY', async () => {
  const store = await newStore()
  const result = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', configOf()),
    config: configOf(),
  })
  assert.equal(result.ok, true, result.reason)
  const session = result.value!.session
  assert.equal(session.platform, 'manual')
  assert.equal(session.state, 'ANALYZING', '离线会话不该是可发表状态')
  assert.equal(session.imported !== undefined, true, '导入内容必须落盘')
  assert.equal(session.ownerIdentityAssurance, 'unverified', '昵称匹配永远不是核验')
  assert.equal(session.candidates.length, 0)
})

test('链路 5：生成产出候选，决策来自真实安全评估', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id

  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () =>
      scriptedClient(
        '你说行业平均只涨三成，那我问你，三成是按谁的口径算的？先把口径说清楚再谈翻倍。',
        'local:1',
      ) as never,
  })
  assert.equal(generated.ok, true, generated.reason)
  const output = generated.value!
  assert.ok(output.text.length > 0)
  assert.equal(output.version, 1)
  assert.ok(
    ['allow', 'review', 'block'].includes(output.securityDecision),
    `安全决策应当是三种之一，实际 ${output.securityDecision}`,
  )

  const session = store.getSession(sessionId)!
  assert.equal(session.candidates.length, 1)
  assert.equal(session.candidates[0].approved, false, '生成不等于确认')
})

test('链路 6：复制前可以看到目标与人格，且只返回文本', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tsundere', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('你先把口径说清楚：三成是按谁算的？', 'local:1') as never,
  })
  const candidateId = generated.value!.candidateId

  const copied = await copyReply(store, { sessionId, candidateId })
  assert.equal(copied.ok, true, copied.reason)
  const value = copied.value!
  assert.equal(value.text, generated.value!.text)
  assert.equal(value.target.postId, 'local:1')
  assert.ok(value.target.excerpt.length > 0, '复制前必须看得见这是回给哪句话的')
  assert.equal(value.persona, PERSONAS.tsundere.name)
  // 返回值里没有「发表」相关字段——这不是遗漏。
  assert.equal('publish' in value, false)
  assert.equal('postId' in value, false)
})

test('链路 7：人工确认必须对得上正文，改过就拒绝', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('aloof', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('口径不说清楚，翻倍这个说法就站不住。', 'local:1') as never,
  })
  const candidateId = generated.value!.candidateId

  const wrong = await approveImportedCandidate(store, {
    sessionId,
    candidateId,
    approvedText: '完全不同的另一段话',
  })
  assert.equal(wrong.ok, false)
  assert.match(wrong.reason!, /不一致|刷新/)

  const ok = await approveImportedCandidate(store, {
    sessionId,
    candidateId,
    approvedText: generated.value!.text,
  })
  assert.equal(ok.ok, true, ok.reason)
  assert.equal(store.getSession(sessionId)!.candidates[0].approved, true)
})

test('链路 8：编辑正文后版本递增、批准失效、评估重跑', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('先说口径。', 'local:1') as never,
  })
  const candidateId = generated.value!.candidateId
  await approveImportedCandidate(store, {
    sessionId,
    candidateId,
    approvedText: generated.value!.text,
  })

  const edited = await editImportedCandidate(store, {
    sessionId,
    candidateId,
    text: '你先把口径说清楚：三成是按谁算的？说清楚了再谈翻倍。',
    config,
  })
  assert.equal(edited.ok, true, edited.reason)
  assert.equal(edited.value!.candidateVersion, 2)

  const after = store.getSession(sessionId)!.candidates[0]
  assert.equal(after.approved, false, '改过正文之后旧批准必须失效')
  assert.notEqual(after.security, undefined, '编辑之后必须重新评估，不能留空')
  assert.equal(after.textHash, edited.value!.textHash)
})

test('链路 9：复制时正文明细对不上就拒绝——防「看 A 复制 B」', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('口径。', 'local:1') as never,
  })
  const copied = await copyReply(store, {
    sessionId,
    candidateId: generated.value!.candidateId,
    visibleText: '页面上显示的却是另一段',
  })
  assert.equal(copied.ok, false)
  assert.match(copied.reason!, /不一致|刷新/)
})

test('链路 10：stepOf 从存下来的事实推导，不存 step 字段', async () => {
  const store = await newStore()
  const config = configOf()
  assert.equal(stepOf(undefined), 'import')

  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  assert.equal(stepOf(store.getSession(sessionId)), 'generate')

  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('先说口径。', 'local:1') as never,
  })
  assert.equal(stepOf(store.getSession(sessionId)), 'approve')

  await approveImportedCandidate(store, {
    sessionId,
    candidateId: generated.value!.candidateId,
    approvedText: generated.value!.text,
  })
  assert.equal(stepOf(store.getSession(sessionId)), 'copy')

  // 已完成的步骤是前缀，不是集合：页面按顺序画，中间不能有洞。
  const done = completedSteps(store.getSession(sessionId))
  assert.deepEqual(done, ['import', 'preview', 'confirm', 'analyze', 'select', 'persona', 'generate', 'edit', 'assess', 'approve'])
})

// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------

test('边界 1：导入会话调用 runPublish 被直接拒绝，且没有适配器被取到', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('先说口径。', 'local:1') as never,
  })

  // 一个「没有注册中心」的 Runtime：如果 `runPublish` 不先看 `imported`，
  // 它会退回到 `runtime.adapter`（这里是 manual 之外的默认），并把请求发出去。
  const runtime = {
    adapter: {
      id: 'manual',
      displayName: '人工导入',
      getCapabilities: () => ({ thread: false, replies: false, publish: false }),
      getThread: async () => {
        throw new Error('离线会话不该读取任何平台')
      },
      publishReply: async () => {
        throw new Error('离线会话不该发表任何内容——这一行被执行就是边界破了')
      },
    },
    store,
    policy: { mode: 'manual', maxAutoPublishesPerSession: 0 },
    config: () => config,
    llm: () => scriptedClient('x', 'local:1') as never,
    log: () => undefined,
  }

  const report = await runPublish(runtime as never, {
    sessionId,
    candidateId: generated.value!.candidateId,
    approvedText: generated.value!.text,
    humanApproved: true,
  })
  assert.equal(report.ok, false)
  assert.equal(report.status, 'refused')
  // 文案必须说清「可以复制」，否则用户会以为功能坏了。
  assert.match(report.message, /复制/)
  assert.doesNotMatch(report.message, /发表成功|已发表/)
})

test('边界 2：整条链路里没有任何一处声称「已发表」', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const generated = await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('先说口径。', 'local:1') as never,
  })
  const copied = await copyReply(store, {
    sessionId,
    candidateId: generated.value!.candidateId,
  })

  const texts = [
    analyzed.value!.session.statusText,
    generated.value!.text,
    copied.value!.text,
    ...copied.value!.blockers,
    copied.value!.persona,
  ].join('\n')
  for (const claim of ['已发表', '发表成功', '已在微博发表', '已发布']) {
    assert.equal(texts.includes(claim), false, `不该出现「${claim}」`)
  }
  // 会话层面也不能有已发表的记录。
  assert.deepEqual(store.getSession(sessionId)!.publishedPostIds, [])
})

test('边界 3：未知目标被拒绝，不会对着不存在的文字生成', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const result = await generateForImport(store, {
    sessionId,
    targetPostId: 'local:999',
    config,
    llm: () => scriptedClient('x', 'local:999') as never,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason!, /不在这次导入的内容里/)
})

test('边界 4：主人不在导入内容里时，分析给出可行动的原因', async () => {
  const store = await newStore()
  const result = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '从未出现过的名字',
    persona: personaOf('tieba_veteran', configOf()),
    config: configOf(),
  })
  assert.equal(result.ok, false)
  // 不能是「分析失败」，必须说清是谁、在哪一步。
  assert.match(result.reason!, /从未出现过的名字|没有找到主人/)
  assert.ok((result.next ?? []).length > 0, '失败时必须给出下一步')
})

test('边界 5：只有原帖、没有评论时拒绝分析并说明', async () => {
  const store = await newStore()
  const result = await analyzeImport(store, {
    imported: importedOf('甲：只有我一个人说话'),
    ownerName: '甲',
    persona: personaOf('tieba_veteran', configOf()),
    config: configOf(),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason!, /没有任何评论|没有可回复的对象/)
})

test('边界 6：重新选目标会清空旧候选——它们是对着旧目标写的', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  await generateForImport(store, {
    sessionId,
    config,
    llm: () => scriptedClient('先说口径。', 'local:1') as never,
  })
  assert.equal(store.getSession(sessionId)!.candidates.length, 1)

  const reselected = await reselectImport(store, {
    sessionId,
    targetPostId: 'local:2',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  assert.equal(reselected.ok, true, reselected.reason)
  const after = store.getSession(sessionId)!
  assert.equal(after.candidates.length, 0, '换了目标，旧候选必须作废')
  assert.equal(after.triggerPostId, 'local:2')
})

test('边界 7：遵循率——生成失败（模型不守格式）时不写候选', async () => {
  const store = await newStore()
  const config = configOf()
  const analyzed = await analyzeImport(store, {
    imported: importedOf(),
    ownerName: '原帖作者',
    targetPostId: 'local:1',
    persona: personaOf('tieba_veteran', config),
    config,
  })
  const sessionId = analyzed.value!.session.id
  const result = await generateForImport(store, {
    sessionId,
    config,
    llm: () =>
      ({
        label: 'prose-only',
        complete: async () => ({ text: '这不是 JSON，只是一段散文。' }),
      }) as never,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason!, /模型输出不符合约定/)
  // 关键：失败不留一个空正文的候选，否则页面会列出一条点了就报错的空行。
  assert.equal(store.getSession(sessionId)!.candidates.length, 0)
})
