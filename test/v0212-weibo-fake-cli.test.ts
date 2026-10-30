/**
 * v0.2.12 §一 + §七：Fake CLI 驱动的完整命令级集成测试。
 *
 * ## 这个文件证明什么、不证明什么
 *
 * **证明**：Provider 真的会去调用 CLI（真的 spawn 子进程）、传的参数是帖子的 numeric
 * mid 而不是原始 URL、返回值被转换成 `Thread` / `Floor` / `NestedReply`、失败被分类成
 * 可区分的错误码、能力表反映实测结果。
 *
 * **不证明**：微博真实接口返回的形状就是这样。本机没有 CLI、没有开发者认证、没有
 * OAuth，真实读取**一次都没跑过**。这里的 fixture 是按公开文档与字段命名惯例构造的，
 * 真实响应可能不同——对不上时的表现是 `malformed_response`，而不是假装成功。
 *
 * 报告里这两句话必须同时出现，否则「测试全绿」会被误读成「微博读通了」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'
import { parseWeiboUrl } from '../lib/platforms/weibo/url.js'

const NODE = process.execPath
const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')

const REF = (() => {
  const ref = parseWeiboUrl('https://m.weibo.cn/detail/4331051486294436')
  return { platform: 'weibo' as const, threadId: ref.threadId, url: ref.url }
})()

/** One status object in the shape Weibo's public API documents. */
const STATUS = {
  id: 4331051486294436,
  idstr: '4331051486294436',
  mid: '4331051486294436',
  text: '这条说法站不住脚，请拿出证据。',
  created_at: 'Wed Oct 29 21:00:00 +0800 2026',
  user: { id: 111, idstr: '111', screen_name: '主人' },
  pic_urls: [{ thumbnail_pic: 'https://wx1.sinaimg.cn/thumb/a.jpg' }],
  comments_count: 3,
}

const COMMENTS_PAGE_1 = {
  comments: [
    {
      id: 5001,
      idstr: '5001',
      text: '你这才是抬杠。',
      created_at: 'Wed Oct 29 21:01:00 +0800 2026',
      user: { id: 222, idstr: '222', screen_name: '对手B' },
      reply_comment_total: 2,
    },
    {
      id: 5002,
      idstr: '5002',
      text: '我倒觉得他说得有道理。',
      created_at: 'Wed Oct 29 21:02:00 +0800 2026',
      user: { id: 333, idstr: '333', screen_name: '路人甲' },
    },
  ],
  total_number: 10,
  has_more: true,
  next_cursor: 'cursor-2',
}

const COMMENTS_PAGE_2 = {
  comments: [
    {
      id: 5003,
      idstr: '5003',
      text: '总之我不认同。',
      user: { id: 222, idstr: '222', screen_name: '对手B' },
    },
  ],
  total_number: 10,
  has_more: false,
}

/**
 * The catalog rows use the official `group` + `action` shape.
 *
 * v0.2.12 modelled these as one name (`statuses/show`). That cannot be invoked: the CLI reads
 * `rest[0]` as the group and `rest[1]` as the action, so a single combined string leaves the
 * action empty and `commands show` throws. The fixture was part of the bug.
 */
const GOOD_CATALOG = {
  commands: [
    { group: 'statuses', action: 'show_batch/biz', description: '读取微博', price_type: 'credit' },
    { group: 'comments', action: 'show/biz', description: '读取评论', price_type: 'credit' },
  ],
  total: 2,
}

const GOOD_STATUS_SCHEMA = {
  group: 'statuses',
  action: 'show_batch/biz',
  flags: [
    { name: 'ids', required: true },
    { name: 'isGetLongText' },
  ],
}

const GOOD_COMMENT_SCHEMA = {
  group: 'comments',
  action: 'show/biz',
  flags: [
    { name: 'id', required: true },
    { name: 'page' },
    { name: 'count' },
    // A parent-scoping flag the catalog actually lists. v0.2.12's audit found the adapter was
    // sending a hardcoded `--comment` that appeared nowhere in the schema; the flag is now
    // discovered from here, and nested reads refuse when it is absent.
    { name: 'cid' },
  ],
}

/** Install a fake CLI whose answers come from `rules`. */
function useFakeCli(rules: readonly unknown[]): { logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cli-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  writeFileSync(logPath, '', 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: NODE, prefixArgs: [SCRIPT] })
  return { logPath }
}

