/**
 * v0.2.17 §1 —— 交付流水线的「决策」必须能在没有网络、没有 git、没有 GitHub 的情况下测。
 *
 * `scripts/ship.mjs` 本身是一个副作用集合：建分支、推、提 PR、合并、打标签。它跑一次
 * 就改变远端状态，所以不能靠「多跑几次看看」来验证。真正需要被反复验证的是它**怎么判断**
 * ——该不该停、标签能不能建、Release 能不能覆盖。这些判断抽在 `scripts/lib/ship-core.mjs`
 * 里，纯函数，没有副作用，于是可以在这里逐条钉死。
 *
 * 这里刻意不去测 `ship.mjs` 的编排：那需要替身（fake gh/fake git），而一个替身测出来的
 * 「编排正确」和真实 GitHub 的行为经常不是一回事。编排交给 §7 的真实端到端演练。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STAGES,
  SENSITIVE_PACKAGE_FIELDS,
  SENSITIVE_RULES,
  assertSemver,
  branchForVersion,
  classifySensitive,
  createShipState,
  advanceState,
  decideRelease,
  decideTag,
  nextStep,
  restoreState,
  tagForVersion,
} from '../scripts/lib/ship-core.mjs'

// --- 版本与命名 -----------------------------------------------------------

test('版本号只接受三段数字', () => {
  assert.equal(assertSemver('0.2.17'), '0.2.17')
  assert.equal(assertSemver('10.20.30'), '10.20.30')

  // 带前缀、带预发布、带 build —— 这些都会让标签名和 npm 语义打架，一律拒绝。
  for (const bad of ['v0.2.17', '0.2', '0.2.17-beta.1', '0.2.17+build', '', '0.2.17 ', 'abc']) {
    assert.throws(() => assertSemver(bad), /版本号/, `应拒绝 ${JSON.stringify(bad)}`)
  }
})

test('标签名固定带 v 前缀，分支名能区分同版本的多次交付', () => {
  assert.equal(tagForVersion('0.2.17'), 'v0.2.17')

  const first = branchForVersion('0.2.17', 'auto')
  const second = branchForVersion('0.2.17', 'archive-fix')

  assert.equal(first, 'release/v0.2.17-auto')
  assert.equal(second, 'release/v0.2.17-archive-fix')
  assert.notEqual(first, second, '同版本不同 slug 必须是不同分支，否则第二轮的提交会顶掉第一轮')
})

test('分支名把非法字符换成短横，不产生 git 拒绝的 ref', () => {
  const branch = branchForVersion('0.2.17', 'Fix: the   leak/thing!!')
  assert.match(branch, /^release\/v0\.2\.17-[a-z0-9-]+$/, `得到 ${branch}`)
  // 连续的短横要压缩，结尾不能留短横。
  assert.doesNotMatch(branch, /--/)
  assert.doesNotMatch(branch, /-$/)
})

test('空 slug 落到 auto，不会产出以短横结尾的分支', () => {
  assert.equal(branchForVersion('0.2.17', ''), 'release/v0.2.17-auto')
  assert.equal(branchForVersion('0.2.17', '   '), 'release/v0.2.17-auto')
})

// --- 敏感变更识别 ---------------------------------------------------------

/** 造一条 change 记录。`lines` 是「新增的行」，用来测 package.json 字段级判断。 */
function change(path, lines = []) {
  return { path, addedLines: lines.map((line) => `+  ${line}`), removedLines: [] }
}

test('工作流、扫描规则、打包规则、安全边界都算敏感', () => {
  const cases = [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'scripts/audit-leaks.mjs',
    'scripts/scan-archive.mjs',
    'scripts/source-zip.mjs',
    'scripts/pack.mjs',
    'scripts/tar.mjs',
    'scripts/ship.mjs',
    'scripts/lib/ship-core.mjs',
    'scripts/lib/delivery-status.mjs',
    'src/security/output-guard.ts',
    'src/platforms/weibo/publish.ts',
    'src/platforms/tieba/reply.ts',
    'cordis.patch.yml',
  ]

  for (const path of cases) {
    const result = classifySensitive([change(path)])
    assert.equal(result.sensitive, true, `${path} 应当是敏感变更`)
    assert.ok(result.reasons.length > 0, `${path} 必须给出理由`)
    assert.equal(result.reasons[0].path, path)
  }
})

test('普通源码与文档改动不拦自动合并', () => {
  const cases = [
    'src/platforms/weibo/target-match.ts',
    'src/core/brief.ts',
    'test/v0217-ship-core.test.ts',
    'README.md',
    'CHANGELOG.md',
    'docs/v0.2.17-acceptance.md',
    'src/collectors/tieba.ts',
  ]

  for (const path of cases) {
    const result = classifySensitive([change(path)])
    assert.equal(result.sensitive, false, `${path} 不该被拦`)
    assert.deepEqual(result.reasons, [])
  }
})

