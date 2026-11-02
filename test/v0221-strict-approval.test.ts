/**
 * v0.2.21 §二：任何互动模式都不能突破「该候选有人工批准」这一条。
 *
 * ## 修复前的矛盾
 *
 * `AGENTS.md` 第四节第 7 条写着「人工发帖确认不能关」，而 `safety.ts` 的策略矩阵里
 * `single_shot` 与 `limited_auto` 两行的「批准」列写的是 **any / optional** ——
 * 也就是说，代码里有两个模式可以把它关掉。
 *
 * 这不是文档过时，是**两处说法不一致**，而且不一致的那一侧是能发帖的那一侧：
 *
 * | 场景 | v0.2.20 的行为 | 应该的行为 |
 * | --- | --- | --- |
 * | `manual` + `allow` + 无批准 | 拒绝 | 拒绝 |
 * | `single_shot` + `allow` + 无批准 | **发表** | 拒绝 |
 * | `limited_auto` + `allow` + 无批准 | **发表**（消耗自动额度） | 拒绝 |
 *
 * 这一版的选择是：**保留 `limited_auto`，但把它的含义从「可以少点一次确认」改成
 * 「在批准之外还多一些限制」**。模式只做减法，不做加法。
 *
 * ## 三件不能伪造批准的事
 *
 * 1. **模型参数**：`debate_publish_reply` 的 `confirm=true` 是必要条件，但它不是批准记录 ——
 *    模型自己也能填 true。真正放行的是 `store` 里那条批准记录（`security/approvals.ts`），
 *    它由主人点页面上的按钮产生，且绑定了候选正文哈希。
 * 2. **提示词**：没有任何提示词能产生一条批准记录。批准是数据，不是措辞。
 * 3. **配置默认值**：默认模式是 `manual`，且无论配成什么都仍然需要批准。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { checkPublishPolicy, DEFAULT_POLICY, type InteractionPolicy, type PublishAttempt } from '../lib/safety.js'
import { resolveConfig } from '../lib/config.js'

const ROOT = join(import.meta.dirname, '..')
const MODES: readonly InteractionPolicy['mode'][] = ['manual', 'single_shot', 'limited_auto']

function policyFor(mode: InteractionPolicy['mode']): InteractionPolicy {
  return { ...DEFAULT_POLICY, mode, maxAutoPublishesPerSession: 5, cooldownMs: 0 }
}

function attempt(overrides: Partial<PublishAttempt> = {}): PublishAttempt {
  return {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: false,
    securityDecision: 'allow',
    semanticSettled: true,
    now: 1_000_000,
    ...overrides,
  }
}

function codeOf(decision: ReturnType<typeof checkPublishPolicy>): string {
  return decision.allowed === false ? decision.code : ''
}

describe('v0.2.21 §二：所有模式都要求逐条人工批准', () => {
  for (const mode of MODES) {
    it(`${mode}：没有批准时拒绝，且理由指向缺少批准`, () => {
      const decision = checkPublishPolicy(policyFor(mode), attempt({ humanApproved: false }))
      assert.equal(decision.allowed, false, `${mode} 在无人工批准时允许了发表`)
      assert.equal(codeOf(decision), 'approval_required', `${mode} 的拒绝码不对：${codeOf(decision)}`)
    })

    it(`${mode}：有批准时允许（批准是唯一放行条件）`, () => {
      const decision = checkPublishPolicy(policyFor(mode), attempt({ humanApproved: true }))
      assert.equal(
        decision.allowed,
        true,
        `${mode} 在有人工批准时仍然拒绝：${decision.allowed === false ? decision.code + ' ' + decision.reason : ''}`,
      )
    })

    it(`${mode}：review 候选没有批准时，理由是「需要人工确认」而不是别的`, () => {
      const decision = checkPublishPolicy(
        policyFor(mode),
        attempt({ humanApproved: false, securityDecision: 'review' }),
      )
      assert.equal(decision.allowed, false)
      assert.equal(codeOf(decision), 'security_review_required')
    })
  }

  it('模式不再出现在放行条件里：把三种模式各自去掉批准，结果必须一样', () => {
    const codes = MODES.map((mode) => codeOf(checkPublishPolicy(policyFor(mode), attempt())))
    assert.deepEqual(
      codes,
      ['approval_required', 'approval_required', 'approval_required'],
      `三种模式在无批准时给出了不同结论：${codes.join(' / ')}`,
    )
  })

  it('limited_auto 的额度不能当成「免批准次数」：额度再大也要批准', () => {
    const generous: InteractionPolicy = { ...policyFor('limited_auto'), maxAutoPublishesPerSession: 50 }
    const decision = checkPublishPolicy(generous, attempt({ humanApproved: false }))
    assert.equal(decision.allowed, false, '把额度调大就绕过了批准')
    assert.equal(codeOf(decision), 'approval_required')
  })

  it('limited_auto 对已批准的发表仍然检查额度与冷却（模式只做减法）', () => {
    const capped = checkPublishPolicy(
      { ...policyFor('limited_auto'), maxAutoPublishesPerSession: 1 },
      attempt({ humanApproved: true, sessionPublishes: 1 }),
    )
    assert.equal(capped.allowed, false)
    assert.equal(codeOf(capped), 'session_limit')

    const cooling = checkPublishPolicy(
      { ...policyFor('limited_auto'), cooldownMs: 60_000 },
      attempt({ humanApproved: true, lastPublishAt: 1_000_000 - 1_000 }),
    )
    assert.equal(cooling.allowed, false)
    assert.equal(codeOf(cooling), 'cooldown')
  })

  it('默认策略是 manual，且默认额度的存在不影响「必须批准」', () => {
    assert.equal(DEFAULT_POLICY.mode, 'manual')
    const decision = checkPublishPolicy(DEFAULT_POLICY, attempt({ humanApproved: false }))
    assert.equal(decision.allowed, false)
    assert.equal(codeOf(decision), 'approval_required')
  })
})

describe('v0.2.21 §二：批准不能由模型参数、提示词或配置默认值伪造', () => {
  it('发表工具只有 confirm 这一个「授权」参数，且它不叫 humanApproved', () => {
    const text = readFileSync(join(ROOT, 'src', 'tools.ts'), 'utf8')
    const start = text.indexOf("name: 'debate_publish_reply'")
    assert.notEqual(start, -1, '找不到发表工具')
    // 工具的 schema 到 execute 之前为止。
    const schemaEnd = text.indexOf('async execute', start)
    const schema = text.slice(start, schemaEnd)

    for (const field of ['humanApproved', 'approved', 'approvedBy', 'authorizedBy']) {
      assert.equal(
        schema.includes(`${field}:`),
        false,
        `发表工具的入参里出现了 ${field}：模型可以自报一个「已批准」`,
      )
    }
    assert.ok(schema.includes('confirm:'), 'confirm 参数不见了')
  })

  it('publisher 用的是存储里的批准记录，不是调用方传进来的布尔值', () => {
    const text = readFileSync(join(ROOT, 'src', 'publisher.ts'), 'utf8')
    assert.ok(
      text.includes('deps.store.getApprovals()'),
      'publisher 没有从 store 读批准记录 —— 「批准」会退回成调用方自报的布尔值',
    )
    assert.ok(
      /checkApproval\(/.test(text),
      'publisher 没有调用 checkApproval，批准记录的绑定校验被绕过了',
    )
    // 调用方传进来的 humanApproved 只能作为「请求意图」，不能作为判据：
    // 判据必须是 `approval.ok`。
    assert.ok(
      /humanApproved:\s*approval\.ok/.test(text),
      'policy 的 humanApproved 不是 approval.ok —— 可能是调用方自报值',
    )
  })

  it('配置默认值把模式定成 manual，且没有任何配置项能关掉批准', () => {
    const config = resolveConfig({})
    assert.equal(config.interactionMode, 'manual')
    const text = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8')
    for (const forbidden of ['requireApproval', 'skipApproval', 'autoApprove']) {
      assert.equal(
        text.includes(forbidden),
        false,
        `配置里出现了 ${forbidden}：批准变成了一个可以关掉的开关`,
      )
    }
  })

  it('README 与 AGENTS.md 对批准的说法与代码一致（不再写「自动档可以不开批准」）', () => {
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
    assert.ok(
      /人工发[B博]?帖确认不能关/.test(agents),
      'AGENTS.md 里那条不可协商的规则不见了',
    )
    assert.ok(
      /limited_auto[\s\S]{0,200}实验|实验[\s\S]{0,80}limited_auto/.test(agents) ||
        /受限模式/.test(agents),
      'AGENTS.md 没有说明 limited_auto 现在的语义（受限/实验，不绕过批准）',
    )
  })
})
