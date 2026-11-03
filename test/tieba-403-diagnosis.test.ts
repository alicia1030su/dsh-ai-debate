/**
 * A 403 is at least four different facts, and v0.2.22 reported them as one.
 *
 * The case that made this file necessary: a real read returned HTTP 403 carrying
 * Baidu's security-verification page. `HttpClient` threw `平台返回 403（forbidden）`
 * and dropped the body, so the read path could not tell "the platform wants a
 * human" from "the post is gone" and reported the first as the second — sending
 * the owner to look for a deleted thread while the fix was to open a browser.
 *
 * Every test here runs against a stubbed `fetch`; nothing touches the network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HttpClient } from '../lib/platforms/http.js'
import { classifyFault } from '../lib/fault-classify.js'

/** The exact body Baidu served on the live block, trimmed to its markers. */
const VERIFICATION_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>百度安全验证</title><style>body{margin:0}</style></head><body>
<div class="verify-wrap">请完成安全验证</div></body></html>`

/** Install a fake fetch that always answers with one canned response. */
function withFetch(
  status: number,
  body: string,
  contentType = 'text/html; charset=utf-8',
): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': contentType },
    })) as typeof globalThis.fetch
  return {
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('403 携带安全验证页：code 必须是 captcha，不是 forbidden', async () => {
  const stub = withFetch(403, VERIFICATION_PAGE)
  try {
    const client = new HttpClient({ timeoutMs: 5000, retries: 0 })
    await assert.rejects(
      () => client.request('https://tieba.baidu.com/mo/q/m?kz=1'),
      (error: unknown) => {
        const e = error as { code?: string; message?: string }
        assert.equal(e.code, 'captcha', '验证页不能被报成普通 forbidden')
        assert.match(String(e.message), /安全验证页/, '错误文本要说清是验证页')
        assert.match(String(e.message), /不是登录失效/, '要排除登录失效的误判')
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('403 且响应体不是验证页：仍是 forbidden，不冒充 captcha', async () => {
  const stub = withFetch(403, '{"error":"no permission"}', 'application/json')
  try {
    const client = new HttpClient({ timeoutMs: 5000, retries: 0 })
    await assert.rejects(
      () => client.request('https://tieba.baidu.com/mo/q/m?kz=1'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'forbidden')
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('404 不带验证页：报 not_found，与验证页区分开', async () => {
  const stub = withFetch(404, '<html><title>404</title></html>')
  try {
    const client = new HttpClient({ timeoutMs: 5000, retries: 0 })
    await assert.rejects(
      () => client.request('https://tieba.baidu.com/mo/q/m?kz=1'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'not_found')
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('验证页的判定不依赖 HTTP 状态：200 带验证页同样识别', async () => {
  // This is the shape Tieba actually serves most often: a 200 whose body is the
  // verification page. The read path must not treat it as floors.
  const stub = withFetch(200, VERIFICATION_PAGE)
  try {
    const client = new HttpClient({ timeoutMs: 5000, retries: 0 })
    const result = await client.request('https://tieba.baidu.com/mo/q/m?kz=1')
    assert.equal(result.status, 200)
    // A 200 is a 200 to this layer; the *parser* is what must notice. Asserting
    // the body survives is enough here — the marker check lives there.
    assert.match(result.text, /百度安全验证/)
  } finally {
    stub.restore()
  }
})

test('分类层对 captcha 的处置建议：不重试、不换 IP、要求人工', () => {
  const verdict = classifyFault({ code: 'captcha', status: 403, message: VERIFICATION_PAGE })
  assert.equal(verdict.kind, 'challenge')
  assert.equal(verdict.retryable, false, '验证页绝不能自动重试')
  assert.match(verdict.nextStep ?? '', /不要连续重试/)
  // The advice must not offer a bypass. It is fine — required, even — for it to
  // say it *will not* bypass; what must not appear is an instruction to swap IPs
  // or proxies and try again.
  assert.equal(/换\s*IP|切换代理|使用代理重试/.test(verdict.nextStep ?? ''), false)
})

test('分类层不能把验证页误判成登录问题', () => {
  const verdict = classifyFault({ code: 'captcha', status: 403, message: VERIFICATION_PAGE })
  assert.notEqual(verdict.kind, 'auth_required')
  assert.notEqual(verdict.kind, 'platform_refused')
})

test('HTTP 层与分类层的验证页标记保持一致', async () => {
  // The two lists are deliberately duplicated; this test is what keeps them from
  // drifting. A body that one recognises and the other does not is a bug.
  const markers = ['百度安全验证', '请输入验证码', 'wappass.baidu.com', '人机验证']
  for (const marker of markers) {
    const stub = withFetch(403, `<html><body>${marker}</body></html>`)
    try {
      const client = new HttpClient({ timeoutMs: 5000, retries: 0 })
      let httpSaw = false
      await assert.rejects(
        () => client.request('https://tieba.baidu.com/mo/q/m?kz=1'),
        (error: unknown) => {
          httpSaw = (error as { code?: string }).code === 'captcha'
          return true
        },
      )
      const classified = classifyFault({ status: 403, message: marker })
      assert.equal(httpSaw, true, `HTTP 层没有识别标记「${marker}」`)
      assert.equal(classified.kind, 'challenge', `分类层没有识别标记「${marker}」`)
    } finally {
      stub.restore()
    }
  }
})