test('平台目录里只有发表类文件敏感，读取类不敏感', () => {
  // 这条是 §4 的语义边界：读贴吧不需要维护者点头，往贴吧发帖需要。
  const publish = classifySensitive([change('src/platforms/tieba/publish-reply.ts')])
  const reader = classifySensitive([change('src/platforms/tieba/collector.ts')])

  assert.equal(publish.sensitive, true)
  assert.equal(reader.sensitive, false)
})

test('package.json 只在动到依赖、引擎、脚本、dsh 字段时才敏感', () => {
  // 只改版本号是每次发布都会发生的事；把它当敏感，等于每次交付都要人守着。
  const versionOnly = classifySensitive([change('package.json', ['"version": "0.2.17",'])])
  assert.equal(versionOnly.sensitive, false, '只改 version 不该拦')

  for (const field of SENSITIVE_PACKAGE_FIELDS) {
    const touched = classifySensitive([change('package.json', [`${field}: {`, '  "x": "1"'])])
    assert.equal(touched.sensitive, true, `动到 ${field} 应当敏感`)
    assert.equal(touched.reasons[0].id, 'package-fields')
  }
})

test('敏感判断按路径去重，同一文件多次出现只报一条', () => {
  const result = classifySensitive([change('.github/workflows/ci.yml'), change('.github/workflows/ci.yml')])
  assert.equal(result.reasons.length, 1)
})

test('空改动列表不敏感', () => {
  assert.deepEqual(classifySensitive([]), { sensitive: false, reasons: [] })
})

test('规则表里每条规则都有 id 和 reason，且理由不能是占位文本', () => {
  // 这些理由会原样印在 PR 的风险说明里给人看，空话等于没写。
  for (const rule of SENSITIVE_RULES) {
    assert.ok(rule.id, '规则必须有 id')
    assert.ok(rule.reason && rule.reason.length >= 8, `规则 ${rule.id} 的理由太短`)
    assert.equal(typeof rule.test, 'function')
  }
})

// --- 标签决策 -------------------------------------------------------------

test('没有标签时创建', () => {
  const decision = decideTag({ tagExists: false, tagCommit: null, expectedCommit: 'aaa' })
  assert.equal(decision.action, 'create')
})

test('标签已指向本次提交时复用，不重建', () => {
  const decision = decideTag({ tagExists: true, tagCommit: 'aaa', expectedCommit: 'aaa' })
  assert.equal(decision.action, 'reuse')
})

test('标签指向别的提交时拒绝，绝不移动', () => {
  // 移动已发布的标签，等于让已经下载过旧产物的人失去可复现的对应关系。
  const decision = decideTag({ tagExists: true, tagCommit: 'old', expectedCommit: 'new' })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /标签/)
})

test('标签存在但读不到指向的提交时也拒绝，不猜', () => {
  const decision = decideTag({ tagExists: true, tagCommit: null, expectedCommit: 'new' })
  assert.equal(decision.action, 'refuse', '读不到就不能当成「可以重建」')
})

test('缺少 expectedCommit 时拒绝，不默认放行', () => {
  const decision = decideTag({ tagExists: false, tagCommit: null, expectedCommit: null })
  assert.equal(decision.action, 'refuse')
})

// --- Release 决策 ---------------------------------------------------------

const localAssets = [
  { name: 'a.tgz', bytes: 100, sha256: 'a'.repeat(64) },
  { name: 'b.zip', bytes: 200, sha256: 'b'.repeat(64) },
]

test('没有 Release 时创建', () => {
  const decision = decideRelease({ releaseExists: false, remoteAssets: [], localAssets })
  assert.equal(decision.action, 'create')
})

test('Release 已存在且附件一致时复用，不重复写', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: localAssets.map((asset) => ({ name: asset.name, bytes: asset.bytes })),
    localAssets,
  })
  assert.equal(decision.action, 'reuse')
})

test('Release 已存在但附件字节数不同就拒绝覆盖', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: [
      { name: 'a.tgz', bytes: 999 },
      { name: 'b.zip', bytes: 200 },
    ],
    localAssets,
  })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /a\.tgz/)
})

test('Release 已存在但少了附件也拒绝', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: [{ name: 'a.tgz', bytes: 100 }],
    localAssets,
  })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /b\.zip/)
})

test('同版本附件字节数完全相同就不重建，也不覆盖', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: localAssets.map((asset) => ({ name: asset.name, bytes: asset.bytes })),
    localAssets,
  })
  assert.equal(decision.action, 'reuse')
  assert.notEqual(decision.action, 'overwrite', '不该存在 overwrite 这个动作')
})

test('两边都给得出哈希时，哈希不同也算不一致', () => {
  const decision = decideRelease({
    releaseExists: true,
    remoteAssets: [{ name: 'a.tgz', bytes: 100, sha256: 'c'.repeat(64) }, { name: 'b.zip', bytes: 200 }],
    localAssets,
  })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /a\.tgz/)
})

// --- 阶段流转与停止 -------------------------------------------------------

test('阶段表是单向线性的，done 在最后', () => {
  assert.equal(STAGES[0], 'preflight')
  assert.equal(STAGES[STAGES.length - 1], 'done')
  assert.equal(new Set(STAGES).size, STAGES.length, '阶段不能重复')
})

