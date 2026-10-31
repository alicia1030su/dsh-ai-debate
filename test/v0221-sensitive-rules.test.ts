/**
 * 敏感变更识别必须覆盖「真实发表与授权」这条链（v0.2.21 §一）。
 *
 * ## 这一版补的是什么
 *
 * 修复前 `SENSITIVE_RULES` 只认得三类 src 路径：`src/security/**`、
 * `src/platforms/<平台>/(publish|reply|comment)*.ts`，以及工作流与打包/扫描脚本。
 * 换句话说，下面这些改动**不会让流水线停下来等人**：
 *
 * - `src/publisher.ts` —— 真正的发表编排：谁批准、能力有没有验证过、目标快照还对不对
 * - `src/safety.ts` —— 发表策略本身：什么模式可以不经过人工确认就发出去
 * - `src/runtime.ts` —— 运行时的发表与授权入口
 * - `src/settings-routes.ts` —— 设置页里读写凭据、批准候选的那些路由
 * - `src/verification.ts` —— 一次性发表验收流程
 * - `src/platforms/<平台>/adapter.ts` —— 适配器里真正发出去的那几个方法
 *
 * 也就是说：**一个 agent 可以改动「发表要不要人点确认」的代码，并且自动合并它。**
 * 这正是这一版要证明不存在的那件事。
 *
 * ## 为什么不是「整个文件都敏感」
 *
 * `publisher.ts`（1500 行）、`runtime.ts`（1600 行）、`settings-routes.ts`（1100 行）、
 * `adapter.ts`（1000 行）都不是单一用途的文件，读路径与写路径住在一起。把整份标成敏感，
 * 结果是「改一行注释也要人守着」—— 那种守卫会在第二周被关掉，因为它挡的是工作不是风险。
 *
 * 所以粒度是行：只有当改动落到发表、批准、能力、凭据、身份、回读这些语义上才停。
 * 纯注释行不算 —— 文档里写 `approve` 不代表改了批准逻辑。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ship-core 是 .mjs，测试类型检查基线里没有它的声明
import {
  classifySensitive,
  SENSITIVE_LINE_MARKERS,
  SENSITIVE_RULES,
  SENSITIVE_WHOLE_FILES,
} from '../scripts/lib/ship-core.mjs'

const ROOT = join(import.meta.dirname, '..')

/** 把一个改动跑成 `classifySensitive` 的输入。 */
function change(path: string, addedLines: string[] = [], removedLines: string[] = []) {
  return { path, addedLines, removedLines }
}

function ids(result: { reasons: Array<{ id: string; path: string }> }): string[] {
  return result.reasons.map((reason) => reason.id)
}

describe('v0.2.21 §一：修复前的漏检（这是「改了没事」的证据）', () => {
  it('旧的路径规则完全认不出这六个文件', () => {
    const paths = [
      'src/publisher.ts',
      'src/safety.ts',
      'src/runtime.ts',
      'src/settings-routes.ts',
      'src/verification.ts',
      'src/platforms/tieba/adapter.ts',
    ]
    for (const path of paths) {
      const matched = SENSITIVE_RULES.filter((rule: { test: (p: string) => boolean }) => rule.test(path))
      assert.deepEqual(
        matched.map((rule: { id: string }) => rule.id),
        [],
        `${path} 在修复前会被旧规则命中，这条测试就不再证明「曾经漏检」`,
      )
    }
  })

  it('只给路径、不给改动行时，行级规则不会误判成敏感', () => {
    // 这不是缺陷，是设计：拿不到 diff 就不能断定「改了什么」。调用方（ship.mjs）
    // 在取不到 diff 时会直接失败，而不是把「没看见」当成「没问题」。
    const result = classifySensitive([change('src/publisher.ts')])
    assert.equal(result.sensitive, false)
  })
})

