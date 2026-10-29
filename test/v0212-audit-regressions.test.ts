/**
 * v0.2.12 审计缺陷回归。
 *
 * ## 这个文件的存在理由
 *
 * 上面几个 v0212 测试是**按任务书写的**——它们验证「功能做对了」。这个文件是**按缺陷
 * 写的**——每条断言对应一个已经实测复现的 bug，防止它在未来某次「小改动」里悄悄回来。
 *
 * 每条的注释里都记着复现输入与当时的错误输出。没有这些记录，后续维护者会以为断言是
 * 随手写的。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation, inspectCommand, parseCliJson } from '../lib/platforms/weibo/cli.js'
import {
  projectCommentAsFloor,
  projectCommentAsNested,
  unwrapComments,
  unwrapStatus,
} from '../lib/platforms/weibo/projection.js'
import { renderBrief, type DebateBrief } from '../lib/brief.js'

// ---------------------------------------------------------------------------
// A1: 未知分页状态被当成「读完了」
// ---------------------------------------------------------------------------

test('审计 A1：既无 has_more 也无 cursor 时，必须按「可能还有」处理', () => {
  // 复现输入：{"comments":[{"id":"1"}]}
  // 当时输出：hasMore === false  →  采集器判定 confirmed_end → 后面 9 页永不请求，
  //           且 CollectedThread.complete === true
  // 病根：`cursor !== undefined` 在三元表达式最后一档，两个字段都没有时它是 false。
  const result = unwrapComments({ comments: [{ id: '1' }] })
  assert.equal(result.hasMore, true, '状态未知时必须保守地报「还有」')
  assert.equal(result.pagingState, 'unknown')
})

test('审计 A1：明确的三态判定', () => {
  assert.equal(unwrapComments({ comments: [], has_more: false }).pagingState, 'done')
  assert.equal(unwrapComments({ comments: [], has_more: true }).pagingState, 'more')
  assert.equal(unwrapComments({ comments: [], next_cursor: 'c1' }).pagingState, 'more')
  assert.equal(unwrapComments({ comments: [] }).pagingState, 'unknown')
  // 字符串形式的 0/1 也要认得（CLI 可能把布尔序列化成字符串）
  assert.equal(unwrapComments({ comments: [], has_more: '0' }).pagingState, 'done')
  assert.equal(unwrapComments({ comments: [], has_more: '1' }).pagingState, 'more')
})

// ---------------------------------------------------------------------------
// A2: {"data": [...]} 被读成「零条评论」
// ---------------------------------------------------------------------------

test('审计 A2：{"data":[...]} 这种常见包装不能被读成空列表', () => {
  // 复现输入：{"data":[{"id":"1"},{"id":"2"},{"id":"3"}]}
  // 当时输出：comments.length === 0
  // 病根：typeof [] === 'object'，容器选择先命中了数组本身，后续 Array.isArray 全部落空。
  const result = unwrapComments({ data: [{ id: '1' }, { id: '2' }, { id: '3' }] })
  assert.equal(result.comments.length, 3, `实际 ${result.comments.length}`)
})

test('审计 A2：对象形式的 data 仍然正常', () => {
  const result = unwrapComments({ data: { comments: [{ id: '1' }], total_number: 5 } })
  assert.equal(result.comments.length, 1)
  assert.equal(result.declaredTotal, 5)
})

// ---------------------------------------------------------------------------
// A3: 只有 id 没有正文的空壳被当成有效微博
// ---------------------------------------------------------------------------

test('审计 A3：只有 id 的响应必须判为不可用，而不是投影成空微博', () => {
  // 复现输入：{"idstr":"5012345678901234"}
  // 当时输出：一个 Thread，content 为空、无作者；错误在 analyzeDispute 才暴露，
  //           报的是「帖子里没有找到主人」，指向了完全错误的方向。
  assert.equal(unwrapStatus({ idstr: '5012345678901234' }), undefined)
  // 有 id 有正文就正常
  const ok = unwrapStatus({ idstr: '5012345678901234', text: '正文' })
  assert.ok(ok !== undefined)
  // long_text 也应当算正文
  const longOk = unwrapStatus({ idstr: '5012345678901234', long_text: '长正文' })
  assert.ok(longOk !== undefined)
})

// ---------------------------------------------------------------------------
// A4: 平台返回的 id 可能被当成命令行 flag
// ---------------------------------------------------------------------------

test('审计 A4：以 - 开头的 postId 必须被拒绝（参数注入）', () => {
  // 复现输入：projectCommentAsFloor({ idstr: '--output' })
  // 当时输出：接受，postId === '--output'
  // 后果：CLI 收到的 argv 变成
  //   comments/list <mid> --comment --output --page 1 --output json
  // `--comment` 的取值成了 `--output`，输出格式参数被搅乱。
  // 注意：这不是 shell 注入（execFile 用 argv 数组），是参数注入。
  for (const evil of ['--output', '-x', '--page', 'a b', 'a/b', '']) {
    assert.equal(
      projectCommentAsFloor({ idstr: evil, text: 'x' }),
      undefined,
      `不应接受 ${JSON.stringify(evil)}`,
    )
  }
  // 正常 id 不受影响
  assert.ok(projectCommentAsFloor({ idstr: '5001', text: 'x' }) !== undefined)
  assert.ok(projectCommentAsFloor({ idstr: 'Hd1N2qpta', text: 'x' }) !== undefined)
})

test('审计 A4：嵌套回复的父 id 也走同样的校验', () => {
  assert.equal(projectCommentAsNested({ idstr: '--evil', text: 'x' }, 'parent'), undefined)
})

// ---------------------------------------------------------------------------
// A5: schema 解析失败被当成「没有必填参数，所以可用」
// ---------------------------------------------------------------------------

test('审计 A5：认不出的 schema 结构必须判为不可用', async () => {
  // 复现输入：commands show 返回 {"name":"x/y","required":["mid"],"properties":{"mid":{}}}
  //           （标准 JSON Schema 形，旧 asArray 完全不认）
  // 当时输出：usable === true, required === []
  // 病根：`asArray(...) ?? []` 把「没解析出来」和「确实没有参数」合并成同一结论——
  //       而这正是 inspectCommand 存在的全部理由。
  const dir = mkdtempSync(join(tmpdir(), 'schema-'))
  const scriptPath = join(dir, 'script.json')
  writeFileSync(
    scriptPath,
    JSON.stringify({
      rules: [
        { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
        {
          match: 'commands show weird/shape',
          // A shape asArray cannot read: a bare string list under an unknown key.
          stdout: JSON.stringify({ name: 'weird/shape', arguments: 'mid,page' }),
        },
        {
          match: 'commands show std/schema',
          // Standard JSON Schema: sibling `required` array + properties map.
          stdout: JSON.stringify({
            name: 'std/schema',
            required: ['mid', 'uid'],
            properties: { mid: {}, uid: {} },
          }),
        },
      ],
    }),
    'utf8',
  )
  process.env.FAKE_CLI_SCRIPT = scriptPath
  __setCliInvocation({
    file: process.execPath,
    prefixArgs: [join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')],
  })
  try {
    const unknown = await inspectCommand('weird/shape')
    assert.equal(unknown.data?.evidence, 'unknown', '认不出的结构应标记为 unknown')
    assert.equal(unknown.data?.usable, false, '认不出就不能说可用')
    assert.match(unknown.data?.reason ?? '', /无法识别/)

    const standard = await inspectCommand('std/schema')
    assert.equal(standard.data?.evidence, 'parsed')
    assert.equal(standard.data?.usable, false, 'uid 填不了，所以不可用')
    assert.equal(standard.data?.required.includes('uid'), true, '兄弟 required 数组要读进来')
  } finally {
    __setCliInvocation(undefined)
    delete process.env.FAKE_CLI_SCRIPT
  }
})

// ---------------------------------------------------------------------------
// A6: 凭据脱敏漏掉了 JSON 解析错误
// ---------------------------------------------------------------------------

test('审计 A6：JSON 解析失败的原因必须脱敏', () => {
  // 复现：JSON.parse 的错误消息在新版 V8 里会带输入片段：
  //   Unexpected token 'a', "eyJhbGciOiJIUzI1NiIs..." is not valid JSON
  // 这条 reason 会经 WeiboCliError.message 进入日志、诊断面板与模型上下文。
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnop'
  const result = parseCliJson(`{"a": ${token}}`)
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.reason.includes(token), false, `原因里不能带 token：${result.reason}`)
  }
})

// ---------------------------------------------------------------------------
// A7: openQuestions 的方向被渲染反了
// ---------------------------------------------------------------------------

test('审计 A7：openQuestions 的标题必须与数据方向一致', () => {
  // 数据来源 analyzer.ts:82-83 = 「对方问、主人没答」
  // 当时渲染成「对方没有回答的问题」—— 把主人自己的回避说成对方的回避，
  // 模型据此会写出「你倒是回答我啊」，方向整个翻转。
  const brief: DebateBrief = {
    platform: 'tieba',
    threadId: 't1',
    targetPostId: 'p2',
    owner: { side: 'owner', summary: '主人主张', evidence: ['p1'] },
    opponent: { side: 'opponent', summary: '对方主张', evidence: ['p2'] },
    disagreements: ['分歧'],
    agreedFacts: [],
    arguments: [],
    challenges: [],
    openQuestions: ['你凭什么这么肯定？'],
    uncertainties: [],
    directions: ['rebut'],
    risks: [],
  }
  const text = renderBrief(brief)
  assert.match(text, /对方提出、主人尚未回应的问题/, `实际标题不对：\n${text}`)
  assert.equal(/## 对方没有回答的问题/.test(text), false, '旧标题必须消失')
})

// ---------------------------------------------------------------------------
// A8: 回复关系被解析后丢弃
// ---------------------------------------------------------------------------

test('审计 A8：reply_comment 的结构化信息要保留，不能解析后再丢弃', () => {
  // v0.2.10 解析了 payload.reply_comment 的 user，然后 `void repliedTo` 扔掉。
  // 微博明明给了结构化数据，比贴吧按昵称猜可靠得多。
  const nested = projectCommentAsNested(
    {
      idstr: '6001',
      text: '回复某条评论',
      reply_comment: {
        idstr: '5001',
        user: { idstr: '222', screen_name: '对手B' },
      },
    },
    '4001',
  )
  assert.ok(nested !== undefined)
  assert.equal(nested!.replyToPostId, '5001', '应保留被回复评论的 id')
  assert.equal(nested!.replyToName, '对手B')
})
