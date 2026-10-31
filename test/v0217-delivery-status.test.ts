/**
 * v0.2.17 §2 —— 交付状态报告必须能被机器读，也必须不撒谎。
 *
 * 这个东西存在的理由是 v0.2.16 那个真实事故：人写的验收报告里写着「发布提交 f1c111c」，
 * 而标签实际指向 `57ffec6`。不是笔误 —— 报告写在提交里，提交的 SHA 只有提交之后才知道，
 * 这个形式本身就不可能自洽。所以会变的数字交给发布当时生成的 JSON。
 *
 * 既然它是「证据」而不是「说明」，那它最容易犯的错就是把未知写成已知：
 * `'TBD'` 混进字段里，读的人会当成一个值；`0` 混进测试数里，读的人会当成「跑过了，全过」。
 * 下面大半测试都在钉这一条。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STATUS_SCHEMA,
  STATUS_VALUES,
  artifactOf,
  assertReportConsistent,
  createStatusReport,
  decodeTestLog,
  parseTestSummary,
  statusFileName,
} from '../scripts/lib/delivery-status.mjs'

// --- 测试日志解码 ---------------------------------------------------------

test('UTF-16LE 的测试日志必须能读出来', () => {
  // 本机实测：`node --test > full.txt` 在 PowerShell 里写出 UTF-16LE（开头 FF FE）。
  // 按 UTF-8 读会导致 summary 全 null，报告把「1170 项全过」记成「测试数为 0」。
  const text = ['ℹ tests 1170', 'ℹ pass 1170', 'ℹ fail 0', 'ℹ skipped 0'].join('\n')
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

  const summary = parseTestSummary(decodeTestLog(bytes))
  assert.equal(summary.total, 1170)
  assert.equal(summary.failed, 0)
  assert.equal(summary.consistent, true)
})

test('UTF-8 BOM 与无 BOM 都能读', () => {
  const text = 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n'
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])

  assert.equal(parseTestSummary(decodeTestLog(withBom)).total, 3)
  assert.equal(parseTestSummary(decodeTestLog(Buffer.from(text, 'utf8'))).total, 3)
})

test('不是 Buffer 也接受，不因类型不同就返回空', () => {
  const summary = parseTestSummary(decodeTestLog('ℹ tests 5\nℹ pass 5\nℹ fail 0\n'))
  assert.equal(summary.total, 5)
})

// --- 测试计数解析 ---------------------------------------------------------

test('解析 node --test 的汇总行', () => {
  const text = ['ℹ tests 1067', 'ℹ suites 0', 'ℹ pass 1066', 'ℹ fail 0', 'ℹ skipped 1'].join('\n')

  const summary = parseTestSummary(text)
  assert.equal(summary.total, 1067)
  assert.equal(summary.passed, 1066)
  assert.equal(summary.failed, 0)
  assert.equal(summary.skipped, 1)
  assert.equal(summary.consistent, true, '1066 + 0 + 1 = 1067')
})

test('解析旧格式的 # 前缀汇总行', () => {
  const text = ['# tests 12', '# pass 12', '# fail 0'].join('\n')
  const summary = parseTestSummary(text)
  assert.equal(summary.total, 12)
  assert.equal(summary.consistent, true, '没有 skipped 行时按 0 处理')
})

test('捞不到汇总行时返回 null，而不是 0', () => {
  // 这是最关键的一条：0 是「跑完了、一个都没过」，null 是「没跑/没读到」。
  // 把它们混成 0，会让「测试根本没启动」看起来像「只是没过」。
  const summary = parseTestSummary('编译错误：找不到模块\n')

  assert.equal(summary.total, null)
  assert.equal(summary.passed, null)
  assert.equal(summary.failed, null)
  assert.equal(summary.consistent, false)
})

test('总数与分项对不上时标记为不自洽', () => {
  // 少报一项通常意味着有测试进程崩了、汇总没写完。这种「差一点」最危险。
  const text = ['ℹ tests 100', 'ℹ pass 90', 'ℹ fail 3', 'ℹ skipped 1'].join('\n')
  const summary = parseTestSummary(text)

  assert.equal(summary.total, 100)
  assert.equal(summary.consistent, false, '90 + 3 + 1 = 94 ≠ 100')
})

test('空输入不会崩，返回未解析状态', () => {
  for (const input of ['', null, undefined]) {
    const summary = parseTestSummary(input)
    assert.equal(summary.total, null)
    assert.equal(summary.consistent, false)
  }
})

test('同一行里出现的多个数字不会被误当成计数', () => {
  const text = 'ℹ tests 5\nℹ pass 5\nℹ fail 0\nsome log line with tests 999 in the middle'
  const summary = parseTestSummary(text)
  assert.equal(summary.total, 5, '只认行首的汇总行')
})

// --- 报告骨架 -------------------------------------------------------------

test('新报告的未知字段一律是 null，不是空字符串或占位文本', () => {
  const report = createStatusReport({ version: '0.2.17' })

  assert.equal(report.schema, STATUS_SCHEMA)
  assert.equal(report.status, 'in_progress')
  assert.equal(report.stage, null)
  assert.equal(report.failure, null)
  assert.equal(report.github.commitSha, null)
  assert.equal(report.github.tag, null)
  assert.equal(report.tests.total, null)
  assert.deepEqual(report.artifacts, [])

  // 扫一遍全树，不允许出现任何「假装知道」的占位值。
  const serialized = JSON.stringify(report)
  for (const placeholder of ['TBD', 'TODO', '待补充', 'N/A', 'unknown', 'xxx']) {
    assert.equal(serialized.includes(placeholder), false, `报告里不该出现占位值 ${placeholder}`)
  }
})

test('unverified 明确区分「没有遗漏」和「没写」', () => {
  const report = createStatusReport({ version: '0.2.17' })
  assert.ok(Array.isArray(report.unverified), '必须是数组：空数组 = 没有遗漏项')
  assert.deepEqual(report.unverified, [])
})

test('报告结构里带 schema 版本，读取方可以据此拒绝旧格式', () => {
  const report = createStatusReport({ version: '0.2.17' })
  assert.equal(typeof report.schema, 'number')
  assert.equal(report.schema, STATUS_SCHEMA)
})

test('状态取值集合是封闭的，避免各脚本自己发明状态词', () => {
  assert.deepEqual(STATUS_VALUES, ['in_progress', 'success', 'failed', 'blocked'])
})

test('报告文件名固定，让 workflow / 脚本 / 文档引用同一个名字', () => {
  assert.equal(statusFileName('0.2.17'), 'delivery-status-0.2.17.json')
})

// --- 附件描述 -------------------------------------------------------------

const HASH = 'a'.repeat(64)

test('附件描述接受合法输入，并把哈希归一成小写', () => {
  const artifact = artifactOf({ name: 'dsh-ai-debate-0.2.17.tgz', bytes: 1234, sha256: 'A'.repeat(64), kind: 'install' })

  assert.equal(artifact.sha256, HASH)
  assert.equal(artifact.bytes, 1234)
  assert.equal(artifact.kind, 'install')
})

test('附件描述拒绝残缺的事实', () => {
  // 这些都不是「凑合能用」，是「这条证据无效」。宁可抛错，也不要发出半条证据。
  assert.throws(() => artifactOf({ name: '', bytes: 1, sha256: HASH }), /必须有名/)
  assert.throws(() => artifactOf({ name: 'a.tgz', bytes: 0, sha256: HASH }), /字节数/)
  assert.throws(() => artifactOf({ name: 'a.tgz', bytes: -1, sha256: HASH }), /字节数/)
  assert.throws(() => artifactOf({ name: 'a.tgz', bytes: 1.5, sha256: HASH }), /字节数/)
  assert.throws(() => artifactOf({ name: 'a.tgz', bytes: 1, sha256: 'abc' }), /sha256/)
  assert.throws(() => artifactOf({ name: 'a.tgz', bytes: 1, sha256: null }), /sha256/)
})

test('附件描述拒绝把 TBD 之类的占位文本当哈希', () => {
  assert.throws(() => artifactOf({ name: 'a.tgz', bytes: 1, sha256: 'TBD' }), /sha256/)
})

// --- 自洽校验 -------------------------------------------------------------

/** 造一份「声称成功」的报告，用来一次只破坏一个字段。 */
function successfulReport() {
  const report = createStatusReport({ version: '0.2.17' })
  report.status = 'success'
  report.stage = 'done'
  report.github.commitSha = 'c'.repeat(40)
  report.github.tag = 'v0.2.17'
  report.tests = { files: 91, total: 1100, passed: 1099, failed: 0, skipped: 1 }
  report.artifacts = [artifactOf({ name: 'a.tgz', bytes: 10, sha256: HASH, kind: 'install' })]
  return report
}

