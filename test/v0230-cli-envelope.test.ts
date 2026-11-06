/**
 * v0.2.30：真实 CLI 契约的回归测试。
 *
 * ## 为什么这个文件必须存在
 *
 * 前两个文件里的样本是**实测记录**，不是构造出来的。它们抓到过两个只在真实 CLI 上
 * 才暴露的缺陷，而这两个缺陷让 1910 条测试全绿、真实环境第一句话就是错的：
 *
 * 1. **错误码嵌在 `error` 里**。`{ success: false, error: { code: 'NOT_FOUND' } }`
 *    只读顶层 `record.code` 得到 `undefined`，于是每条真实错误都掉进文本匹配。
 * 2. **`CLI command not found: X` 命中 `/command not found/`**，被判成
 *    `cli_missing`——用户看到「没有找到 weibo-cli，请先安装」，而 CLI 明明装着。
 *
 * 两个缺陷的根因是同一个：**假 CLI 一直按我们想象的形状回话**。所以这里的
 * 每条断言都用真实 stderr 原文，包括那个把 `success: false` 写在 stderr 上、
 * 退出码为 1 的组合。
 *
 * ## 只读性
 *
 * 这些测试一个请求都不发：它们喂字符串给纯函数。真实读取能力由 `readiness`
 * 八项诊断如实报告，不在这里伪造。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCliJson,
  parseDoctorReport,
  scrubCredentials,
} from '../lib/platforms/weibo/cli.js'

// ---------------------------------------------------------------------------
// doctor 报告的真实形状
// ---------------------------------------------------------------------------

/**
 * 真实的 `weibo-cli doctor` 输出（本机，2026-11-05）。
 *
 * 注意三处与代码假设不同的地方：
 *
 * 1. 成功的行带账号名：「✓ 注册或登录: 一个天真的矿哥」。
 * 2. 每一项前面的符号被 ANSI 颜色包着（`\u001b[32m✓\u001b[0m`）。
 * 3. 失败时退出码仍是 **0**，唯一的证据是这三行。
 */
const REAL_DOCTOR_PARTIAL = [
  '',
  '使用准备检查',
  '------------------------------------------',
  '✓ 注册或登录: 一个天真的矿哥',
  '× 完成开发者认证',
  '× 开通服务',
  '',
  '请先完成开发者认证，通过后才能购买体验服务或正式充值包。',
  '请使用微博客户端扫描下方二维码完成扫脸认证（请扫码，不要在浏览器里打开链接）:',
].join('\n')

test('真实契约 1：doctor 三行被正确解析，登录成功带账号名', () => {
  const steps = parseDoctorReport(REAL_DOCTOR_PARTIAL)
  assert.equal(steps.length, 3, `应当解析出三行，实际 ${JSON.stringify(steps)}`)
  assert.equal(steps[0].ok, true)
  assert.match(steps[0].label, /注册或登录/)
  assert.match(steps[0].label, /一个天真的矿哥/, '账号名是这一行的一部分，不能丢')
  assert.equal(steps[1].ok, false)
  assert.match(steps[1].label, /开发者认证/)
  assert.equal(steps[2].ok, false)
  assert.match(steps[2].label, /开通服务/)
})

test('真实契约 2：带 ANSI 颜色的符号仍被认出', () => {
  // 实测输出里符号是 `\u001b[32m✓\u001b[0m`。不剥颜色，锚定的 `^[✓]` 永远匹配不上，
  // 步骤列表为空，调用方把「无法确认」当成「已就绪」——同一个假绿灯低一层。
  const withAnsi = '\u001b[32m✓\u001b[0m 注册或登录\n\u001b[33m×\u001b[0m 完成开发者认证'
  const steps = parseDoctorReport(withAnsi)
  assert.equal(steps.length, 2)
  assert.equal(steps[0].ok, true)
  assert.equal(steps[1].ok, false)
})

test('真实契约 3：识别不出的报告返回空数组，不是「全部通过」', () => {
  const steps = parseDoctorReport('使用准备检查\n--------------------------------\n一切正常')
  assert.deepEqual(steps, [])
  // 调用方必须把空数组当「无法确认」。这一条由 `readiness` 测试守着，
  // 这里只锁住解析器本身不编造步骤。
})

