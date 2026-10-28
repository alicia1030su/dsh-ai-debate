/**
 * Reproduce the platform-contract publish refusal and print the binding both sides.
 *
 * `platform-contract.test.ts` does not export its helpers, so this rebuilds the
 * minimum: one fake platform, its registry, a runtime whose config binds the account
 * through `platformAccounts`, and a granted approval. If the publish is still
 * refused, the printed bindings say which field differs.
 */
const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate'
const lib = (p) => import(`file:///${ROOT}/lib/${p}`)

const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { DebateStore } = await lib('store.js')
const { resolveConfig, DEFAULT_CONFIG } = await lib('config.js')
const { ScriptedLlmClient } = await lib('llm.js')
const { bindingOf, findApproval, checkApproval } = await lib('security/approvals.js')
const { bindingOf: mk, createApproval } = await lib('security/approvals.js')

const dir = mkdtempSync(join(tmpdir(), 'probe-contract-'))
const store = new DebateStore({ dir })
await store.ready()

const config = resolveConfig({
  ...DEFAULT_CONFIG,
  platformAccounts: JSON.stringify({
    owners: [{ platform: 'fake-a', primary: { platform: 'fake-a', accountId: 'owner-1' } }],
    aiAccounts: [
      { platform: 'fake-a', account: { platform: 'fake-a', accountId: 'ai-a' } },
    ],
  }),
  llmBaseUrl: 'http://127.0.0.1:1/v1',
  llmModel: 'test-model',
})

console.log('config.aiAccountUserId =', JSON.stringify(config.aiAccountUserId))
console.log('config.aiAccountName   =', JSON.stringify(config.aiAccountName))
console.log(
  'publishedAccountOf(fake-a) =',
  JSON.stringify(
    (config.platformAccounts ?? []).find?.((row) => row.platform === 'fake-a') ??
      'n/a',
  ),
)
console.log('platformAccounts raw   =', config.platformAccounts)

// What `publisher.ts` computes.
const publishingAccount = (config.aiAccountUserId || config.aiAccountName).trim()
console.log('publisher publishingAccount =', JSON.stringify(publishingAccount))

rmSync(dir, { recursive: true, force: true })
