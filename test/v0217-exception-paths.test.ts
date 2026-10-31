/**
 * v0.2.17 §七：五类异常路径，必须**失败得干净**，不能「错误地合并」或「错误地发布」。
 *
 * ## 为什么这组测试不能省
 *
 * 自动化交付最危险的不是「跑挂了」，而是「跑绿了但做了不该做的事」。挂掉会有人去看；
 * 悄悄把一个需要授权的提交合进 main、或者把一份哈希对不上的说明发出去，往往等发现时
 * 已经收不回来了。所以任务书要求逐条验证：
 *
 * 1. **故意测试失败** —— 不能因为汇总解析不出来就当成「零失败」放行。
 * 2. **凭据扫描失败** —— 命中真凭据形状必须构建失败，而不是打印警告继续。
 * 3. **网络中断** —— 状态必须落盘，重跑能从那一步接上，而不是从头再来一遍副作用。
 * 4. **重复发布** —— 同名标签指向别的提交时拒绝而不是移动它；附件字节数不一致时拒绝而不是覆盖。
 * 5. **缺少授权** —— 敏感改动必须停在 PR，不能启用自动合并。
 *
 * ## 边界
 *
 * 这里测的是**决策与真实脚本的退出码**，不测 GitHub 服务端行为。真实的合并与发布行为
 * 由 §七 的端到端演练给出证据，那部分不能靠这里的断言代替。两者都写进验收报告。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertReportConsistent, createStatusReport, parseTestSummary } from '../scripts/lib/delivery-status.mjs'
import { RECOVERY, STAGES, decideRelease, decideTag, nextStep, restoreState, createShipState, advanceState } from '../scripts/lib/ship-core.mjs'
import { createTgz } from '../scripts/tar.mjs'

const REPO = join(import.meta.dirname, '..')
const SCANNER = join(REPO, 'scripts', 'scan-archive.mjs')
const PACKER = join(REPO, 'scripts', 'source-zip.mjs')

/**
 * 跑一个脚本，返回退出码与合并后的输出。不抛异常 —— 我们就是来看它怎么失败的。
 *
 * 必须把 `NODE_TEST_CONTEXT` 从环境里摘掉：本文件本身就跑在 node 的测试运行器里，
 * 子进程继承这个变量后会以为自己是「被父运行器管理的子测试进程」，于是**失败的用例
 * 也会以退出码 0 结束**。第一版就栽在这里 —— 一条断言「失败的测试必须让进程退出码非 0」
 * 的测试，自己拿到了 0。
 */