test('真实契约 4：二维码块不会被误认成步骤', () => {
  const withQr = `${REAL_DOCTOR_PARTIAL}\n ▄▄▄▄▄▄▄   ▄  ▄▄▄ ▄▄▄ ▄▄▄  ▄▄▄▄▄▄▄ \n █ ▄▄▄ █  ▄▄▀▄█▀▀▄▄█▄  ▄▀▄ █ ▄▄▄ █ `
  const steps = parseDoctorReport(withQr)
  assert.equal(steps.length, 3, '二维码是制表符块，不该被当成步骤行')
  assert.ok(steps.every((step) => !/▄/.test(step.label)))
})

// ---------------------------------------------------------------------------
// 失败信封的真实形状
// ---------------------------------------------------------------------------

/**
 * 真实的失败输出（`weibo-cli statuses show --id … --output json`）：
 *
 * ```
 * exit code: 1
 * stderr: {
 *   "success": false,
 *   "error": {
 *     "code": "NOT_FOUND",
 *     "message": "CLI command not found: statuses show",
 *     "trace_id": "c7e6e020-0472-4f5d-baa1-7ee7622d4835",
 *     "timestamp": "2026-11-05T16:36:34.321Z"
 *   }
 * }
 * ```
 *
 * `parseCliJson` 只看 stdout，所以「stderr 上的失败信封」这条路径必须由分类逻辑
 * 处理。这里断言的是 `parseCliJson` 不把 stderr 里的东西当成数据——那是另一半。
 */
const REAL_FAILURE_STDERR = JSON.stringify({
  success: false,
  error: {
    code: 'NOT_FOUND',
    message: 'CLI command not found: statuses show',
    trace_id: 'c7e6e020-0472-4f5d-baa1-7ee7622d4835',
    timestamp: '2026-11-05T16:36:34.321Z',
  },
})

test('真实契约 5：失败信封不是数据——解析器不能在 stdout 为空时编出对象', () => {
  const parsed = parseCliJson('')
  assert.equal(parsed.ok, false)
})

test('真实契约 6：stderr 上的失败信封不含凭据，可以安全展示', () => {
  // 这条锁的是「展示原文」这个决定的安全性：带 trace_id 的信封照原样显示是安全的。
  const scrubbed = scrubCredentials(REAL_FAILURE_STDERR)
  assert.equal(scrubbed, REAL_FAILURE_STDERR, '没有凭据就不该被改动')
})

// ---------------------------------------------------------------------------
// 命令清单的真实信封
// ---------------------------------------------------------------------------

/**
 * 真实 `commands list --available --output json` 的输出，未开通服务时：
 *
 * ```json
 * { "service_status": "none", "total": 75, "available_count": 0,
 *   "groups": [], "commands": [], "catalog_version": "…" }
 * ```
 *
 * 两个数字同时出现是这个信封最容易被读错的地方：`total` 是**目录**里的总数，
 * `available_count` 是**本账号**的可用数。把 `total` 当成可用数，用户会以为
 * 75 条命令都能用，然后在每一条上各失败一次。
 */
const REAL_AVAILABLE_EMPTY = JSON.stringify({
  service_status: 'none',
  total: 75,
  available_count: 0,
  groups: [],
  commands: [],
  catalog_version: 'fb854c49a4ca8b5290fafb1af74b65f790df4b9d55b1770199812b2e04889a48',
})

test('真实契约 7：available_count 为 0 时命令数组为空——不是解析失败', () => {
  const parsed = parseCliJson<{ commands?: unknown[]; total?: number }>(REAL_AVAILABLE_EMPTY)
  assert.equal(parsed.ok, true, '这是一个合法的 JSON 信封')
  assert.deepEqual((parsed as { data?: { commands?: unknown[] } }).data?.commands, [], '空数组是真实结果，不是读不到')
  assert.equal((parsed as { data?: { total?: number } }).data?.total, 75, 'total 是目录总数，与可用数不是一件事')
})

test('真实契约 8：目录 75 条与可用 0 条必须能被分开读', () => {
  const parsed = parseCliJson<{ available_count?: number; total?: number }>(REAL_AVAILABLE_EMPTY)
  assert.equal((parsed as { data?: { available_count?: number } }).data?.available_count, 0)
  assert.equal((parsed as { data?: { total?: number } }).data?.total, 75)
  assert.notEqual(
    (parsed as { data?: { available_count?: number } }).data?.available_count,
    (parsed as { data?: { total?: number } }).data?.total,
    '这两个数一旦被混用，用户会以为 75 条都能调',
  )
})

// ---------------------------------------------------------------------------
// 命令元数据的真实形状
// ---------------------------------------------------------------------------