describe('v0.2.21 §一：修复后的阻断（每条规则都要能单独触发）', () => {
  const cases: Array<{ name: string; path: string; added: string[]; id: string }> = [
    {
      name: 'publisher.ts 里出现人工批准判定',
      path: 'src/publisher.ts',
      added: ['  const requiresHumanApproval = stored.decision === \'review\''],
      id: 'publish-orchestration',
    },
    {
      name: 'publisher.ts 里出现能力校验',
      path: 'src/publisher.ts',
      added: ['  deps.assertCapability(session.platform, capability)'],
      id: 'publish-orchestration',
    },
    {
      name: 'publisher.ts 里改回读证据',
      path: 'src/publisher.ts',
      added: ['  const readBack = await verifyPublished(deps, session, candidate)'],
      id: 'publish-orchestration',
    },
    {
      name: 'runtime.ts 里改发表入口',
      path: 'src/runtime.ts',
      added: ['    const report = await publishCandidate(this.deps, request)'],
      id: 'runtime-publish-auth',
    },
    {
      name: 'runtime.ts 里改凭据读取',
      path: 'src/runtime.ts',
      added: ['  const cookie = await this.credentials.cookieFor(platform)'],
      id: 'runtime-publish-auth',
    },
    {
      name: 'settings-routes.ts 里改 Cookie 路由',
      path: 'src/settings-routes.ts',
      added: ['      body: { cookie: session.cookie }'],
      id: 'settings-auth-credentials',
    },
    {
      name: 'settings-routes.ts 里改批准路由',
      path: 'src/settings-routes.ts',
      added: ['    const approved = await this.runtime.approve(candidateId)'],
      id: 'settings-auth-credentials',
    },
    {
      name: '贴吧 adapter 里改发表方法',
      path: 'src/platforms/tieba/adapter.ts',
      added: ['  async publish(target: PublishTarget): Promise<PublishOutcome> {'],
      id: 'platform-adapter-write',
    },
    {
      name: '贴吧 adapter 里改验证码识别',
      path: 'src/platforms/tieba/adapter.ts',
      added: ['    if (detectCaptcha(html)) throw new PlatformError(\'captcha\')'],
      id: 'platform-adapter-write',
    },
    {
      name: 'tools.ts 里改发表工具',
      path: 'src/tools.ts',
      added: ['      name: \'debate_publish_reply\','],
      id: 'tool-publish-approval',
    },
  ]

  for (const item of cases) {
    it(item.name, () => {
      const result = classifySensitive([change(item.path, item.added)])
      assert.equal(result.sensitive, true, `${item.path} 的这处改动没有触发敏感判定：${item.added.join(' / ')}`)
      assert.ok(
        ids(result).includes(item.id),
        `期望命中 ${item.id}，实际命中 ${ids(result).join(',') || '（无）'}`,
      )
    })
  }

  it('整份文件敏感的规则：safety.ts 与 verification.ts 改任何一行都停', () => {
    for (const [path, id] of [
      ['src/safety.ts', 'publish-policy'],
      ['src/verification.ts', 'publish-verification'],
    ] as const) {
      // 连一个看起来无害的改动也要停：这两个文件里没有「只读的角落」。
      const result = classifySensitive([change(path, ['const x = 1'])])
      assert.equal(result.sensitive, true, `${path} 没有被整份拦住`)
      assert.deepEqual(ids(result), [id])
    }
  })

  it('删除行同样触发：把批准检查删掉是最该被拦住的一类改动', () => {
    const result = classifySensitive([
      change('src/publisher.ts', [], ['  if (!approval.ok) return refuse(\'approval_required\')']),
    ])
    assert.equal(result.sensitive, true)
    assert.ok(ids(result).includes('publish-orchestration'))
  })

  it('两个新规则覆盖到的文件都必须真实存在', () => {
    // 规则写错路径不会报错，只会永远不命中 —— 那比没有规则更糟。
    for (const rule of SENSITIVE_WHOLE_FILES) {
      assert.ok(existsSync(join(ROOT, rule.path)), `SENSITIVE_WHOLE_FILES 指向了不存在的文件：${rule.path}`)
    }
    for (const rule of SENSITIVE_LINE_MARKERS) {
      // Every real source file the rules can match. A rule that matches nothing would satisfy
      // the assertions below vacuously, so the candidate list has to name each path the rules
      // target — adding a rule means adding its file here, never loosening this check.
      const candidates = [
        'src/publisher.ts',
        'src/runtime.ts',
        'src/settings-routes.ts',
        'src/platforms/tieba/adapter.ts',
        'src/tools.ts',
        'src/index.ts',
        'src/store.ts',
      ]
      const sample = candidates.find((path) => rule.test(path)) ?? null
      assert.ok(sample !== null, `行级规则 ${rule.id} 的 test() 认不出任何一个真实文件`)
      assert.ok(existsSync(join(ROOT, sample)), `行级规则 ${rule.id} 指向了不存在的文件：${sample}`)
    }
  })
})

