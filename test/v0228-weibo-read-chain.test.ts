/**
 * v0.2.28：微博只读链路真正打通到分析。
 *
 * ## 这个文件证明什么，不证明什么
 *
 * 它证明「把一条微博读进来 → 建成讨论结构 → 认出主人 → 认出争论对象」这条链路
 * 在**真实的** collector / analyzer / provider / projection 上跑得通。CLI 进程用
 * `fake-weibo-cli.mjs` 顶替，但 `execFile` 调用、参数构造、JSON 解析、投影、时间线、
 * 分析全都是生产代码。
 *
 * 它**不**证明微博开放平台会返回这些字段。这台机器没有微博开发者认证，也没有登录态，
 * 所以真实 API 从未被调用过。fixture 的 JSON 形状依据是 `@weibo-ai/weibo-cli@0.9.8`
 * 自带的 README 与 `commands show` 的 schema，属「结构相符」而非「实测通过」。
 *
 * ## 为什么要写这个文件
 *
 * v0.2.27 及以前，微博链路有四处在真实运行时必断，而每一处都有单测「通过」：
 *
 * 1. 正文不在时间线里 → 博主（通常在正文发言）被判「没有在帖子里发言」；
 * 2. 数字 UID 的命名空间一侧写 `platform:weibo`、另一侧留空 → 永不相等；
 * 3. 正文不是任何楼层 → 指向正文时直接抛「不属于任何已采集楼层」；
 * 4. 定位目标那条命令根本没实现 → 生成阶段第一步就抛。
 *
 * 四处都是「部件各自正确、接起来不通」，只有端到端才暴露。所以这个文件的断言全部
 * 建立在「一次完整读取的结果」上，而不是某个函数的返回值上。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeDispute } from '../lib/analyzer.js'
import { buildCommentList } from '../lib/comment-list.js'
import { buildTimeline, collectThread, containerOf } from '../lib/collector.js'
import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')

/** The status under discussion: the owner wrote it, three people commented. */
const STATUS_ID = '5021243409116023'
const OWNER_UID = '7788'
const OWNER_NAME = '被围观的楼主'
const COMMENTERS = {
  first: { uid: '1001', name: '先说话的' },
  second: { uid: '1002', name: '后说话的' },
  third: { uid: '1003', name: '也说话的' },
}

function statusPayload(): unknown {
  return {
    idstr: STATUS_ID,
    text: '今天把家里那台用了十年的冰箱换掉了，旧的那台还能制冷，只是噪音大。',
    created_at: 'Sun Nov 02 10:00:00 +0800 2025',
    user: { idstr: OWNER_UID, screen_name: OWNER_NAME },
    comments_count: 3,
  }
}

function commentPayloads(): unknown[] {
  return [
    {
      idstr: '6001',
      text: '十年了还留着，太恋旧了吧。',
      created_at: 'Sun Nov 02 10:05:00 +0800 2025',
      user: { idstr: COMMENTERS.first.uid, screen_name: COMMENTERS.first.name },
      reply_comment_total: 0,
    },
    {
      idstr: '6002',
      text: '噪音大就换，这逻辑说得通吗？先修一下不行？',
      created_at: 'Sun Nov 02 10:06:00 +0800 2025',
      user: { idstr: COMMENTERS.second.uid, screen_name: COMMENTERS.second.name },
      reply_comment_total: 0,
    },
    {
      idstr: '6003',
      text: '我赞成换，能效差的老冰箱费电。',
      created_at: 'Sun Nov 02 10:07:00 +0800 2025',
      user: { idstr: COMMENTERS.third.uid, screen_name: COMMENTERS.third.name },
      reply_comment_total: 0,
    },
  ]
}

interface Rig {
  readonly close: () => void
  readonly calls: () => string[][]
}

/**
 * Point the CLI layer at the fake executable.
 *
 * The catalog declares one thread command and one comment command, with the flag shapes
 * the real ones document (`--ids` for the status read, `--id` + `--page` + `--count` for
 * the comment list). The plan is derived from these schemas by the real planning code.
 */