test('字段齐全的成功报告能通过校验', () => {
  assert.doesNotThrow(() => assertReportConsistent(successfulReport()))
})

test('声称成功却没有提交 SHA 要报错', () => {
  const report = successfulReport()
  report.github.commitSha = null
  assert.throws(() => assertReportConsistent(report), /commitSha/)
})

test('声称成功却没有标签要报错', () => {
  const report = successfulReport()
  report.github.tag = null
  assert.throws(() => assertReportConsistent(report), /tag/)
})

test('声称成功却没有附件要报错', () => {
  const report = successfulReport()
  report.artifacts = []
  assert.throws(() => assertReportConsistent(report), /附件/)
})

test('声称成功但测试数为 0 要报错', () => {
  // 这条对应真实场景：测试命令因为路径写错一个都没跑，退出码却是 0。
  const report = successfulReport()
  report.tests = { files: 0, total: 0, passed: 0, failed: 0, skipped: 0 }
  assert.throws(() => assertReportConsistent(report), /测试数/)
})

test('声称成功但测试总数是 null 也要报错', () => {
  const report = successfulReport()
  report.tests = { files: null, total: null, passed: null, failed: null, skipped: null }
  assert.throws(() => assertReportConsistent(report), /测试数/)
})

test('声称成功但有失败测试要报错', () => {
  const report = successfulReport()
  report.tests = { files: 91, total: 1100, passed: 1098, failed: 2, skipped: 0 }
  assert.throws(() => assertReportConsistent(report), /失败数/)
})