/** Restore the real binary between tests. */
function resetCli(): void {
  __setCliInvocation(undefined)
  delete process.env.FAKE_CLI_SCRIPT
  delete process.env.FAKE_CLI_LOG
}

/** The baseline: everything works. */
function happyRules(): unknown[] {
  return [
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    // ## The argv shapes below are what the official CLI actually receives
    //
    // `commands show <group> <action>` takes two positional arguments; every business argument
    // (`--ids`, `--id`, `--page`, `--count`, `--cid`) is a flag. v0.2.12's fixture used
    // `comments/list <mid> --page 1`, i.e. an id passed positionally — a form the CLI drops
    // without an error, which is exactly why the defect stayed invisible.
    { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS_SCHEMA) },
    { match: 'commands show comments show/biz', stdout: JSON.stringify(GOOD_COMMENT_SCHEMA) },
    { match: 'commands list', stdout: JSON.stringify(GOOD_CATALOG) },
    { match: 'statuses show_batch/biz --ids 4331051486294436', stdout: JSON.stringify(STATUS) },
    // Page 1 omits `--page` (it is the default), and both pages carry `--count` because the
    // schema declares it. v0.2.13 always sent `--page`, including for page 1.
    {
      match: 'comments show/biz --id 4331051486294436 --count 20',
      stdout: JSON.stringify(COMMENTS_PAGE_1),
    },
    {
      match: 'comments show/biz --id 4331051486294436 --page 2 --count 20',
      stdout: JSON.stringify(COMMENTS_PAGE_2),
    },
    {
      match: 'comments show/biz --id 4331051486294436 --cid 5001 --count 20',
      stdout: JSON.stringify({
        comments: [
          {
            id: 6001,
            idstr: '6001',
            text: '而且你也没解释清楚。',
            user: { id: 333, idstr: '333', screen_name: '路人甲' },
          },
        ],
        has_more: false,
      }),
    },
  ]
}

function adapter(): ReturnType<typeof weiboProvider.createAdapter> {
  return weiboProvider.createAdapter({ settings: {} })
}

/** Read the argv arrays recorded by the fake CLI. */
function calls(logPath: string): string[][] {
  const text = readFileSync(logPath, 'utf8')
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[])
}

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

test('集成：getThread 真的 spawn 了 CLI，并把 numeric mid 作为参数传过去', async () => {
  const { logPath } = useFakeCli(happyRules())
  try {
    const thread = await adapter().getThread(REF)
    assert.equal(thread.platform, 'weibo')
    assert.equal(thread.id, '4331051486294436')
    assert.equal(thread.content, '这条说法站不住脚，请拿出证据。')
    assert.equal(thread.authorName, '主人')
    assert.equal(thread.authorId, '111')
    assert.equal(thread.images.length, 1, '图片地址应被保留')
    assert.equal(thread.declaredReplyCount, 3)

    // The argument assertion: a numeric mid, never the raw URL and never the base62 form.
    //
    // `argv[0]` is the command name, so the lookup has to match the *first* element. The
    // first version matched anywhere in argv and picked up the `commands show` argument,
    // which is the schema lookup — a different call that legitimately carries no mid.
    const log = calls(logPath)
    // The command is invoked as `statuses show_batch/biz --ids <mid>`: two positional
  // arguments, then the id as a flag. v0.2.12 asserted on a single `statuses/show` argv
  // element, a form the real CLI cannot accept.
  const statusCall = log.find(
    (argv) => argv[0] === 'statuses' && argv[1] === 'show_batch/biz',
  )
    assert.ok(
      statusCall !== undefined,
      `应真的调用 statuses/show，实际：${JSON.stringify(log)}`,
    )
    assert.equal(
      statusCall!.includes('4331051486294436'),
      true,
      `应传 numeric mid，实际参数 ${JSON.stringify(statusCall)}`,
    )
    assert.equal(
      statusCall!.some((arg) => arg.includes('http')),
      false,
      '绝不能把整条 URL 当 id 传进去',
    )
    assert.equal(
      statusCall!.some((arg) => arg === 'Hd1N2qpta'),
      false,
      '也不能传 base62 形式：CLI 的 id 参数要 numeric mid',
    )
  } finally {
    resetCli()
  }
})

