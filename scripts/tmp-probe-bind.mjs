/** What does resolvePublishingAccount return for the common fixtures? */
const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate'
const lib = (p) => import(`file:///${ROOT}/lib/${p}`)

const { bindingsOf } = await lib('runtime.js')
const { aiAccountFor } = await lib('platforms/accounts.js')

const cases = {
  BOUND_ACCOUNT: { aiAccountUserId: '1001', aiAccountName: 'ai-account' },
  nameOnly: { aiAccountName: 'EXPECTED_PERSON' },
  empty: {},
  withTable: {
    platformAccounts: JSON.stringify({
      owners: [{ platform: 'fake-a', primary: { platform: 'fake-a', accountId: 'owner-1' } }],
      aiAccounts: [{ platform: 'fake-a', account: { platform: 'fake-a', accountId: 'ai-a' } }],
    }),
  },
}

for (const [label, config] of Object.entries(cases)) {
  for (const platform of ['tieba', 'fake-a']) {
    try {
      const bindings = bindingsOf(config)
      const bound = aiAccountFor(bindings, platform)
      const account = bound?.account
      const value = (account?.accountId ?? account?.displayName ?? '').trim()
      console.log(
        `${label.padEnd(14)} platform=${platform.padEnd(8)} → ${JSON.stringify(value)}  (bound=${JSON.stringify(bound)})`,
      )
    } catch (error) {
      console.log(`${label.padEnd(14)} platform=${platform.padEnd(8)} → THREW ${error.message}`)
    }
  }
}