function useFakeCli(options: {
  readonly comments?: unknown[]
  readonly catalog?: unknown
  readonly commentFlags?: unknown[]
  readonly commentFailure?: { readonly stderr: string; readonly exit: number }
} = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'weibo-chain-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')

  const comments = options.comments ?? commentPayloads()
  const catalog = options.catalog ?? {
    commands: [
      { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
      { group: 'comments', action: 'list/biz', access: 'allowed' },
    ],
  }
  const commentFlags = options.commentFlags ?? [
    { name: 'id', required: true },
    { name: 'page', required: false },
    { name: 'count', required: false },
  ]

  const rules: unknown[] = [
    { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
    // `doctor` reports every step green: this rig represents a logged-in, entitled
    // account, which is the case the read path is supposed to handle.
    { match: 'doctor', stdout: '√ 注册或登录\n√ 完成开发者认证\n√ 开通服务\n' },
    { match: 'commands list', stdout: JSON.stringify(catalog) },
    {
      match: 'commands show statuses show_batch/biz',
      stdout: JSON.stringify({
        group: 'statuses',
        action: 'show_batch/biz',
        flags: [{ name: 'ids', required: true }],
      }),
    },
    {
      match: 'commands show comments list/biz',
      stdout: JSON.stringify({ group: 'comments', action: 'list/biz', flags: commentFlags }),
    },
    { match: 'statuses show_batch/biz', stdout: JSON.stringify(statusPayload()) },
  ]

  if (options.commentFailure === undefined) {
    rules.push({ match: 'comments list/biz', stdout: JSON.stringify({ data: comments, has_more: false }) })
  } else {
    rules.push({
      match: 'comments list/biz',
      stderr: options.commentFailure.stderr,
      exit: options.commentFailure.exit,
    })
  }

  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  // A cold cache per test: the plan probe must actually run, not reuse a previous rig's
  // verdict — otherwise a test could pass on another test's catalog.
  __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })

  return {
    close: () => {
      __setCliInvocation(undefined)
      __setPlanCacheTimings(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
    calls: () => {
      const text = readIfExists(logPath)
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[])
    },
  }
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const REF = {
  platform: 'weibo' as const,
  threadId: STATUS_ID,
  url: `https://m.weibo.cn/detail/${STATUS_ID}`,
}

async function readAll(): Promise<ReturnType<typeof collectThread> extends Promise<infer T> ? T : never> {
  const adapter = weiboProvider.createAdapter({ settings: {} })
  return collectThread(adapter, REF, { maxPages: 5 })
}

// ---------------------------------------------------------------------------
// A. 正文进入时间线（断点 1）
// ---------------------------------------------------------------------------

test('微博正文作为 root 节点进入时间线，且排在最前', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const timeline = buildTimeline(collected)

    assert.ok(timeline.length > 0, '时间线不能是空的')
    const root = timeline[0]!
    assert.equal(root.kind, 'root', `第一条必须是正文，实际 ${root.kind}`)
    assert.equal(root.postId, STATUS_ID, '正文的 id 必须就是微博 id')
    assert.equal(root.authorName, OWNER_NAME)
    assert.equal(root.authorNumericUid, OWNER_UID)
    assert.equal(root.authorNumericUidNamespace, 'platform:weibo', '数字 UID 必须带命名空间')
    assert.match(root.content, /换掉了/, '正文内容必须真的写进来了')

    // And every comment is still there, after it.
    const comments = timeline.filter((entry) => entry.kind === 'floor')
    assert.equal(comments.length, 3, `应有 3 条评论，实际 ${comments.length}`)
  } finally {
    rig.close()
  }
})

test('正文不是一个楼层，但它自己是可寻址的讨论容器', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    // It must NOT be reported as a floor — that would give it an invented 楼层号.
    assert.equal(
      collected.floors.some((entry) => entry.floor.postId === STATUS_ID),
      false,
      '正文不能被当成楼层，否则界面会显示「第 N 楼」',
    )
    const container = containerOf(collected, STATUS_ID)
    assert.notEqual(container, undefined, '指向正文时必须能找到容器')
    assert.equal(container!.isThreadBody, true)
    assert.equal(container!.floorNumber, undefined, '微博没有楼层号，不能凭空造一个')
  } finally {
    rig.close()
  }
})