test('failed 与 blocked 必须写明 failure', () => {
  for (const status of ['failed', 'blocked']) {
    const report = successfulReport()
    report.status = status
    report.failure = null
    assert.throws(() => assertReportConsistent(report), /failure/, `${status} 必须带 failure`)
  }
})

test('failed 状态即使缺 commitSha 也能通过（失败报告的价值是说明失败）', () => {
  const report = createStatusReport({ version: '0.2.17' })
  report.status = 'failed'
  report.stage = 'verify'
  report.failure = { stage: 'verify', reason: '测试失败', recovery: ['修好再跑'] }
  report.tests = { files: null, total: 10, passed: 8, failed: 2, skipped: 0 }

  assert.doesNotThrow(() => assertReportConsistent(report))
})

test('status 不在取值集合里要报错', () => {
  const report = successfulReport()
  report.status = 'green'
  assert.throws(() => assertReportConsistent(report), /status/)
})

test('schema 不对要报错，避免旧格式被当成新格式读', () => {
  const report = successfulReport()
  report.schema = 999
  assert.throws(() => assertReportConsistent(report), /schema/)
})

test('version 不是三段数字要报错', () => {
  const report = successfulReport()
  report.version = 'v0.2.17'
  assert.throws(() => assertReportConsistent(report), /version/)
})

test('多个问题会一起报出来，而不是只报第一个', () => {
  const report = successfulReport()
  report.github.commitSha = null
  report.github.tag = null

  try {
    assertReportConsistent(report)
    assert.fail('应当抛错')
  } catch (error) {
    assert.match(error.message, /commitSha/)
    assert.match(error.message, /tag/)
  }
})

test('校验成功时把报告原样返回，方便链式使用', () => {
  const report = successfulReport()
  assert.equal(assertReportConsistent(report), report)
})