test('集成：getReplies 分页，且完整性来自响应而不是「这页看着短」', async () => {
  const { logPath } = useFakeCli(happyRules())
  try {
    const a = adapter()
    const page1 = await a.getReplies(REF, 1)
    assert.equal(page1.page, 1)
    assert.equal(page1.floors.length, 2)
    assert.equal(page1.hasMore, true, '响应说 has_more=true，就必须报 true')
    assert.equal(page1.declaredTotal, 10)
    // Floors carry no floorNumber: Weibo has no 楼层.
    assert.equal(page1.floors[0]!.floorNumber, undefined, '微博不能编造楼层号')
    assert.equal(page1.floors[0]!.postId, '5001')
    assert.equal(page1.floors[0]!.nestedCount, 2)

    const page2 = await a.getReplies(REF, 2)
    assert.equal(page2.floors.length, 1)
    assert.equal(page2.hasMore, false)

    const log = calls(logPath)
    // ## Page 2 must carry `--page`, and page 1 must not (v0.2.14)
    //
    // The schema declares `page`, so a request for page 2 has to say so. Page 1 is the server
    // default, so it is left off; sending `--page 1` would be a request the command may reject
    // with `Unknown option` on a schema that names its paging flag differently.
    assert.equal(
      log.some(
        (argv) =>
          argv[0] === 'comments' &&
          argv[1] === 'show/biz' &&
          argv.includes('--page') &&
          argv.includes('2'),
      ),
      true,
      '请求第 2 页时必须把页码传下去',
    )
    assert.equal(
      log.some(
        (argv) =>
          argv[0] === 'comments' && argv[1] === 'show/biz' && argv.includes('--page') && argv.includes('1'),
      ),
      false,
      '第 1 页是服务端默认，不该发 --page 1',
    )
  } finally {
    resetCli()
  }
})

test('集成：getNestedReplies 用目录里发现的筛选参数，不再凭空拼 flag', async () => {
  // ## What changed after the audit
  //
  // v0.2.11 sent a hardcoded `--comment`. The audit's point stands: that flag appears nowhere
  // in the catalog and was never validated, so it either fails or — worse — is silently
  // ignored, in which case top-level comments come back and get projected as replies.
  //
  // The adapter now takes the flag from `inspectCommand`'s `nestedFilterFlag`. The fixture's
  // schema lists `cid`, so the invocation must use `--cid`.
  const rules = happyRules().map((rule) => {
    const r = rule as { match: string; stdout?: string }
    // The nested argv is `--id <微博id> --cid <评论id> --count 20`: two different ids, and the
    // first version of this rewrite passed the comment id as the post id.
    if (r.match.startsWith('comments show/biz --id 4331051486294436 --cid')) {
      return {
        match: r.match,
        stdout: JSON.stringify({
          comments: [
            {
              id: 6001,
              idstr: '6001',
              text: '而且你也没解释清楚。',
              user: { id: 333, idstr: '333', screen_name: '路人甲' },
            },
          ],
          // A second page exists. `incomplete` must NOT be set for that alone — see the
          // assertion below.
          has_more: true,
        }),
      }
    }
    return rule
  })
  const { logPath } = useFakeCli(rules)
  try {
    const a = adapter()
    const page = await a.getNestedReplies(
      REF,
      { platform: 'weibo', postId: '5001', content: '', images: [] },
      1,
    )
    assert.equal(page.replies.length, 1)
    assert.equal(page.replies[0]!.parentPostId, '5001')
    assert.equal(page.hasMore, true, '还有下一页要如实报告')

    // ## The corrected meaning of `incomplete`
    //
    // v0.2.11 set it whenever `hasMore` was true, which is just normal pagination. The
    // collector reads `incomplete` as *degradation*, so every multi-page floor was reported as
    // "楼中楼不完整" even after a clean full walk. It is now reserved for a payload whose
    // paging state could not be read at all.
    assert.notEqual(page.incomplete, true, '正常的 hasMore 不等于「读不全」')

    const log = calls(logPath)
    assert.equal(
      log.some((argv) => argv.includes('--cid') && argv.includes('5001')),
      true,
      `必须用目录里发现的参数名，实际调用：${JSON.stringify(log)}`,
    )
    assert.equal(
      log.some((argv) => argv.includes('--comment')),
      false,
      '不能再出现凭空拼的 --comment',
    )
  } finally {
    resetCli()
  }
})

