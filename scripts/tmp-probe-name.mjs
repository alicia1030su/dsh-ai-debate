/**
 * Reproduce the AI-name publish refusal and print both sides of the binding.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate'
const lib = (p) => import(`file:///${ROOT}/lib/${p}`)
const test = (p) => import(`file:///${ROOT}/test/${p}`)

const { DebateStore } = await lib('store.js')
const { bindingOf, checkApproval, findApproval } = await lib('security/approvals.js')
const { publishCandidate } = await lib('publisher.js')
const { DEFAULT_POLICY } = await lib('safety.js')
const helpers = await test('helpers.ts')

const dir = mkdtempSync(join(tmpdir(), 'probe-name-'))
const store = new DebateStore({ dir })
await store.ready()

const config = () => ({ aiAccountName: 'EXPECTED_PERSON' })
const text = '名字对了可以发。'
const fixture = helpers.threePartyThread()
const adapter = new helpers.FakeAdapter({
  thread: fixture.thread,
  floors: fixture.floors,
  nested: fixture.nested,
  auth: { authenticated: true, userId: '999', userName: 'EXPECTED_PERSON' },
  publish: () => ({ status: 'confirmed', postId: 'new-name-ok' }),
})

// Minimal session, copied in shape from publisher-safety's readySession.
const now = new Date().toISOString()
const { contentHash } = await lib('target.js')
const { assessmentFingerprint } = await lib('security/security-policy.js')
const targetPostId = fixture.nested[fixture.floors[0].postId][0].postId
const fixtureReply = fixture.nested[fixture.floors[0].postId].find((p) => p.postId === targetPostId)
const snapshot = {
  platform: 'tieba',
  threadId: fixture.thread.id,
  floorPostId: fixture.floors[0].postId,
  floorNumber: 1,
  nestedReplyId: targetPostId,
  targetPostId,
  targetKind: 'nested',
  targetAuthorId: fixtureReply.authorId,
  targetAuthorName: fixtureReply.authorName,
  contentHash: contentHash(fixtureReply.content),
  capturedAt: now,
}
const session = {
  id: 's-nameok',
  platform: 'tieba',
  threadId: fixture.thread.id,
  threadUrl: `https://tieba.baidu.com/p/${fixture.thread.id}`,
  threadTitle: '测试帖',
  forumName: '测试吧',
  ownerKey: 'o',
  ownerName: '主人',
  opponentKey: 'b',
  opponentName: '对手B',
  opponentUserId: fixtureReply.authorId,
  disputeFloorPostId: fixture.floors[0].postId,
  disputeFloorNumber: 1,
  triggerPostId: 'p-nameok',
  targetKind: 'nested',
  state: 'READY',
  statusText: '就绪',
  persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
  candidates: [
    {
      replyId: 's-nameok-c1',
      text,
      strategy: 'direct_rebuttal',
      targetPostId,
      targetSnapshot: snapshot,
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
        fingerprint: assessmentFingerprint({ reply: text, targetPostId, decision: 'allow' }),
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
await store.mutate((data) => ({ ...data, sessions: [session] }))

const record = await helpers.grantApproval(store, {
  sessionId: session.id,
  candidateId: 's-nameok-c1',
  config,
})
console.log('record.publishingAccount =', JSON.stringify(record.publishingAccount))
console.log('record.textHash =', record.textHash.slice(0, 12))
console.log('record.fingerprint =', record.assessmentFingerprint.slice(0, 24))

const stored = store.getSession(session.id)
const cand = stored.candidates[0]
const expected = bindingOf({
  sessionId: stored.id,
  candidateId: cand.replyId,
  platform: stored.platform,
  targetPostId: cand.targetPostId,
  publishingAccount: (config().aiAccountUserId || config().aiAccountName).trim(),
  text,
  candidateVersion: cand.candidateVersion ?? 0,
  assessmentFingerprint: cand.security?.fingerprint ?? '',
})
console.log('expected.publishingAccount =', JSON.stringify(expected.publishingAccount))
console.log('expected.textHash =', expected.textHash.slice(0, 12))
console.log('expected.fingerprint =', expected.assessmentFingerprint.slice(0, 24))

const found = findApproval(store.getApprovals(), { sessionId: session.id, candidateId: 's-nameok-c1' })
console.log('found =', found?.id)
if (found) console.log('checkApproval =', JSON.stringify(checkApproval(found, expected, () => Date.now())))

const report = await publishCandidate(
  { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config },
  { sessionId: session.id, candidateId: 's-nameok-c1', approvedText: text },
)
console.log('report =', JSON.stringify(report, null, 2))

rmSync(dir, { recursive: true, force: true })
