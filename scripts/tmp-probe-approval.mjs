/**
 * Probe why a freshly granted approval is still rejected.
 *
 * Prints the stored record and the binding the publisher computes, plus the
 * rejection code, so the mismatch is read off rather than guessed at.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate/lib'
const { DebateStore } = await import(`file:///${ROOT}/store.js`)
const { bindingOf, checkApproval, findApproval } = await import(`file:///${ROOT}/security/approvals.js`)
const { runAnalysis, runGeneration, runPublish } = await import(`file:///${ROOT}/runtime.js`)
const { FakeAdapter, threePartyThread } = await import(
  `file:///C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate/test/helpers.ts`
)

const dir = mkdtempSync(join(tmpdir(), 'probe-'))
const store = new DebateStore({ dir })
await store.ready()

const { resolveConfig, DEFAULT_CONFIG } = await import(`file:///${ROOT}/config.js`)
const { ScriptedLlmClient } = await import(`file:///${ROOT}/llm.js`)

const data = threePartyThread()
const adapter = new FakeAdapter(data)
const config = resolveConfig({
  ...DEFAULT_CONFIG,
  ownerUserId: 'owner-1',
  aiAccountUserId: '1001',
  llmBaseUrl: 'http://127.0.0.1:1/v1',
  llmModel: 'test-model',
})
const client = new ScriptedLlmClient(
  Array.from({ length: 8 }, () => ({
    text: JSON.stringify({
      status: 'ok',
      owner_position: '成本会翻倍',
      opponent_position: '缺少依据',
      main_dispute: '成本问题',
      latest_argument: '你凭什么说成本会翻倍',
      response_target_id: 'n5',
      strategy: 'demand_evidence',
      confidence: 0.8,
      uncertainties: [],
      reply: '前面已经把报价贴出来了，你是没看还是不想看？要反驳就拿出同型号的价格。',
    }),
  })),
)
const runtime = {
  adapter,
  store,
  policy: {
    mode: 'manual',
    maxAutoPublishesPerSession: 0,
    cooldownMs: 0,
    maxPublishesPerThread: 10,
    stopOnChallenge: true,
  },
  config: () => config,
  llm: () => client,
  log: () => {},
}

const analysis = await runAnalysis(runtime, { url: data.thread.url, postId: 'n7' })
console.log('analysis.sessionId =', analysis.sessionId)
const generated = await runGeneration(runtime, { sessionId: analysis.sessionId })
console.log('generated =', JSON.stringify(generated, null, 2).slice(0, 400))

const session = store.getSession(analysis.sessionId)
console.log('session.candidates =', JSON.stringify(session?.candidates?.map((c) => ({
  replyId: c.replyId,
  text: c.text,
  version: c.candidateVersion,
  target: c.targetPostId,
  fingerprint: c.security?.fingerprint,
})), null, 2))
console.log('store approvals before =', store.getApprovals().length)

// Grant exactly as the helper does.
const { bindingOf: mk, createApproval } = await import(`file:///${ROOT}/security/approvals.js`)
const cand = session.candidates.find((c) => c.replyId === generated.candidateId)
const binding = mk({
  sessionId: session.id,
  candidateId: cand.replyId,
  platform: session.platform,
  targetPostId: cand.targetPostId,
  publishingAccount: '',
  text: generated.text,
  candidateVersion: cand.candidateVersion ?? 0,
  assessmentFingerprint: cand.security?.fingerprint ?? '',
})
const record = createApproval(binding, 'probe', () => Date.now())
await store.mutate((d) => ({ ...d, approvals: [...(d.approvals ?? []), record] }))
console.log('approvals after =', store.getApprovals().length)

const found = findApproval(store.getApprovals(), {
  sessionId: session.id,
  candidateId: cand.replyId,
})
console.log('found =', found === undefined ? 'undefined' : found.id)
if (found) {
  const verdict = checkApproval(found, binding, () => Date.now())
  console.log('checkApproval =', JSON.stringify(verdict, null, 2))
}

const report = await runPublish(runtime, {
  sessionId: analysis.sessionId,
  candidateId: generated.candidateId,
  approvedText: generated.text,
})
console.log('report =', JSON.stringify(report, null, 2))

rmSync(dir, { recursive: true, force: true })
