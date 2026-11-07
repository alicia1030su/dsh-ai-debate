/**
 * v0.2.32：`doctor` 的三项在没有令牌时是**模板**，不是三个检查结论。
 *
 * ## 这一组测试防的是什么
 *
 * 2026-11-07，主人完成了微博开放平台的开发者实名认证，控制台「我的服务」显示
 * 体验服务为「当前服务」。同一时刻，插件的诊断面板写着：
 *
 *     注册或登录、完成开发者认证、开通服务 未完成。
 *
 * 后两句是假的。`@weibo-ai/weibo-cli@0.9.8` 的 `doctor` 在没有令牌时：
 *
 * ```js
 * if (!token) {
 *   console.log(`${READY_MISSING} 注册或登录`);
 *   console.log(`${READY_MISSING} 完成开发者认证`);
 *   console.log(`${READY_MISSING} 开通服务`);
 *   return;                 // ← 后两项一次都没查
 * }
 * ```
 *
 * 也就是：**三项 × 里只有第一项是检查过的**，后两项是硬编码的模板行。
 * 插件原样转述，等于用一句模板冒充三个结论。而代价最高的情形是：主人看到
 * 「完成开发者认证 未完成」，去做一件已经做完的事——那需要本人实名、甚至付费。
 *
 * ## 判据
 *
 * 模板形态的三个特征同时成立：至少三项、第一项是登录、三项全 ×。
 * 真检查出来的「登录 ✓ 但认证 ×」不属于模板（第一项是 ✓），仍然逐项报。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseDoctorReport, probeWeiboCli } from '../lib/platforms/weibo/cli.js'

/** 构造 doctor 的 ANSI 彩色的 × / ✓ 行。 */
function line(mark: '×' | '✓', label: string): string {
  return `\u001b[33m${mark}\u001b[0m ${label}`
}

test('解析：三项 × 能被正确读出来（模板形态的输入）', () => {
  const steps = parseDoctorReport(
    [line('×', '注册或登录'), line('×', '完成开发者认证'), line('×', '开通服务')].join('\n'),
  )
  assert.equal(steps.length, 3)
  assert.deepEqual(
    steps.map((step) => step.ok),
    [false, false, false],
  )
})

test('本机实测：没有令牌时，提示里不再说「开发者认证未完成」', async () => {
  /**
   * 这条跑在真机上。前提是「本机当前没有可用令牌」——如果哪天登录恢复了，
   * 这条会自然失效（拿到的是 ok 分支），所以断言写成「要么真就绪，要么措辞
   * 不冒认后两项」，而不是硬编码某个状态。
   */
  const readiness = await probeWeiboCli()
  if (readiness.canRead) {
    assert.equal(readiness.status, 'ok', '能读的时候状态应当是 ok')
    return
  }

  const message = readiness.message
  const steps = readiness.steps.join(' ')

  // 关键断言：模板形态下不能出现「开发者认证未完成」这种断言
  const claimsCertFailed = /完成开发者认证[^。]*未完成/.test(message)
  const isTemplateShaped =
    (readiness.doctorSteps ?? []).length >= 3 &&
    (readiness.doctorSteps ?? []).every((step) => !step.ok)

  if (isTemplateShaped) {
    assert.equal(
      claimsCertFailed,
      false,
      `没有令牌时不能说「开发者认证未完成」——那两项根本没检查过。实际：${message}`,
    )
    assert.match(message, /没有可用令牌|登录令牌|取不到/, '必须说清缺的是令牌')
    assert.match(
      steps,
      /auth login/,
      '必须给出重新登录的命令——那是唯一确定缺的东西',
    )
    assert.match(
      steps,
      /未检查|没有检查/,
      '必须明说后两项「没检查」，否则读者会把它当成「检查后不合格」',
    )
  }
})

test('模板形态的判据不误伤真检查结果：第一项 ✓ 时仍逐项报', () => {
  const steps = parseDoctorReport(
    [line('✓', '注册或登录'), line('×', '完成开发者认证'), line('×', '开通服务')].join('\n'),
  )
  assert.equal(steps[0]?.ok, true, '前置：登录是通过的')
  assert.equal(
    steps.every((step) => !step.ok),
    false,
    '第一项通过时不是模板形态——这种情况下的 × 是真的检查结果，要逐项报',
  )
})

test('两项形态不判成模板：少于三行说明输出不是那段模板', () => {
  const steps = parseDoctorReport([line('×', '注册或登录'), line('×', '完成开发者认证')].join('\n'))
  assert.equal(steps.length, 2)
  assert.equal(
    steps.length >= 3,
    false,
    '只有两行时不能按模板处理——可能是 CLI 版本变了，需要逐项报以便被发现',
  )
})
