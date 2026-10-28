/**
 * Drive the *real* `debate_publish_reply` tool path against the isolated instance's
 * store, to prove the model's own `confirm: true` cannot authorise a publish.
 *
 * ## Why this runs the compiled library rather than the HTTP route
 *
 * The publish tool is what the agent actually calls; it is not reachable over HTTP. The
 * only way to prove "the model cannot publish by saying confirm" is to invoke that tool
 * with the same arguments a model would produce, against the same store the running
 * instance uses, and check that the platform is never touched.
 *
 * ## The platform adapter is a counting stub
 *
 * No network. `publishReply` increments a counter and returns a confirmed outcome; if the
 * counter is non-zero, a reply would have gone out, which is the failure this test is
 * looking for. The point is the refusal, not the send.
 */
const ROOT = `file:///${process.argv[2].replace(/\\/g, '/')}/profiles/web/node_modules/dsh-ai-debate/lib`
const STATE_DIR = process.argv[3]

const { DebateStore } = await import(`${ROOT}/store.js`)
const { buildTools } = await import(`${ROOT}/tools.js`)
const { DEFAULT_POLICY } = await import(`${ROOT}/safety.js`)

const store = new DebateStore({ dir: STATE_DIR })
await store.ready()

const sends = []
const discussions = new Map()
const adapter = {
  id: 'tieba',
  displayName: 'Tieba',
  async checkAuthentication() {
    return { authenticated: true, userId: '900', userName: '小号' }
  },
  async publishReply(target) {
    sends.push(target)
    return { status: 'confirmed', postId: 'should-never-happen' }
  },
  // The publish path re-reads the target before sending, so a stub without this cannot
  // reach the approval check at all — it stops at `target_not_found` instead, and the
  // approved case would look like a failure for the wrong reason. This returns exactly
  // what the stored snapshot describes, so a clean candidate has nothing to complain
  // about and the run reaches the authorisation gate.
  async getReplyContext(_ref, postId) {
    for (const session of store.snapshot().sessions) {
      const candidate = session.candidates[0]
      const snapshot = candidate?.targetSnapshot
      if (snapshot === undefined || candidate.replyId !== `${session.id}-c1`) continue
      if (snapshot.targetPostId !== postId) continue
      const discussion = discussions.get(session.id) ?? {}
      void discussion
      return {
        thread: { id: snapshot.threadId, url: session.threadUrl, title: session.threadTitle },
        floor: {
          postId: snapshot.floorPostId,
          floorNumber: snapshot.floorNumber,
          authorId: session.ownerKey,
          authorName: session.ownerName,
          content: '楼层正文',
        },
        nested: {
          postId: snapshot.targetPostId,
          authorId: snapshot.targetAuthorId,
          authorName: snapshot.targetAuthorName,
          content: '对手的发言内容',
        },
      }
    }
    return { thread: {}, floor: {}, nested: undefined }
  },
  async readThread() {
    return undefined
  },
}

const config = () => ({
  aiAccountUserId: '900',
  aiAccountName: '小号',
  ownerUserId: '1171245451',
  ownerUserName: '似水蓝蝶',
})

const tools = buildTools(
  {
    adapter,
    store,
    policy: { ...DEFAULT_POLICY, mode: 'manual' },
    config,
    llm: () => {
      throw new Error('the publish path must not call the model')
    },
    log: () => undefined,
  },
  { logger: () => ({ error: () => undefined, info: () => undefined, warn: () => undefined, debug: () => undefined }) },
)

const publish = tools.find((tool) => tool.name === 'debate_publish_reply')
const candidates = store.snapshot().sessions.map((session) => ({
  sessionId: session.id,
  candidateId: session.candidates[0]?.replyId,
  text: session.candidates[0]?.text,
}))
console.log('sessions in store:', candidates.length)
console.log('approvals in store:', (store.snapshot().approvals ?? []).length)

for (const candidate of candidates) {
  if (candidate.candidateId === undefined) continue
  // Exactly what a model would send: its own confirm flag plus the body it saw.
  const result = await publish.execute(
    {
      sessionId: candidate.sessionId,
      candidateId: candidate.candidateId,
      text: candidate.text,
      confirm: true,
    },
    { signal: undefined },
  )
  console.log(
    JSON.stringify({
      sessionId: candidate.sessionId,
      ok: result.ok,
      status: result.status,
      errorCode: result.errorCode,
      error: result.error ? String(result.error).slice(0, 120) : undefined,
    }),
  )
}

console.log('platform publishReply calls:', sends.length)
