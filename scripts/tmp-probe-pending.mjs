/**
 * Why does `pendingApprovals` come back empty when the store clearly has a review
 * candidate?
 *
 * Runs the deployed library against the deployed store directory and prints every
 * intermediate the filter looks at, so the answer is read off rather than guessed.
 */
const LIB = `file:///${process.argv[2].replace(/\\/g, '/')}/profiles/web/node_modules/dsh-ai-debate/lib`
const DIR = process.argv[3]

const { DebateStore } = await import(`${LIB}/store.js`)

const store = new DebateStore({ dir: DIR })
await store.ready()

const snap = store.snapshot()
console.log('snapshot.sessions =', snap.sessions.length)
console.log('getApprovals()     =', store.getApprovals().length)

const now = Date.now()
const live = new Set(
  store
    .getApprovals()
    .filter((record) => record.consumedAt === undefined && record.revokedAt === undefined)
    .filter((record) => now - Date.parse(record.grantedAt) <= 30 * 60 * 1000)
    .map((record) => `${record.sessionId}\u0000${record.candidateId}`),
)
console.log('live approvals set =', live.size)

for (const session of snap.sessions) {
  console.log('---', session.id)
  console.log('  state        =', JSON.stringify(session.state))
  console.log('  can publish? =', session.state === 'READY' || session.state === 'NEEDS_CONFIRMATION')
  console.log('  candidates   =', session.candidates.length)
  for (const candidate of session.candidates) {
    const verdict = candidate.security?.decision
    console.log('    replyId    =', candidate.replyId)
    console.log('    verdict    =', JSON.stringify(verdict))
    console.log('    is allow/review =', verdict === 'allow' || verdict === 'review')
    console.log('    in live set =', live.has(`${session.id}\u0000${candidate.replyId}`))
  }
}
