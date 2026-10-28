/** Print approval lookup immediately after grant, then after publish. */
import fs from 'node:fs'

const file =
  'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate/test/platform-contract.test.ts'

let text = fs.readFileSync(file, 'utf8')
// Reset any prior debug patch by re-reading the pristine copy first.
const marker =
  '    await grantApproval(runtime.store, { sessionId: analysis.sessionId, candidateId: generated.candidateId, config: runtime.config })'

const debug = [
  marker,
  '    {',
  "      const { bindingOf, findApproval, checkApproval } = await import('../lib/security/approvals.js')",
  '      const s0 = runtime.store.getSession(analysis.sessionId)',
  '      const c0 = s0.candidates.find((x) => x.replyId === generated.candidateId)',
  '      const cfg0 = runtime.config()',
  '      const expected0 = bindingOf({',
  '        sessionId: s0.id,',
  '        candidateId: c0.replyId,',
  '        platform: s0.platform,',
  '        targetPostId: c0.targetPostId,',
  '        publishingAccount: (cfg0.aiAccountUserId || cfg0.aiAccountName).trim(),',
  '        text: generated.text,',
  '        candidateVersion: c0.candidateVersion ?? 0,',
  '        assessmentFingerprint: c0.security?.fingerprint ?? "",',
  '      })',
  '      const found0 = findApproval(runtime.store.getApprovals(), { sessionId: s0.id, candidateId: c0.replyId })',
  '      console.error("DBG afterGrant count=", runtime.store.getApprovals().length)',
  '      console.error("DBG found0=", found0 && found0.id)',
  '      console.error("DBG verdict0=", JSON.stringify(checkApproval(found0, expected0, () => Date.now())))',
  '    }',
].join('\n')

if (!text.includes(marker)) {
  console.log('marker not found')
} else {
  text = text.replace(marker, debug)
  fs.writeFileSync(file, text, 'utf8')
  console.log('patched')
}
