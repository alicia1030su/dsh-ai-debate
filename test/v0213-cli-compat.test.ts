/**
 * v0.2.13 §五：与官方 `weibo-cli` 的命令层兼容。
 *
 * ## 这个文件防的是什么
 *
 * v0.2.12 的三处假设与官方 CLI 的真实行为相反，而那时**没有任何测试能发现**，因为它测的
 * 是「假 CLI 按我写的语法回答」。假 CLI 是我写的，语法也是我写的，两者当然一致。
 *
 * 所以这里断言的**不是适配层内部状态，而是真正 spawn 出去的 argv**。每条都写明官方源码
 * 在哪一行做出这个决定，改坏时能立刻看出是哪一条断了。
 *
 * 官方依据均来自 `@weibo-ai/weibo-cli@0.9.8` 的发行代码（本机无 CLI，故只读解包核对）：
 * - `main.js`：`const group = rest[0]; const action = rest[1]; if (!group || !action) throw
 *   new Error('Usage: weibo-cli commands show <group> <action>')`
 * - `main.js`：`handleInvoke = async (group, action, flags) => …`，调用处
 *   `handleInvoke(command, subcommand, flags)` —— 签名里没有 `rest`，位置参数被丢弃
 * - `main.js`：`body: { group, action, args }`，`args` 来自 `flags`
 * - `main.js`：目录行用 `` `${cmd.group} ${cmd.action}` `` 渲染
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation, inspectCommand, listAvailableCommands } from '../lib/platforms/weibo/cli.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')

interface Rig {
  readonly logPath: string
  readonly reset: () => void
  readonly calls: () => string[][]
}

function useFakeCli(rules: readonly unknown[]): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'cli-v0213-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  return {
    logPath,
    reset: () => {
      __setCliInvocation(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
    calls: () => {
      const text = readFileSync(logPath, 'utf8')
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[])
    },
  }
}

const CATALOG = {
  commands: [
    { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
    { group: 'comments', action: 'show/biz', access: 'allowed' },
  ],
  total: 2,
  available_count: 2,
}

const STATUS_SCHEMA = {
  group: 'statuses',
  action: 'show_batch/biz',
  flags: [
    { name: 'ids', type: 'string', required: true },
    { name: 'isGetLongText', type: 'boolean' },
  ],
}

const COMMENT_SCHEMA = {
  group: 'comments',
  action: 'show/biz',
  flags: [
    { name: 'id', type: 'string', required: true },
    { name: 'page', type: 'number' },
    { name: 'count', type: 'number' },
    { name: 'cid', type: 'string' },
  ],
}

const BASE_RULES = [
  { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
  { match: 'doctor', stdout: 'ok\n' },
  { match: 'commands list', stdout: JSON.stringify(CATALOG) },
  { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(STATUS_SCHEMA) },
  { match: 'commands show comments show/biz', stdout: JSON.stringify(COMMENT_SCHEMA) },
  {
    match: 'statuses show_batch/biz',
    stdout: JSON.stringify({
      idstr: '4331051486294436',
      text: '这条说法站不住脚，请拿出证据。',
      user: { id: 111, idstr: '111', screen_name: '主人' },
    }),
  },
  {
    match: 'comments show/biz',
    stdout: JSON.stringify({
      comments: [
        { id: 5001, idstr: '5001', text: '你凭什么这么说？', user: { id: 222, idstr: '222', screen_name: '对手B' } },
      ],
      has_more: false,
    }),
  },
]

const REF = { platform: 'weibo' as const, threadId: '4331051486294436', url: 'https://m.weibo.cn/detail/4331051486294436' }

// ---------------------------------------------------------------------------
// 1. `commands show` 必须收到两个参数
// ---------------------------------------------------------------------------

test('官方兼容：commands show 收到 group 与 action 两个参数（不是一个合并名）', async () => {
  // 官方 `main.js`：`const group = rest[0]; const action = rest[1]; if (!group || !action) throw`。
  // 少传一个必然抛错，v0.2.12 因此一次都没成功过。
  const rig = useFakeCli(BASE_RULES)
  try {
    const result = await inspectCommand({ group: 'statuses', action: 'show_batch/biz' })
    assert.equal(result.status, 'ok', `inspectCommand 应成功：${result.message}`)

    const showCalls = rig.calls().filter((argv) => argv[0] === 'commands' && argv[1] === 'show')
    assert.equal(showCalls.length, 1, `应有且只有一次 commands show，实际 ${showCalls.length}`)
    const argv = showCalls[0]!
    assert.equal(argv[2], 'statuses', `第三个 argv 应是 group，实际 ${argv[2]}`)
    assert.equal(argv[3], 'show_batch/biz', `第四个 argv 应是 action，实际 ${argv[3]}`)
    // 合并成一个字符串是 v0.2.12 的写法，必须不再出现。
    assert.equal(
      argv.includes('statuses show_batch/biz'),
      false,
      `不得把 group 和 action 合并成一个 argv：${JSON.stringify(argv)}`,
    )
  } finally {
    rig.reset()
  }
})

// ---------------------------------------------------------------------------
// 2. 目录字段是 group/action
// ---------------------------------------------------------------------------

test('官方兼容：目录读的是 group/action，不是 name', async () => {
  // 官方渲染用 `${cmd.group} ${cmd.action}`；v0.2.12 找 `name`，于是每一行都被跳过、目录恒为空。
  const rig = useFakeCli(BASE_RULES)
  try {
    const result = await listAvailableCommands()
    assert.equal(result.status, 'ok', result.message)
    const rows = result.data ?? []
    assert.equal(rows.length, 2, `应读出两行，实际 ${rows.length}`)
    assert.deepEqual(
      rows.map((row) => `${row.group} ${row.action}`),
      ['statuses show_batch/biz', 'comments show/biz'],
    )
    // `name` 仍要提供，因为它是展示与日志里用的合并形式。
    assert.equal(rows[0]!.name, 'statuses show_batch/biz')
    assert.equal(rows[0]!.access, 'allowed')
  } finally {
    rig.reset()
  }
})

test('官方兼容：目录里 locked 的行仍会被列出，但打标', async () => {
  const rig = useFakeCli([
    ...BASE_RULES.filter((rule) => (rule as { match: string }).match !== 'commands list'),
    {
      match: 'commands list',
      stdout: JSON.stringify({
        commands: [
          { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
          { group: 'search', action: 'statuses/limited', access: 'locked' },
        ],
      }),
    },
  ])
  try {
    const rows = (await listAvailableCommands()).data ?? []
    assert.equal(rows.length, 2)
    assert.equal(rows.find((row) => row.group === 'search')?.access, 'locked')
  } finally {
    rig.reset()
  }
})

// ---------------------------------------------------------------------------
// 3. 帖子 id 必须是 flag，不能是位置参数
// ---------------------------------------------------------------------------

test('官方兼容：帖子 id 以 --ids flag 传，绝不作为位置参数', async () => {
  // 官方 `handleInvoke(group, action, flags)` 没有 rest 形参，位置参数被**静默丢弃**：
  // 不报错、请求照发、但不带 id。这比报错更危险，所以必须断言 argv 形状。
  const rig = useFakeCli(BASE_RULES)
  try {
    await weiboProvider.createAdapter({ settings: {} }).getThread(REF)
    const reads = rig
      .calls()
      .filter((argv) => argv[0] === 'statuses' && argv[1] === 'show_batch/biz')
    assert.equal(reads.length > 0, true, `应至少发起一次正文读取`)
    const argv = reads[0]!
    assert.equal(argv.includes('--ids'), true, `id 必须作为 --ids flag：${JSON.stringify(argv)}`)
    assert.equal(argv.includes('4331051486294436'), true, 'id 的值要跟着 flag')
    // 位置参数形式：id 紧跟在 action 后面（argv[2] 就是 id）。
    assert.notEqual(
      argv[2],
      '4331051486294436',
      `id 不能是位置参数（会被 CLI 丢弃）：${JSON.stringify(argv)}`,
    )
  } finally {
    rig.reset()
  }
})

// ---------------------------------------------------------------------------
// 4. 参数列表来自 flags
// ---------------------------------------------------------------------------

test('官方兼容：参数列表从 flags 读，required 也随之', async () => {
  // 官方 `commands show` 的 payload 把参数放在 `flags`，每项 `{name, type, required}`。
  // v0.2.12 从不看这个字段，于是每条命令都被解析成「没有参数」，可用性判断从空列表出发。
  const rig = useFakeCli(BASE_RULES)
  try {
    const result = await inspectCommand({ group: 'comments', action: 'show/biz' })
    assert.equal(result.status, 'ok', result.message)
    const schema = result.data!
    assert.equal(schema.evidence, 'parsed', 'flags 在，参数列表就该解析成功')
    assert.deepEqual([...schema.parameters].sort(), ['cid', 'count', 'id', 'page'])
    assert.deepEqual(schema.required, ['id'])
    assert.equal(schema.usable, true, `id 可以填，应判为可用：${schema.reason ?? ''}`)
    // 父评论筛选参数从 flags 里发现，不是硬编码候选表。
    assert.equal(schema.nestedFilterFlag, 'cid')
  } finally {
    rig.reset()
  }
})

test('官方兼容：required 里的参数填不了就拒绝，不猜', async () => {
  const rig = useFakeCli([
    ...BASE_RULES.filter((rule) => (rule as { match: string }).match !== 'commands show comments show/biz'),
    {
      match: 'commands show comments show/biz',
      stdout: JSON.stringify({
        group: 'comments',
        action: 'show/biz',
        // `since` is required but this layer cannot supply it.
        flags: [{ name: 'id', required: true }, { name: 'since', required: true }],
      }),
    },
  ])
  try {
    const result = await inspectCommand({ group: 'comments', action: 'show/biz' })
    assert.equal(result.data?.usable, false, '填不了的必填参数 → 不可用')
    assert.match(result.data?.reason ?? '', /since/)
  } finally {
    rig.reset()
  }
})

// ---------------------------------------------------------------------------
// 5. 分页与 page-size 只在命令声明时才发
// ---------------------------------------------------------------------------

test('官方兼容：命令没声明 --page 时不发 --page（否则 CLI 会报 Unknown option）', async () => {
  // 官方有 `assertKnownFlags`：传了未声明的 flag 直接 `Unknown option` 报错。
  // 对第一页强行加 --page 会把一次能成功的读取变成硬失败。
  const rig = useFakeCli([
    ...BASE_RULES.filter((rule) => (rule as { match: string }).match !== 'commands show comments show/biz'),
    {
      match: 'commands show comments show/biz',
      // 没有 page，也没有 count。
      stdout: JSON.stringify({
        group: 'comments',
        action: 'show/biz',
        flags: [{ name: 'id', required: true }],
      }),
    },
  ])
  try {
    await weiboProvider
      .createAdapter({ settings: {} })
      .getReplies(REF, 1)
      .catch(() => undefined)
    const reads = rig.calls().filter((argv) => argv[0] === 'comments' && argv[1] === 'show/biz')
    assert.equal(reads.length > 0, true, '应发起评论读取')
    const argv = reads[0]!
    assert.equal(argv.includes('--page'), false, `不得发未声明的 --page：${JSON.stringify(argv)}`)
    assert.equal(argv.includes('--count'), false, `不得发未声明的 --count：${JSON.stringify(argv)}`)
  } finally {
    rig.reset()
  }
})

test('官方兼容：命令声明了 --count 时才带页大小，且不超过手册的 20', async () => {
  const rig = useFakeCli(BASE_RULES)
  try {
    await weiboProvider.createAdapter({ settings: {} }).getReplies(REF, 1)
    const reads = rig.calls().filter((argv) => argv[0] === 'comments' && argv[1] === 'show/biz')
    const argv = reads[0]!
    const at = argv.indexOf('--count')
    assert.notEqual(at, -1, `声明了 count 就该发：${JSON.stringify(argv)}`)
    const size = Number(argv[at + 1])
    assert.equal(Number.isInteger(size), true)
    assert.equal(size <= 20, true, `页大小不得超过手册上限 20，实际 ${size}`)
  } finally {
    rig.reset()
  }
})

// ---------------------------------------------------------------------------
// 6. 失败信封在 stderr
// ---------------------------------------------------------------------------

test('官方兼容：错误体在 stderr 且是 JSON 信封时，能按 code 分类', async () => {
  // 官方 `formatError` 在显式 --output 时把 `{success:false,status,code,message}` 写到 stderr。
  // 读 code 比在文本里找关键字可靠。
  const rig = useFakeCli([
    ...BASE_RULES.filter((rule) => (rule as { match: string }).match !== 'statuses show_batch/biz'),
    {
      match: 'statuses show_batch/biz',
      stderr: JSON.stringify({
        success: false,
        status: 403,
        code: 'SERVICE_REQUIRED',
        message: '需要开通服务',
      }),
      exit: 1,
    },
  ])
  try {
    const error = await weiboProvider
      .createAdapter({ settings: {} })
      .getThread(REF)
      .then(
        () => undefined,
        (caught: { code?: string; message?: string }) => caught,
      )
    assert.notEqual(error, undefined, '必须失败')
    assert.equal(
      error!.code,
      'service_inactive',
      `SERVICE_REQUIRED 应映射为 service_inactive，实际 ${error!.code}：${error!.message}`,
    )
  } finally {
    rig.reset()
  }
})