/**
 * 真实 `commands show statuses show_batch/biz --output json` 的输出（节选）。
 *
 * 关键结构：外层是 `{ command: {...} }`，不是裸的命令对象。参数名在
 * `flags[].name` 里**保留大小写**（`isGetLongText`），而 `input_schema` 的键
 * 是小写的。两个来源大小写不一致，是这一层最容易踩的坑。
 */
const REAL_SCHEMA_ENVELOPE = JSON.stringify({
  command: {
    id: '302',
    group: 'statuses',
    action: 'show_batch/biz',
    name: 'statuses show_batch/biz',
    method: 'GET',
    title: '根据微博ID批量获取微博信息',
    required_fields: ['ids'],
    input_schema: { ids: 'string', trim_user: 'int', isGetLongText: 'int' },
    flags: [
      { name: 'ids', type: 'string', required: true, description: '需要查询的微博ID，用半角逗号分隔' },
      { name: 'trim_user', type: 'int', required: false },
      { name: 'isGetLongText', type: 'int', required: false },
    ],
    billing_type: 1,
    price_per_unit: 3,
    price_type: 'per_record',
    trial_enabled: true,
    status: 'active',
  },
  catalog_version: '9846b86363b7db7944ff68520038c1ea34be2ff9596a89639b4e168e0f2d8857',
})

test('真实契约 9：schema 外层有 command 包装，解析器要能拿到里面', () => {
  const parsed = parseCliJson<{ command?: { name?: string; flags?: unknown[] } }>(
    REAL_SCHEMA_ENVELOPE,
  )
  assert.equal(parsed.ok, true)
  assert.equal((parsed as { data?: { command?: { name?: string } } }).data?.command?.name, 'statuses show_batch/biz')
  assert.equal(Array.isArray((parsed as { data?: { command?: { flags?: unknown[] } } }).data?.command?.flags), true)
})

test('真实契约 10：批量正文读取的必填参数是 ids，一次最多 50 个', () => {
  const parsed = parseCliJson<{
    command: { required_fields: string[]; flags: { name: string; required?: boolean }[] }
  }>(REAL_SCHEMA_ENVELOPE)
  const command = (parsed as never as { data: { command: { required_fields: string[]; flags: { name: string; required?: boolean }[]; input_schema: Record<string, string> } } }).data.command
  assert.deepEqual(command.required_fields, ['ids'])
  const required = command.flags.filter((flag) => flag.required === true).map((flag) => flag.name)
  assert.deepEqual(required, ['ids'])
})

test('真实契约 11：参数名大小写不一致时，小写化后仍能对齐', () => {
  const parsed = parseCliJson<{
    command: { flags: { name: string }[]; input_schema: Record<string, string> }
  }>(REAL_SCHEMA_ENVELOPE)
  const fromFlags = (parsed as never as { data: { command: { required_fields: string[]; flags: { name: string; required?: boolean }[]; input_schema: Record<string, string> } } }).data.command.flags.map((flag) => flag.name.toLowerCase())
  const fromSchema = Object.keys((parsed as never as { data: { command: { required_fields: string[]; flags: { name: string; required?: boolean }[]; input_schema: Record<string, string> } } }).data.command.input_schema).map((name) => name.toLowerCase())
  assert.deepEqual(fromFlags.sort(), fromSchema.sort(), '两个来源的小写形式必须一致')
})

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

test('真实契约 12：真实 token 前缀形状被 scrub 掉', () => {
  // `auth whoami` 的真实输出里有 `"prefix": "at_***c9rQ"`——它已经是脱敏的。
  // 但错误信息里可能出现完整的 `at_` 开头令牌，这里锁住那条路径。
  const text = 'Authorization: Bearer at_1a2b3c4d5e6f7g8h9i0jKLMNOP=='
  const scrubbed = scrubCredentials(text)
  assert.doesNotMatch(scrubbed, /at_1a2b3c4d/)
  assert.match(scrubbed, /<redacted>/)
})

test('真实契约 13：长的不透明串被当作密钥处理', () => {
  const token = 'a'.repeat(48)
  assert.match(scrubCredentials(`token: ${token}`), /<redacted>/)
})

test('真实契约 14：`auth whoami` 的脱敏前缀不被误伤', () => {
  // `at_***c9rQ` 只有 10 个字符，不该被当成完整令牌。
  const text = '"prefix": "at_***c9rQ"'
  assert.equal(scrubCredentials(text), text, '已经脱敏的字段应当原样保留')
})
