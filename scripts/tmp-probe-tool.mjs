/** What does the publish tool actually return for a confirm=true with no approval? */
const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate'
const lib = (p) => import(`file:///${ROOT}/lib/${p}`)
const h = await import(`file:///${ROOT}/test/helpers.ts`)

const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { DebateStore } = await lib('store.js')
const { buildTools } = await lib('tools.js')
const { DEFAULT_POLICY } = await lib('safety.js')
const { assessmentFingerprint } = await lib('security/security-policy.js')
const { contentHash } = await lib('target.js')

const dir = mkdtempSync(join(tmpdir(), 'probe-tool-'))
const store = new DebateStore({ dir })
await store.ready()

const fixture = h.threePartyThread()
const floorPostId = fixture.floors[0].postId
const target = fixture.nested[floorPostId].find((p) => p.postId === 'n5')
const text = '你这条论据没有出处，我不同意这个结论。'
const now = new Date().toISOString()

const session = {
  id: 's-adv',
  platform: 'tieba',
  threadId: fixture.thread.id,
  threadUrl: fixture.thread.url,
  threadTitle: fixture.thread.title,
  forumName: '测试吧',
  ownerKey: 'o',
  ownerName: '主人',
  opponentKey: 'b',
  opponentName: '对手B',
  opponentUserId: target.authorId,
  disputeFloorPostId: floorPostId,
  disputeFloorNumber: 1,
  triggerPostId: 'n7',
  targetKind: 'nested',
  state: 'READY',
  statusText: '就绪',
  persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
  candidates: [
    {
      replyId: 's-adv-c1',
      text,
      strategy: 'direct_rebuttal',
      targetPostId: 'n5',
      targetSnapshot: {
        platform: 'tieba',
        threadId: fixture.thread.id,
        floorPostId,
        floorNumber: 1,
        nestedReplyId: 'n5',
        targetPostId: 'n5',
        targetKind: 'nested',
        targetAuthorId: target.authorId,
        targetAuthorName: target.authorName,
        contentHash: contentHash(target.content),
        capturedAt: now,
      },
      candidateVersion: 1,
      textHash: contentHash(text),
      confidence: 0.8,
      violations: [],
      notes: [],
      security: {
        injectionDetected: false,
        ownerIdentityValid: true,
        targetIdentityValid: true,
        stanceConsistency: 'consistent',
        ownerDirectedAttack: false,
        unauthorizedInstructionFollowed: false,
        secretLeakRisk: false,
        evidenceIntegrityValid: true,
        decision: 'allow',
        reasons: [],
        fingerprint: assessmentFingerprint({ reply: text, targetPostId: 'n5', decision: 'allow' }),
      },
      createdAt: now,
      approved: false,
    },
  ],
  publishedPostIds: [],
  sentTexts: [],
  createdAt: now,
  updatedAt: now,
}
await store.mutate((d) => ({ ...d, sessions: [session] }))

const adapter = new h.FakeAdapter({
  thread: fixture.thread,
  floors: fixture.floors,
  nested: fixture.nested,
  publish: () => ({ status: 'confirmed', postId: 'adv-1' }),
})
const BOUND_ACCOUNT = () => ({ aiAccountUserId: '1001', aiAccountName: 'ai-account' })

const tools = buildTools(
  { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND_ACCOUNT, llm: () => { throw new Error('x') }, log: () => {} },
  { logger: () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }) },
)
const tool = tools.find((t) => t.name === 'debate_publish_reply')
const result = await tool.execute(
  { sessionId: 's-adv', candidateId: 's-adv-c1', text, confirm: true },
  { signal: undefined },
)
console.log('result =', JSON.stringify(result, null, 2))
console.log('publishes =', adapter.publishes.length)

rmSync(dir, { recursive: true, force: true })