function runScript(script, scriptArgs, cwd) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT

  try {
    const stdout = execFileSync(process.execPath, [script, ...scriptArgs], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// --- 一、故意测试失败 ------------------------------------------------------

test('故意失败的测试不会因为汇总行解析不出来而被当成通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exc-test-'))
  try {
    writeFileSync(
      join(dir, 'broken.test.mjs'),
      [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "test('这个用例故意失败', () => { assert.equal(1, 2, '故意失败') })",
        '',
      ].join('\n'),
      'utf8',
    )

    const result = runScript('--test', ['broken.test.mjs'], dir)
    assert.notEqual(result.code, 0, '失败的测试必须让进程退出码非 0')

    // 汇总行可能因为报告器不同而长得不一样；关键性质是「不能解析成全部通过」。
    const summary = parseTestSummary(result.output)
    if (summary !== null) {
      assert.ok(summary.failed > 0 || summary.total === 0, `汇总不能显示成零失败：${JSON.stringify(summary)}`)
      assert.notEqual(summary.consistent && summary.failed === 0, true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('声称成功但有失败项的交付状态报告会被拒绝', () => {
  const report = createStatusReport({ version: '9.9.9' })
  report.status = 'success'
  report.github.commitSha = 'a'.repeat(40)
  report.github.tag = 'v9.9.9'
  report.artifacts = [{ name: 'x.tgz', bytes: 1, sha256: 'b'.repeat(64), kind: 'install' }]
  report.tests = { files: 1, total: 10, passed: 9, failed: 1, skipped: 0 }

  assert.throws(() => assertReportConsistent(report), /失败数是 1/)
})

test('测试数为 0 不能当作成功', () => {
  const report = createStatusReport({ version: '9.9.9' })
  report.status = 'success'
  report.github.commitSha = 'a'.repeat(40)
  report.github.tag = 'v9.9.9'
  report.artifacts = [{ name: 'x.tgz', bytes: 1, sha256: 'b'.repeat(64), kind: 'install' }]
  report.tests = { files: 0, total: 0, passed: 0, failed: 0, skipped: 0 }

  // 一个什么都没跑的测试流程，和全跑过是一样的绿色 —— 所以这条必须由报告自己拒绝。
  assert.throws(() => assertReportConsistent(report), /测试数为 0/)
})

// --- 二、凭据扫描失败 ------------------------------------------------------

test('含假凭据的安装包会被独立扫描器判为失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exc-scan-'))
  try {
    // 造一个真的 .tgz：扫描器读的是字节，不是文件名清单，所以必须让它真的能解开。
    const tgz = createTgz([
      { path: 'package/package.json', data: Buffer.from(JSON.stringify({ name: 'fixture', version: '9.9.9' })) },
      { path: 'package/.env', data: Buffer.from('FAKE_API_KEY=fixture-v0217-should-be-caught-0001\n') },
    ])
    const target = join(dir, 'fixture-9.9.9.tgz')
    writeFileSync(target, tgz)

    const result = runScript(SCANNER, [target], dir)
    assert.notEqual(result.code, 0, '含 .env 的归档必须扫描失败')
    assert.match(result.output, /\.env/, '输出里要指出命中的是哪一条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('干净归档能被扫描器放行（否则上一条测试奖励一个永远失败的扫描器）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exc-scan-ok-'))
  try {
    const tgz = createTgz([
      { path: 'package/package.json', data: Buffer.from(JSON.stringify({ name: 'fixture', version: '9.9.9' })) },
      { path: 'package/lib/index.js', data: Buffer.from('export const name = "fixture"\n') },
    ])
    const target = join(dir, 'fixture-9.9.9.tgz')
    writeFileSync(target, tgz)

    const result = runScript(SCANNER, [target], dir)
    assert.equal(result.code, 0, `干净归档应放行，实际：${result.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('白名单目录里出现真凭据形状时打包直接失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exc-pack-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'exc-fixture', version: '9.9.9' }), 'utf8')
    writeFileSync(join(dir, 'LICENSE'), 'AGPL-3.0 fixture\n', 'utf8')
    writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const name = "fixture"\n', 'utf8')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'source-zip.mjs'), readFileSync(PACKER), 'utf8')

    // 放在 src/ 下面 —— 这个目录是白名单，所以「文件名过滤」救不了它，
    // 只有字节级扫描能拦住。这正是 v0.2.15 加的那一层。
    //
    // 值里不能出现 example/fixture/fake 之类的字样：扫描器会把那类行当作测试夹具放行，
    // 而这条测试要证明的正是「不带标记的真凭据形状会被拦住」。第一版用了
    // `AKIAIOSFODNN7EXAMPLE`，被自己的夹具豁免规则放过去了 —— 断言写错方向时，
    // 测试会安静地变绿。
    writeFileSync(join(dir, 'src', 'leaked.ts'), 'export const key = "AKIAQYLPMN5HHMWUZ7AG"\n', 'utf8')

    const result = runScript(join(dir, 'scripts', 'source-zip.mjs'), [], dir)
    assert.notEqual(result.code, 0, '白名单目录里的真凭据形状必须让打包失败')
    assert.match(result.output, /AWS/, '输出里要指出命中的是哪一类凭据')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- 三、网络中断 ----------------------------------------------------------

test('每个阶段都有恢复建议，中断后不会「不知道下一步做什么」', () => {
  for (const stage of STAGES) {
    assert.ok(Array.isArray(RECOVERY[stage]), `${stage} 缺少恢复建议数组`)
  }
  // 最容易出事的几个阶段必须有实质内容，不能是空数组占位。
  for (const stage of ['verify', 'push', 'wait_checks', 'tag', 'release', 'verify_release']) {
    assert.ok(RECOVERY[stage].length > 0, `${stage} 的恢复建议不能为空`)
  }
})

test('中断后能从落盘的阶段继续，而不是从头再来一遍副作用', () => {
  const state = createShipState({ version: '9.9.9' })
  advanceState(state, { to: 'push', detail: { github: { branch: 'release/v9.9.9-auto', commitSha: 'c'.repeat(40) } } })

  // 模拟「进程被杀，从磁盘读回来」：JSON 往返一次，和真实读文件一样。
  const restored = restoreState(JSON.parse(JSON.stringify(state)), { version: '9.9.9' })
  assert.notEqual(restored, null)
  assert.equal(restored.stage, 'push')
  assert.equal(restored.github.commitSha, 'c'.repeat(40))
})

test('版本不同的状态文件不会被误当成续跑依据', () => {
  const state = createShipState({ version: '9.9.9' })
  advanceState(state, { to: 'release' })

  // 拿另一个版本的状态去续跑，会把这一版的分支/标签信息带错，必须直接拒绝。
  assert.equal(restoreState(state, { version: '8.8.8' }), null)
})

// --- 四、重复发布 ----------------------------------------------------------

test('同名标签指向别的提交时拒绝移动它', () => {
  const decision = decideTag({
    tagExists: true,
    tagCommit: '1111111111111111111111111111111111111111',
    expectedCommit: '2222222222222222222222222222222222222222',
  })
  assert.equal(decision.action, 'refuse')
  // 移动已发布标签会让已经下载过产物的人无法复现 —— 恢复建议里必须说清这一点。
  assert.match(decision.reason, /标签|指向|移动/)
})

test('同名标签已经指向本次提交时复用它，而不是重建', () => {
  const decision = decideTag({
    tagExists: true,
    tagCommit: 'a'.repeat(40),
    expectedCommit: 'a'.repeat(40),
  })
  assert.equal(decision.action, 'reuse')
})

test('不知道标签该指向哪里时也拒绝', () => {
  assert.equal(decideTag({ tagExists: false, tagCommit: null, expectedCommit: null }).action, 'refuse')
  assert.equal(decideTag({ tagExists: true, tagCommit: 'a'.repeat(40), expectedCommit: '' }).action, 'refuse')
})

test('Release 已存在且附件字节数不一致时拒绝覆盖', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: [{ name: 'dsh-ai-debate-9.9.9.tgz', bytes: 100 }],
    localAssets: [{ name: 'dsh-ai-debate-9.9.9.tgz', bytes: 200 }],
  })
  assert.equal(decision.action, 'refuse')
})

test('Release 已存在且附件一致时复用，重复运行不会变成两次发布', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: [{ name: 'dsh-ai-debate-9.9.9.tgz', bytes: 100 }],
    localAssets: [{ name: 'dsh-ai-debate-9.9.9.tgz', bytes: 100 }],
  })
  assert.equal(decision.action, 'reuse')
})

// --- 五、缺少授权 ----------------------------------------------------------

test('敏感改动停在 PR：不放行自动合并', () => {
  const decision = nextStep({ stage: 'pull_request', sensitive: true })
  assert.equal(decision.blocked, true)
  // 给维护者读的理由里必须出现「授权」，否则 PR 上看到的人不知道自己在批准什么。
  assert.match(decision.reason, /授权/)
})

test('不敏感的改动才允许自动合并', () => {
  const decision = nextStep({ stage: 'pull_request', sensitive: false })
  assert.equal(decision.blocked, false)
})

test('标签决策被拒时停在 tag 阶段，不会带着错误标签去发布', () => {
  const decision = decideTag({
    tagExists: true,
    tagCommit: '1'.repeat(40),
    expectedCommit: '2'.repeat(40),
  })
  const step = nextStep({ stage: 'tag', tagDecision: decision })
  assert.equal(step.blocked, true)
})

test('blocked 永远是显式布尔值，调用方不必猜 undefined 是什么意思', () => {
  for (const stage of STAGES) {
    const decision = nextStep({ stage })
    assert.equal(typeof decision.blocked, 'boolean', `${stage} 的 blocked 不是布尔值`)
  }
})