test('集成：目录里没有父评论筛选参数时，楼中楼读取必须拒绝而不是猜', async () => {
  // The other half of the fix: when the catalog lists no parent-scoping parameter, sending an
  // invented flag would either fail or be ignored — and an ignored flag returns top-level
  // comments that then look like replies. Refusing is the only honest outcome.
  const rules = happyRules().map((rule) => {
    const r = rule as { match: string; stdout?: string }
    if (r.match === 'commands show comments show/biz') {
      return {
        match: r.match,
        // No `cid`/`parent_id` among the flags: the case under test.
        stdout: JSON.stringify({
          group: 'comments',
          action: 'show/biz',
          flags: [{ name: 'id', required: true }, { name: 'page' }],
        }),
      }
    }
    return rule
  })
  const { logPath } = useFakeCli(rules)
  try {
    const a = adapter()
    const error = await a
      .getNestedReplies(REF, { platform: 'weibo', postId: '5001', content: '', images: [] }, 1)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.ok(error !== undefined, '必须拒绝')
    assert.equal(error!.code, 'command_unavailable', `实际 ${error!.code}`)
    assert.match(error!.message, /父评论|筛选/)

    const log = calls(logPath)
    assert.equal(
      log.some((argv) => argv[0] === 'comments/list' && argv.includes('5001')),
      false,
      `拒绝时绝不能真的去调：${JSON.stringify(log)}`,
    )
  } finally {
    resetCli()
  }
})

test('集成：能力表反映实测结果，而不是写死的 false', async () => {
  useFakeCli(happyRules())
  try {
    const a = adapter()
    // Before any read the plan is unknown; the contract is synchronous so it cannot wait.
    const before = a.getCapabilities()
    assert.equal(before.thread, false)

    await a.getThread(REF)

    const after = a.getCapabilities()
    assert.equal(after.thread, true, '真读过之后，thread 应为 true')
    assert.equal(after.replies, true)
    assert.equal(after.authCheck, true)
    assert.equal(after.publish, false, '发表永远不可用')
    assert.equal(after.mentions, false)
  } finally {
    resetCli()
  }
})

// ---------------------------------------------------------------------------
// 失败路径：每一种都必须可区分
// ---------------------------------------------------------------------------

test('集成：没装 CLI → cli_missing，且带安装步骤', async () => {
  __setCliInvocation({ file: 'definitely-not-a-real-binary-xyz', prefixArgs: [] })
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string; steps?: readonly string[] },
      )
    assert.ok(error !== undefined)
    assert.equal(error!.code, 'cli_missing', `实际 ${error!.code}: ${error!.message}`)
    assert.equal((error!.steps ?? []).length > 0, true, '必须给出下一步')
  } finally {
    resetCli()
  }
})

test('集成：未登录 → not_authenticated，且绝不尝试授权读取', async () => {
  // The CLI says the login is missing. The adapter must surface that and stop — no
  // attempt to read anyway, and no attempt to start an OAuth flow (which it cannot do).
  const { logPath } = useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stderr: 'error: not logged in, run auth login\n', exit: 1 },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.ok(error !== undefined)
    assert.equal(error!.code, 'not_authenticated', `实际 ${error!.code}: ${error!.message}`)
    const log = calls(logPath)
    assert.equal(
      log.some((argv) => argv.includes('statuses/show')),
      false,
      '未认证时绝不能去读',
    )
    assert.equal(
      log.some((argv) => argv.some((arg) => /auth|login/i.test(arg))),
      false,
      '绝不能自动触发 OAuth 授权',
    )
  } finally {
    resetCli()
  }
})

test('集成：服务未开通 → service_inactive', async () => {
  useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stderr: '开发者认证未通过\n', exit: 1 },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.equal(error!.code, 'service_inactive', `实际 ${error!.code}: ${error!.message}`)
  } finally {
    resetCli()
  }
})

test('集成：额度不足 → quota_exhausted', async () => {
  useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS_SCHEMA) },
    { match: 'commands show comments show/biz', stdout: JSON.stringify(GOOD_COMMENT_SCHEMA) },
    { match: 'commands list', stdout: JSON.stringify(GOOD_CATALOG) },
    { match: 'statuses show_batch/biz --ids 4331051486294436', stderr: 'error: 积分余额不足\n', exit: 1 },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.equal(error!.code, 'quota_exhausted', `实际 ${error!.code}: ${error!.message}`)
  } finally {
    resetCli()
  }
})

test('集成：命令清单里没有读取命令 → command_unavailable，不是笼统失败', async () => {
  useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands list', stdout: JSON.stringify({ commands: [{ name: 'article/publish' }] }) },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.equal(error!.code, 'command_unavailable', `实际 ${error!.code}: ${error!.message}`)
  } finally {
    resetCli()
  }
})

