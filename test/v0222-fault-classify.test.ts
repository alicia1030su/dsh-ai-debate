/**
 * The 403 fault classifier (v0.2.22 §六).
 *
 * ## The mistake this prevents
 *
 * "www.baidu.com works, so tieba.baidu.com should work" is the reasoning that kept this
 * deployment calling a blocked host for weeks. They are separate hosts with separate protections.
 * Every assertion below that mentions reachability is about **the platform's own host**, and one
 * test deliberately feeds the "other host is fine" fact to prove the classifier ignores it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { blocksPublishing, classifyFault } from '../lib/fault-classify.js'

describe('v0.2.22 §六：平台故障分类', () => {
  it('主机不可达优先于其它一切：没有应答就没有「会话失效」这种结论', () => {
    const report = classifyFault({ hostReachable: false, status: 403, code: 'forbidden' })
    assert.equal(report.kind, 'unreachable')
    assert.match(report.nextStep, /每个平台的主机|单独测试/)
    assert.equal(report.retryable, true)
  })

  it('没有配置凭据时不说成权限问题', () => {
    const report = classifyFault({ hasCredential: false, status: 403 })
    assert.equal(report.kind, 'not_logged_in')
    assert.equal(blocksPublishing(report), true)
  })

  it('验证码页即使返回 403 也归为反爬，而不是权限不足', () => {
    const report = classifyFault({ status: 403, code: 'forbidden', message: '请完成安全验证后继续访问' })
    assert.equal(report.kind, 'challenge')
    assert.match(report.nextStep, /不会绕过验证码/)
    assert.equal(report.retryable, false, '连续重试只会延长限制')
  })

  it('429 与 rate_limited 归为限流，且建议不是换 IP', () => {
    for (const evidence of [{ status: 429 }, { code: 'rate_limited' as const }]) {
      const report = classifyFault(evidence)
      assert.equal(report.kind, 'rate_limited')
      assert.match(report.nextStep, /并发|翻页间隔/)
      // "Do not solve it by changing IP" is advice *against* evasion. What must not appear is an
      // instruction to do it — hence the check is on imperative phrasing, not on the two words.
      assert.doesNotMatch(report.nextStep, /请.*换 ?IP|建议.*代理|使用代理|切换 ?IP/, '建议里不能出现规避平台限制的做法')
    }
  })

  it('401 与「登录已过期」都归为会话失效', () => {
    for (const evidence of [
      { status: 401 },
      { code: 'auth_required' as const },
      { status: 403, message: '登录已过期，请重新登录' },
    ]) {
      assert.equal(classifyFault(evidence).kind, 'session_invalid')
    }
  })

  it('明确的删除/无权限说明归为读取权限问题，而不是「平台拒绝」', () => {
    const report = classifyFault({ status: 403, message: '该内容已被删除' })
    assert.equal(report.kind, 'permission_denied')
    assert.equal(report.retryable, false, '同一个目标重试不会变好')
  })

  it('没有任何说明的 403 归为平台拒绝，并明确要求按平台自己的域名确认', () => {
    const report = classifyFault({ status: 403, code: 'forbidden' })
    assert.equal(report.kind, 'platform_refused')
    assert.match(report.nextStep, /这个平台自己的域名|不要用别的站点/)
    assert.doesNotMatch(report.nextStep, /绕过|captcha/i)
  })

  it('证据不足时给 unknown，不猜', () => {
    const report = classifyFault({})
    assert.equal(report.kind, 'unknown')
    assert.match(report.reason, /没有足够证据/)
  })

  it('结构异常不重试，但与「不能发表」是两件事', () => {
    const report = classifyFault({ code: 'malformed_response' })
    assert.equal(report.kind, 'malformed')
    assert.equal(report.retryable, false)
    assert.equal(blocksPublishing(report), false, '改版不该被说成「今天不能发」')
  })

  it('「别的域名能打开」不能被当作这个平台可用的证据', () => {
    // The two facts a naive check would combine: another host answered, this request 403ed.
    // The classifier must not conclude anything about reachability from the first one.
    const report = classifyFault({ status: 403, code: 'forbidden', hasCredential: true })
    assert.notEqual(report.kind, 'unreachable')
    assert.equal(report.kind, 'platform_refused')
    assert.match(report.nextStep, /不要用别的站点/)
  })

  it('能阻止发表的情形是有限的、可枚举的', () => {
    const blocking = (['challenge', 'session_invalid', 'not_logged_in', 'unreachable'] as const).map((kind) =>
      blocksPublishing(classifyFault(
        kind === 'challenge'
          ? { message: 'captcha' }
          : kind === 'session_invalid'
            ? { status: 401 }
            : kind === 'not_logged_in'
              ? { hasCredential: false }
              : { hostReachable: false },
      )),
    )
    assert.deepEqual(blocking, [true, true, true, true])
    // And the non-blocking ones stay non-blocking: a limit or a changed page shape is not a
    // statement that publishing is impossible.
    assert.equal(blocksPublishing(classifyFault({ status: 429 })), false)
    assert.equal(blocksPublishing(classifyFault({ status: 403, message: '该内容已被删除' })), false)
  })
})