test('检测到敏感变更时，PR 阶段停下等人工', () => {
  const decision = nextStep({ stage: 'pull_request', sensitive: true })
  assert.equal(decision.blocked, true)
  assert.equal(decision.action, 'block')
  assert.match(decision.reason, /授权/)
  assert.ok(Array.isArray(decision.recovery) && decision.recovery.length > 0, '停下时必须给恢复步骤')
})

test('没有敏感变更时，PR 阶段继续，且 blocked 明确为 false', () => {
  const decision = nextStep({ stage: 'pull_request', sensitive: false })
  assert.equal(decision.blocked, false)
  assert.equal(decision.action, 'enable_auto_merge')
})

test('标签决策为 refuse 时 tag 阶段停下', () => {
  const decision = nextStep({
    stage: 'tag',
    tagDecision: { action: 'refuse', reason: '标签已指向别处' },
  })
  assert.equal(decision.blocked, true)
  assert.equal(decision.reason, '标签已指向别处')
})

test('标签决策为 create 或 reuse 时 tag 阶段继续', () => {
  for (const action of ['create', 'reuse']) {
    const decision = nextStep({ stage: 'tag', tagDecision: { action, reason: '' } })
    assert.equal(decision.blocked, false, `${action} 不该停下`)
  }
})

test('Release 决策为 refuse 时 release 阶段停下', () => {
  const decision = nextStep({
    stage: 'release',
    releaseDecision: { action: 'refuse', reason: '附件不一致' },
  })
  assert.equal(decision.blocked, true)
})

test('其他阶段一律不拦', () => {
  for (const stage of ['preflight', 'branch', 'verify', 'commit', 'push', 'auto_merge', 'wait_checks', 'verify_release', 'done']) {
    assert.equal(nextStep({ stage, sensitive: true }).blocked, false, `${stage} 不该因为敏感而停`)
  }
})

// --- 状态文件 -------------------------------------------------------------

test('新状态从 preflight 开始，带 schema 与版本', () => {
  const state = createShipState({ version: '0.2.17' })
  assert.equal(state.stage, 'preflight')
  assert.equal(state.version, '0.2.17')
  assert.equal(typeof state.schema, 'number')
  assert.ok(Array.isArray(state.history))
})

test('每次推进都记一条历史，附时间与状态', () => {
  const state = createShipState({ version: '0.2.17' })
  advanceState(state, { to: 'branch' })
  advanceState(state, { to: 'verify' })

  assert.equal(state.stage, 'verify')
  // 两次推进 = 两条记录。起点由 startedAt 单独记录，不再造一条 from: null 的历史。
  assert.equal(state.history.length, 2)
  assert.deepEqual(
    state.history.map((entry) => entry.to),
    ['branch', 'verify'],
  )
  assert.equal(state.history[0].from, 'preflight', '第一条记录要能看出是从哪来的')
  for (const entry of state.history) {
    assert.equal(typeof entry.stage, 'undefined')
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/, '时间必须是 ISO 格式，否则报告里无法排序')
  }
})

test('推进可以带上 GitHub 事实，且不会被后续推进清掉', () => {
  const state = createShipState({ version: '0.2.17' })
  advanceState(state, { to: 'push', detail: { github: { branch: 'release/v0.2.17-auto', commitSha: 'abc' } } })
  advanceState(state, { to: 'pull_request', detail: { github: { pr: { number: 7 } } } })

  assert.equal(state.github.branch, 'release/v0.2.17-auto')
  assert.equal(state.github.commitSha, 'abc')
  assert.equal(state.github.pr.number, 7)
})

test('推进到未知阶段直接报错，不静默接受', () => {
  const state = createShipState({ version: '0.2.17' })
  assert.throws(() => advanceState(state, { to: 'nonsense' }), /阶段/)
})

test('恢复状态时版本不符就不复用（避免把 0.2.16 的进度当成 0.2.17 的）', () => {
  const state = createShipState({ version: '0.2.16' })
  advanceState(state, { to: 'verify' })

  const restored = restoreState(JSON.parse(JSON.stringify(state)), { version: '0.2.17' })
  assert.equal(restored, null)
})

test('恢复状态时 schema 不符也不复用', () => {
  const state = createShipState({ version: '0.2.17' })
  const mutated = { ...JSON.parse(JSON.stringify(state)), schema: 999 }
  assert.equal(restoreState(mutated, { version: '0.2.17' }), null)
})

test('恢复同版本同 schema 的状态能接上原来的阶段', () => {
  const state = createShipState({ version: '0.2.17' })
  advanceState(state, { to: 'push', detail: { github: { branch: 'b', commitSha: 'abc' } } })

  const restored = restoreState(JSON.parse(JSON.stringify(state)), { version: '0.2.17' })
  assert.equal(restored.stage, 'push')
  assert.equal(restored.github.commitSha, 'abc')
})

test('恢复明显的垃圾输入返回 null 而不是抛异常', () => {
  for (const garbage of [null, undefined, 'x', 42, {}, { schema: 'v1' }]) {
    assert.equal(restoreState(garbage, { version: '0.2.17' }), null, `输入 ${JSON.stringify(garbage)}`)
  }
})