test('集成：命令要求我们填不了的参数 → 拒绝调用，不猜参数（v0.2.12 核心约束）', async () => {
  // The catalog lists a status read, but its schema demands a `uid` we do not have. The
  // task book forbids "name matched, therefore permitted"; this is the concrete case.
  const { logPath } = useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    {
      match: 'commands show statuses show_batch/biz',
      stdout: JSON.stringify({
        name: 'statuses/show',
        params: [{ name: 'id', required: true }, { name: 'uid', required: true }],
      }),
    },
    { match: 'commands show comments show/biz', stdout: JSON.stringify(GOOD_COMMENT_SCHEMA) },
    { match: 'commands list', stdout: JSON.stringify(GOOD_CATALOG) },
    { match: 'statuses show_batch/biz --ids 4331051486294436', stdout: JSON.stringify(STATUS) },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string; message?: string },
      )
    assert.ok(error !== undefined, '参数填不了时不能读')
    assert.equal(error!.code, 'command_unavailable', `实际 ${error!.code}: ${error!.message}`)
    assert.match(error!.message ?? '', /uid|参数/, `错误里应指明缺什么：${error!.message}`)
    // The decisive assertion: the command was never executed.
    const log = calls(logPath)
    assert.equal(
      log.some((argv) => argv[0] === 'statuses/show'),
      false,
      `参数校验失败后绝不能真的调用：${JSON.stringify(log)}`,
    )
  } finally {
    resetCli()
  }
})

test('集成：响应里没有可识别 id → target_mismatch，不返回空 Thread', async () => {
  // ## Why the code changed in v0.2.14
  //
  // This payload carries no id at all. v0.2.13 called that `malformed_response` ("the shape did
  // not parse"), which framed it as a parsing problem. It is not: a payload that identifies no
  // post **cannot be shown to be the target**, and calling it a shape error invites a future
  // parser tweak to "fix" it by accepting the object anyway.
  //
  // The guarantee is unchanged and is the one that matters: `getThread` must fail rather than
  // return a thread built from an unidentifiable post.
  useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS_SCHEMA) },
    { match: 'commands show comments show/biz', stdout: JSON.stringify(GOOD_COMMENT_SCHEMA) },
    { match: 'commands list', stdout: JSON.stringify(GOOD_CATALOG) },
    { match: 'statuses show_batch/biz --ids 4331051486294436', stdout: JSON.stringify({ unexpected: 'shape' }) },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.ok(error !== undefined, '结构不符必须失败')
    assert.equal(error!.code, 'target_mismatch', `实际 ${error!.code}: ${error!.message}`)
  } finally {
    resetCli()
  }
})

test('集成：id 对得上但正文读不出来 → malformed_response', async () => {
  // The complementary case, and the reason the two codes exist separately: here the post *is*
  // the target (its id matches) and only its body is unreadable — a genuine parsing failure.
  useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS_SCHEMA) },
    { match: 'commands show comments show/biz', stdout: JSON.stringify(GOOD_COMMENT_SCHEMA) },
    { match: 'commands list', stdout: JSON.stringify(GOOD_CATALOG) },
    {
      match: 'statuses show_batch/biz --ids 4331051486294436',
      // Right id, no body anywhere.
      stdout: JSON.stringify({ idstr: '4331051486294436', unexpected: 'shape' }),
    },
  ])
  try {
    const error = await adapter()
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.ok(error !== undefined, '正文读不出来必须失败')
    assert.equal(error!.code, 'malformed_response', `实际 ${error!.code}: ${error!.message}`)
  } finally {
    resetCli()
  }
})

test('集成：doctor 通过不等于读取可用——必须真的列出并校验命令', async () => {
  // §一.12: "不得因为 doctor 返回成功就宣布全部微博读取能力可用".
  useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands list', stdout: JSON.stringify({ commands: [] }) },
  ])
  try {
    const a = adapter()
    const error = await a
      .getThread(REF)
      .then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
    assert.equal(error!.code, 'command_unavailable')
    // And the capability table must not claim reads are available.
    const caps = a.getCapabilities()
    assert.equal(caps.thread, false)
    assert.equal(caps.replies, false)
    assert.equal(caps.authCheck, true, 'doctor 通过说明认证是好的')
  } finally {
    resetCli()
  }
})