test('贴吧式的时间线没有被这个改动波及：正文不重复出现', async () => {
  // A Tieba-shaped thread: the body and 1 楼 are the same post. `bodyNode` is absent, so
  // no root entry is emitted and the owner's single statement is not counted twice.
  const timeline = buildTimeline({
    thread: {
      platform: 'tieba',
      forum: { platform: 'tieba', name: '测试吧' },
      id: '9001',
      title: '标题',
      content: '楼主的第一句话',
      authorId: '楼主',
      authorName: '楼主',
      url: 'https://tieba.baidu.com/p/9001',
      images: [],
    },
    floors: [
      {
        floor: {
          platform: 'tieba',
          postId: '9001001',
          floorNumber: 1,
          authorId: '楼主',
          authorName: '楼主',
          content: '楼主的第一句话',
          images: [],
        },
        nested: [],
        nestedComplete: true,
      },
    ],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    pagesRead: 1,
    stopReason: 'confirmed_end',
    truncated: false,
    nestedIncomplete: false,
    issues: [],
  })
  assert.equal(timeline.length, 1, '贴吧不应多出一条 root 记录')
  assert.equal(timeline[0]!.kind, 'floor')
})

// ---------------------------------------------------------------------------
// B. 主人识别（断点 2）
// ---------------------------------------------------------------------------

test('主人是博主时能在自己的帖子里被认出来（数字 UID 绑定）', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const dispute = analyzeDispute(
      collected,
      { platform: 'weibo', userId: OWNER_UID },
      { postId: STATUS_ID },
    )

    assert.equal(dispute.owner.displayName, OWNER_NAME)
    assert.equal(dispute.owner.userId, OWNER_UID)
    assert.equal(
      dispute.ownerIdentityAssurance,
      'verified',
      `数字 UID 命中应为 verified，实际 ${dispute.ownerIdentityAssurance}；` +
        `依据 ${JSON.stringify(dispute.ownerIdentityEvidence)}`,
    )
    // The identity evidence must name the namespace the record carried, not the one the
    // configuration implied — a mismatch here is exactly the bug this release fixes.
    assert.equal(dispute.ownerIdentityEvidence.namespace, 'platform:weibo')
  } finally {
    rig.close()
  }
})

test('主人用昵称绑定时同样能认出来', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const dispute = analyzeDispute(
      collected,
      { platform: 'weibo', userName: OWNER_NAME },
      { postId: STATUS_ID },
    )
    assert.equal(dispute.owner.displayName, OWNER_NAME)
  } finally {
    rig.close()
  }
})

test('主人不是博主时不会把博主的正文算成主人的发言', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const error = (() => {
      try {
        analyzeDispute(collected, { platform: 'weibo', userId: COMMENTERS.first.uid }, { postId: STATUS_ID })
        return undefined
      } catch (caught) {
        return caught as Error
      }
    })()
    // The commenter never wrote the body, so binding them by uid cannot resolve to the
    // body's author. It resolves to their own comment — which is a real participant — so
    // this must succeed with *that* identity, never with the blogger's.
    assert.equal(error, undefined, `不该抛错：${error?.message}`)
    const dispute = analyzeDispute(
      collected,
      { platform: 'weibo', userId: COMMENTERS.first.uid },
      { postId: STATUS_ID },
    )
    assert.equal(dispute.owner.displayName, COMMENTERS.first.name)
    assert.notEqual(dispute.owner.displayName, OWNER_NAME, '绝不能把博主当成这个主人')
  } finally {
    rig.close()
  }
})

// ---------------------------------------------------------------------------
// C. 争论分析（断点 3）
// ---------------------------------------------------------------------------

test('指向正文时能找到评论里的争论对象，而不是抛「不属于任何楼层」', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const dispute = analyzeDispute(
      collected,
      { platform: 'weibo', userId: OWNER_UID },
      { postId: STATUS_ID },
    )
    assert.equal(dispute.floorPostId, STATUS_ID, '容器就是正文自身')
    assert.equal(dispute.floorNumber, undefined, '微博没有楼层号')
    assert.ok(dispute.opponent !== undefined, '应当从评论里选出对手')
    const named = [COMMENTERS.first.name, COMMENTERS.second.name, COMMENTERS.third.name]
    assert.ok(
      named.includes(dispute.opponent!.displayName ?? ''),
      `对手必须是三评论者之一，实际 ${dispute.opponent!.displayName}`,
    )
  } finally {
    rig.close()
  }
})

test('指向某条评论时，对手就是那条评论的作者', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const dispute = analyzeDispute(
      collected,
      { platform: 'weibo', userId: OWNER_UID },
      { postId: '6002' },
    )
    assert.equal(dispute.opponent?.displayName, COMMENTERS.second.name)
    assert.equal(dispute.floorPostId, '6002', '容器是这条评论自己')
    assert.equal(dispute.floorNumber, undefined)
  } finally {
    rig.close()
  }
})

