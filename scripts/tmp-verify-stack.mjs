/** Reproduce the post-publish crash with a real stack. */
const ROOT = `file:///${process.argv[2].replace(/\\/g, '/')}/profiles/web/node_modules/dsh-ai-debate/lib`
const STATE_DIR = process.argv[3]

const { DebateStore } = await import(`${ROOT}/store.js`)
const { buildTools } = await import(`${ROOT}/tools.js`)
const { DEFAULT_POLICY } = await import(`${ROOT}/safety.js`)

const store = new DebateStore({ dir: STATE_DIR })
await store.ready()

const adapter = {
  id: 'tieba',
  displayName: 'Tieba',
  async checkAuthentication() {
    return { authenticated: true, userId: '900', userName: '小号' }
  },
  async publishReply() {
    return { status: 'confirmed', postId: 'would-be-post-1' }
  },
  async getReplyContext(_ref, postId) {
    const session = store.getSession('s-ui-verify')
    const snapshot = session.candidates[0].targetSnapshot
    // Two different questions, two different answers:
    //
    //  - BEFORE the send, the publisher re-reads the *target* to confirm it has not moved.
    //    That is the opponent's reply, authored by the opponent.
    //  - AFTER the send, it re-reads the *new reply* to confirm what actually landed. That
    //    is our own body, authored by the bound account.
    //
    // A stub that answers both with the opponent's post reports a verification mismatch on
    // every publish — which is what a real adapter would do if it collapsed the two.
    if (postId !== snapshot.targetPostId) {
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
          postId,
          parentPostId: snapshot.floorPostId,
          authorId: '900',
          authorName: '小号',
          content: session.candidates[0].text,
        },
      }
    }
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
        parentPostId: snapshot.floorPostId,
        authorId: snapshot.targetAuthorId,
        authorName: snapshot.targetAuthorName,
        content: '对手的发言内容',
      },
    }
  },
  async readThread() {
    return undefined
  },
}

const tools = buildTools(
  {
    adapter,
    store,
    policy: { ...DEFAULT_POLICY, mode: 'manual' },
    config: () => ({ aiAccountUserId: '900', aiAccountName: '小号', ownerUserId: '1171245451' }),
    llm: () => {
      throw new Error('not used')
    },
    log: () => undefined,
  },
  { logger: () => ({ error: () => undefined, info: () => undefined, warn: () => undefined, debug: () => undefined }) },
)

const publish = tools.find((tool) => tool.name === 'debate_publish_reply')
const session = store.getSession('s-ui-verify')
const candidate = session.candidates[0]

// The tool swallows the stack into a one-line message; call the runtime directly to get it.
const { runPublish } = await import(`${ROOT}/runtime.js`)
try {
  const report = await runPublish(
    {
      adapter,
      store,
      policy: { ...DEFAULT_POLICY, mode: 'manual' },
      config: () => ({ aiAccountUserId: '900', aiAccountName: '小号', ownerUserId: '1171245451' }),
      llm: () => {
        throw new Error('not used')
      },
      log: () => undefined,
    },
    {
      sessionId: session.id,
      candidateId: candidate.replyId,
      approvedText: candidate.text,
    },
  )
  console.log('report =', JSON.stringify(report, null, 2))
} catch (error) {
  console.log('THREW:', error.message)
  console.log(String(error.stack).split('\n').slice(0, 12).join('\n'))
}
void publish
