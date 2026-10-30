/**
 * v0.2.15 §三：不要把 CLI 参数形状当作真实平台验证。
 *
 * ## 这个文件防的是什么
 *
 * v0.2.14 的 `nestedClaimOf()` 只看 schema：命令同时声明父评论形参数（`cid`）和分页形参数
 * （`count`），就返回 `state: 'verified'`、`available: true`。而 `provider.ts` 用的是
 * `nestedClaim.available === true`，于是**页面宣称「子评论可读」，而那次读取从未执行过**。
 *
 * 任务书把六种证据层次列得很清楚，要求不许混为一谈：
 *
 * 1. 命令存在
 * 2. 参数 Schema 兼容
 * 3. 已取得账号权限
 * 4. 真实调用成功
 * 5. 父子评论关系正确
 * 6. 真实平台验证完成
 *
 * 前两层是静态的，只能证明「接口长得像能读子评论」。所以这里的测试分两组：
 *
 * - **静态组**：参数形状齐备时，`available` 可以是 true，但 `evidence.level` 必须停在
 *   `schema_only`，`liveCallSucceeded` 必须是 false。
 * - **集成组**：`nestedReplies` 只在 `fully_verified` 时为 true，`schema_only` 时必须为 false。
 *
 * 只测第一组会奖励一个「永远不说验证过」的实现；只测第二组则测不到层次本身。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInvocationPlan,
  capabilityEvidence,
  type PlanParameter,
} from '../lib/platforms/weibo/invocation-plan.js'
import { describeEvidenceLevel } from '../lib/platforms/weibo/provider.js'

const ID_PARAM: PlanParameter = { name: 'ids', type: 'string', required: true }
const CID_PARAM: PlanParameter = { name: 'cid', type: 'string', required: false }
const COUNT_PARAM: PlanParameter = { name: 'count', type: 'number', required: false }
const ONLY_COUNT_PARAM: PlanParameter = { name: 'count', type: 'number', required: false }

function commentsPlan(parameters: readonly PlanParameter[]) {
  return buildInvocationPlan({
    group: 'comments',
    action: 'show/biz',
    name: 'comments show/biz',
    schemaVerified: true,
    parameters,
    kind: 'comments',
  })
}

// ---------------------------------------------------------------------------
// A. 静态形状齐备 ≠ 已验证
// ---------------------------------------------------------------------------

test('证据层次：cid + count 形状齐备时，参数支持但不得声称真实调用过（§三 核心）', () => {
  const plan = commentsPlan([ID_PARAM, CID_PARAM, COUNT_PARAM])
  const nested = plan.capabilities.readNested

  // The schema answer may be positive…
  assert.equal(nested.available, true, '形状齐备时 available 仍为 true —— 这是 schema 事实')
  assert.equal(nested.state, 'verified')

  // …but the evidence must not claim anything beyond the schema.
  assert.equal(nested.evidence.schemaCompatible, true)
  assert.equal(nested.evidence.liveCallSucceeded, false, '没调用过就不能说调用成功')
  assert.equal(nested.evidence.parentChildConfirmed, false, '没核对过就不能说父子关系正确')
  assert.equal(
    nested.evidence.level,
    'schema_only',
    '只凭参数名推断时，层次只能是 schema_only —— 这正是 v0.2.14 的错误',
  )
})

test('证据层次：没有父评论参数时 platform schema 明确不支持（§三 第1/2层就不成立）', () => {
  const plan = commentsPlan([ID_PARAM, COUNT_PARAM])
  const nested = plan.capabilities.readNested
  assert.equal(nested.available, false)
  assert.equal(nested.state, 'unavailable')
  assert.equal(nested.evidence.level, 'unavailable')
})

test('证据层次：有父评论参数但无配套时停在 unverified，不冒充已验证', () => {
  const plan = commentsPlan([ID_PARAM, CID_PARAM])
  const nested = plan.capabilities.readNested
  assert.equal(nested.available, false)
  assert.equal(nested.state, 'unverified')
  assert.equal(nested.evidence.schemaCompatible, false)
  assert.equal(nested.evidence.level, 'schema_only')
})

test('证据层次：账号权限缺失记作 unknown，不是「有权限」', () => {
  const plan = commentsPlan([ID_PARAM, CID_PARAM, COUNT_PARAM])
  // The catalogue was not asked, so permission is unknown — a missing marker is not permission.
  assert.equal(plan.capabilities.readNested.evidence.accountPermitted, 'unknown')
})

// ---------------------------------------------------------------------------
// B. capabilityEvidence 的层次计算
// ---------------------------------------------------------------------------

test('证据层次：只有 commandExists 时停在 schema_only', () => {
  const evidence = capabilityEvidence({ commandExists: true })
  assert.equal(evidence.level, 'schema_only')
  assert.equal(evidence.schemaCompatible, false)
  assert.equal(evidence.liveCallSucceeded, false)
})

test('证据层次：真实调用成功但未核对父子关系 → live_call', () => {
  const evidence = capabilityEvidence({
    commandExists: true,
    schemaCompatible: true,
    liveCallSucceeded: true,
    parentChildConfirmed: false,
  })
  assert.equal(evidence.level, 'live_call', '能跑通不等于关系正确')
})

test('证据层次：调用成功且父子关系核对 → fully_verified', () => {
  const evidence = capabilityEvidence({
    commandExists: true,
    schemaCompatible: true,
    liveCallSucceeded: true,
    parentChildConfirmed: true,
  })
  assert.equal(evidence.level, 'fully_verified')
})

test('证据层次：schema 说不支持时，即使调用过也是 unavailable', () => {
  // A contradictory combination must resolve to the *weakest* answer, not the strongest.
  const evidence = capabilityEvidence({
    commandExists: true,
    schemaCompatible: true,
    liveCallSucceeded: true,
    parentChildConfirmed: true,
    schemaSaysUnavailable: true,
  })
  assert.equal(evidence.level, 'unavailable')
})

test('证据层次：调用成功但命令不存在是矛盾的，按更弱的一侧处理', () => {
  const evidence = capabilityEvidence({
    commandExists: false,
    schemaCompatible: true,
    liveCallSucceeded: true,
    parentChildConfirmed: true,
  })
  assert.equal(evidence.schemaCompatible, false, '命令都不存在，不可能 schema 兼容')
})

test('证据层次：不带参数时全部取最弱值，不会因遗漏而变强', () => {
  const evidence = capabilityEvidence({})
  assert.equal(evidence.commandExists, false)
  assert.equal(evidence.schemaCompatible, false)
  assert.equal(evidence.accountPermitted, 'unknown')
  assert.equal(evidence.liveCallSucceeded, false)
  assert.equal(evidence.parentChildConfirmed, false)
  assert.equal(evidence.level, 'schema_only')
})

// ---------------------------------------------------------------------------
// C. 措辞：schema_only 听起来不能像成功
// ---------------------------------------------------------------------------

test('证据层次：每个层次的措辞都把「未真实调用」说清楚（§三 界面要求）', () => {
  const schemaOnly = describeEvidenceLevel('schema_only')
  assert.match(schemaOnly, /未|尚未/, 'schema_only 的措辞必须点明还没真实验证')
  assert.equal(/已验证可用|已确认可用/.test(schemaOnly), false, '不能出现「已验证可用」')

  assert.match(describeEvidenceLevel('live_call'), /未核对/, 'live_call 要说明父子关系没核对')
  assert.match(describeEvidenceLevel('fully_verified'), /真实/)
  assert.match(describeEvidenceLevel('unavailable'), /不支持/)
})

// ---------------------------------------------------------------------------
// D. 正文读取同样受层次约束
// ---------------------------------------------------------------------------

test('证据层次：正文读取即使参数齐备也只是 schema_only', () => {
  const plan = buildInvocationPlan({
    group: 'statuses',
    action: 'show_batch/biz',
    name: 'statuses show_batch/biz',
    schemaVerified: true,
    parameters: [ID_PARAM],
    kind: 'thread',
  })
  assert.equal(plan.capabilities.readThread.available, true)
  assert.equal(
    plan.capabilities.readThread.evidence.level,
    'schema_only',
    '正文读取同样不能凭参数名称为自己背书',
  )
})

test('证据层次：schema 不可读时任何能力都不得为 available', () => {
  const plan = buildInvocationPlan({
    group: 'comments',
    action: 'show/biz',
    name: 'comments show/biz',
    schemaVerified: false,
    parameters: [ID_PARAM, CID_PARAM, ONLY_COUNT_PARAM],
    kind: 'comments',
  })
  assert.equal(plan.capabilities.readComments.available, false)
  assert.equal(plan.capabilities.readComments.evidence.schemaCompatible, false)
})