describe('v0.2.21 §一：不该停的改动（守卫不能挡工作）', () => {
  it('纯注释行不算：文档里写 approve/cookie 不等于改了批准逻辑', () => {
    const result = classifySensitive([
      change('src/publisher.ts', [
        '  // 这里以前会让 review 候选在 limited_auto 下自动发出去（approve 检查缺失）',
        '   * 发表前必须确认 credential 状态',
      ]),
    ])
    assert.equal(result.sensitive, false, `注释行不该触发：${JSON.stringify(ids(result))}`)
  })

  it('publisher.ts 里与发表无关的读辅助函数不算', () => {
    const result = classifySensitive([
      change('src/publisher.ts', ['  const rows = parseFloorRows(html)', '  return rows.length > 0']),
    ])
    assert.equal(result.sensitive, false, `读路径的改动不该停：${JSON.stringify(ids(result))}`)
  })

  it('贴吧 adapter 里只改读取不算', () => {
    const result = classifySensitive([
      change('src/platforms/tieba/adapter.ts', ['  async readThread(ref: ThreadRef): Promise<Thread> {']),
    ])
    assert.equal(result.sensitive, false, `读方法的改动不该停：${JSON.stringify(ids(result))}`)
  })

  it('settings-routes.ts 里只改与凭据无关的纯数据路由不算', () => {
    const result = classifySensitive([
      change('src/settings-routes.ts', ['    return { ok: true, value: buildSummaryRow(row) }']),
    ])
    assert.equal(result.sensitive, false, `纯展示路由的改动不该停：${JSON.stringify(ids(result))}`)
  })

  it('文档、测试与普通源码不受影响', () => {
    const result = classifySensitive([
      change('README.md', ['安装说明改了几个字']),
      change('test/some-new.test.ts', ['assert.equal(1, 1)']),
      change('src/analyzer.ts', ['  const confidence = clamp(raw, 0, 1)']),
    ])
    assert.equal(result.sensitive, false, '普通开发不该被敏感规则挡住')
  })

  it('一份混合改动里，只有敏感那一项产生理由', () => {
    const result = classifySensitive([
      change('src/analyzer.ts', ['  const x = 1']),
      change('src/safety.ts', ['  const y = 2']),
      change('README.md', ['文字']),
    ])
    assert.equal(result.sensitive, true)
    assert.deepEqual(ids(result), ['publish-policy'])
  })
})

describe('v0.2.21 §一：GitHub 自动合并权限 ≠ 论坛发表权限', () => {
  it('敏感判定只决定「要不要停下来等人」，不授予任何发表权限', () => {
    // 这条测试守的是一个很容易被写错的想法：既然都要人批准，是不是可以合并成一套？
    // 不能。两者是不同主体、不同对象、不同后果：
    //   · GitHub 自动合并 —— 决定「这段代码能不能进 main」
    //   · 论坛发表        —— 决定「这句话能不能以主人的身份出现在公开帖子里」
    // 合并会让「批准了代码」读成「批准了发言」，而那正是最坏的一种默认值。
    const source = String(classifySensitive)
    for (const forbidden of ['approvedBy', 'authorizedAccountId', 'approvedText', 'publishCandidate']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `敏感判定里出现了发表授权字段 ${forbidden}：两套权限被混在了一起`,
      )
    }
  })

  it('发表授权模块不引用交付流水线的任何决策', () => {
    // 反方向也要成立：发表验收不该因为「CI 绿了」就认为可以发。
    const modulePath = join(ROOT, 'src', 'verification.ts')
    const text = readFileSync(modulePath, 'utf8')
    for (const forbidden of ['ship-core', 'classifySensitive', 'autoMerge', 'auto_merge']) {
      assert.equal(
        text.includes(forbidden),
        false,
        `发表验收模块引用了 ${forbidden}，两套权限的边界被打破了`,
      )
    }
  })
})