test('正文与评论都在「主人发言」里各出现一次，没有重复计数', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const dispute = analyzeDispute(
      collected,
      { platform: 'weibo', userId: OWNER_UID },
      { postId: STATUS_ID },
    )
    assert.equal(dispute.ownerStatements.length, 1, `主人只发了一条，实际 ${dispute.ownerStatements.length}`)
    assert.equal(dispute.ownerStatements[0]!.postId, STATUS_ID)
  } finally {
    rig.close()
  }
})

// ---------------------------------------------------------------------------
// D. 工作台评论列表
// ---------------------------------------------------------------------------

test('工作台评论列表把正文列在最前，且不带楼层号', async () => {
  const rig = useFakeCli()
  try {
    const collected = await readAll()
    const list = buildCommentList(collected)
    assert.equal(list.comments.length, 4, `正文 + 3 条评论，实际 ${list.comments.length}`)
    const first = list.comments[0]!
    assert.equal(first.postId, STATUS_ID)
    assert.equal(first.floorNumber, undefined, '不能给微博正文编一个楼层号')
    assert.equal(first.authorName, OWNER_NAME)
    assert.equal(first.authorNumericUid, OWNER_UID)
    assert.equal(first.identity, 'verified', '有数字 UID 就是已核验')
  } finally {
    rig.close()
  }
})

// ---------------------------------------------------------------------------
// E. 读取失败必须报错，不能返回空数组当成功
// ---------------------------------------------------------------------------

test('评论读取失败时整次读取如实失败，不把空列表当成「没有评论」', async () => {
  const rig = useFakeCli({
    commentFailure: { stderr: '权限不足：当前账号没有读取评论的权限\n', exit: 1 },
  })
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const error = await adapter
      .getReplies(REF, 1)
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error)
    assert.notEqual(error, undefined, '权限不足必须抛错')
    assert.doesNotMatch(
      error!.message,
      /^$/,
      '错误信息不能是空的',
    )
  } finally {
    rig.close()
  }
})

test('CLI 未登录时读取被拒绝，并说明原因是未登录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weibo-chain-'))
  const scriptPath = join(dir, 'script.json')
  writeFileSync(
    scriptPath,
    JSON.stringify({
      rules: [
        { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
        { match: 'doctor', stdout: '× 注册或登录\n× 完成开发者认证\n× 开通服务\n' },
      ],
    }),
    'utf8',
  )
  process.env.FAKE_CLI_SCRIPT = scriptPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const error = await adapter
      .getThread(REF)
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error & { code?: string })
    assert.notEqual(error, undefined, '未登录时必须抛错')
    assert.match(error!.message, /登录|认证|开通/, `信息要能指向真实原因，实际：${error!.message}`)
  } finally {
    __setCliInvocation(undefined)
    __setPlanCacheTimings(undefined)
    delete process.env.FAKE_CLI_SCRIPT
  }
})

// ---------------------------------------------------------------------------
// F. 参数形状（证明 CLI 契约被遵守）
// ---------------------------------------------------------------------------

test('评论读取按平台声明的参数名发请求，不发明额外 flag', async () => {
  const rig = useFakeCli()
  try {
    await readAll()
    const calls = rig.calls()
    const commentCalls = calls.filter((argv) => argv[0] === 'comments')
    assert.ok(commentCalls.length > 0, '必须真的调用过评论命令')
    // `--output json` is the CLI's global output format, added by the invocation layer for
    // every call. It is not a platform flag, so it is not evidence about the read intent —
    // separating the two is what keeps this test about *our* argument construction.
    const GLOBAL_FLAGS = new Set(['--output'])
    for (const argv of commentCalls) {
      assert.deepEqual(
        argv.slice(0, 2),
        ['comments', 'list/biz'],
        `调用形状不对：${argv.join(' ')}`,
      )
      const flags = argv.filter((token) => token.startsWith('--'))
      for (const flag of flags) {
        if (GLOBAL_FLAGS.has(flag)) continue
        assert.ok(
          ['--id', '--page', '--count'].includes(flag),
          `发了未声明的 flag ${flag}：${argv.join(' ')}`,
        )
      }
      // The id must be the status id, never the URL — passing the URL is the mistake this
      // whole layer was written to prevent.
      const idIndex = argv.indexOf('--id')
      if (idIndex >= 0) {
        assert.equal(argv[idIndex + 1], STATUS_ID, `--id 必须是微博 id，实际 ${argv[idIndex + 1]}`)
      }
    }
  } finally {
    rig.close()
  }
})
