/**
 * v0.2.36 §4：出网边界。
 *
 * ## 这组测试要证明的三件事
 *
 * 1. **策略真的会拒绝**：`offline` / `manual` 下的平台主机、外部主机被拦，且拦在
 *    建立连接之前。
 * 2. **自检能区分「活的守卫」与「没装上的守卫」**：一个从不拒绝的守卫，在日志里
 *    与没有守卫长得一模一样。自检必须走一次**确定会被拒**的地址。
 * 3. **审计是真的在写**：内存里有的东西，落盘文件里也要有；反过来，落盘的东西
 *    不能包含凭据、查询串或正文。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  EgressBlockedError,
  EgressGuard,
  EgressLog,
  egressPolicyOf,
  isPlatformHost,
} from '../lib/net-audit.js'

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'egress-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('open 模式放行一切，但仍留痕', () => {
  withDir((dir) => {
    const log = new EgressLog(join(dir, 'egress.jsonl'))
    const guard = new EgressGuard({ mode: 'open', allowedHosts: [] }, log)
    guard.check('https://api.weibo.com/2/statuses/home_timeline.json', 'platform')
    const entries = log.readBack()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.decision, 'allow')
    assert.equal(entries[0]!.host, 'api.weibo.com')
    assert.match(entries[0]!.reason, /open/)
  })
})

test('offline 模式：回环放行，外部与平台都拒绝', () => {
  withDir((dir) => {
    const guard = new EgressGuard({ mode: 'offline', allowedHosts: [] }, new EgressLog(join(dir, 'e.jsonl')))
    assert.doesNotThrow(() => guard.check('http://127.0.0.1:58999/v1/chat/completions', 'model'))
    assert.doesNotThrow(() => guard.check('http://localhost:1234/x', 'other'))
    for (const url of ['https://api.openai.com/v1/x', 'https://m.weibo.cn/api/x', 'https://tieba.baidu.com/p/1']) {
      assert.throws(
        () => guard.check(url, 'platform'),
        (error: unknown) => {
          assert.ok(error instanceof EgressBlockedError)
          assert.equal(error.code, 'egress_blocked')
          return true
        },
        `${url} 在 offline 下必须被拒`,
      )
    }
  })
})

test('manual 模式：只放模型白名单，平台主机即使写进白名单也拒绝', () => {
  withDir((dir) => {
    const log = new EgressLog(join(dir, 'e.jsonl'))
    const policy = egressPolicyOf({ mode: 'manual', llmBaseUrl: 'https://newapi.example.com/v1' })
    const guard = new EgressGuard({ ...policy, allowedHosts: [...policy.allowedHosts, 'api.weibo.com'] }, log)

    // 模型地址放行。
    assert.doesNotThrow(() => guard.check('https://newapi.example.com/v1/chat/completions', 'model'))
    // 平台主机虽然在 allowedHosts 里，仍然拒绝 —— 这条是刻意的：一次配置失误
    // 不该让「手动导入不碰平台」这条承诺失效。
    assert.throws(() => guard.check('https://api.weibo.com/2/x', 'platform'), /平台主机/)
    assert.throws(() => guard.check('https://tieba.baidu.com/mo/q/m', 'platform'), /平台主机/)
    // 其他外部主机也不放行。
    assert.throws(() => guard.check('https://example.org/x', 'model'), /manual/)

    const denies = log.readBack().filter((entry) => entry.decision === 'deny')
    assert.equal(denies.length, 3)
  })
})

test('守卫包住的 fetch 在拒绝时不会真的发请求', async () => {
  withDir((dir) => {
    const guard = new EgressGuard({ mode: 'offline', allowedHosts: [] }, new EgressLog(join(dir, 'e.jsonl')))
    let called = 0
    const base = (async () => {
      called += 1
      return new Response('ok')
    }) as unknown as typeof fetch
    const guarded = guard.fetch(base)
    return (async () => {
      await assert.rejects(() => guarded('https://api.weibo.com/2/x'), /已阻止一次出网/)
      assert.equal(called, 0, '被拒的请求不能触及底层 fetch')
      await guarded('http://127.0.0.1:9/x')
      assert.equal(called, 1, '放行的请求应当真的走到底层')
    })()
  })
})

test('自检：offline 下必须 blocked=true，open 下必须 blocked=false', async () => {
  withDir((dir) => {
    const offline = new EgressGuard({ mode: 'offline', allowedHosts: [] }, new EgressLog(join(dir, 'a.jsonl')))
    return (async () => {
      const blocked = await offline.selfTest()
      assert.equal(blocked.blocked, true)
      assert.equal(blocked.mode, 'offline')
      assert.match(blocked.host, /\.invalid$/, '用保留顶级域，不碰任何真实站点')

      const open = new EgressGuard({ mode: 'open', allowedHosts: [] }, new EgressLog(join(dir, 'b.jsonl')))
      // 用一眼就会失败的 fetch：这里只验证「策略放行了」，不验证网络。
      const notBlocked = await open.selfTest((async () => {
        throw new Error('dns fail')
      }) as unknown as typeof fetch)
      assert.equal(notBlocked.blocked, false, 'open 模式没拦住，就必须如实报告没拦住')
    })()
  })
})

test('平台子进程：manual / offline 下启动即拒绝，并留痕', () => {
  withDir((dir) => {
    const log = new EgressLog(join(dir, 'e.jsonl'))
    const guard = new EgressGuard({ mode: 'manual', allowedHosts: [] }, log)
    assert.throws(() => guard.assertSpawn('platform', 'comments.list'), /禁止启动平台进程/)
    const entry = log.readBack().at(-1)
    assert.ok(entry !== undefined)
    assert.equal(entry.decision, 'deny')
    assert.match(entry.host, /spawn:comments\.list/)

    const open = new EgressGuard({ mode: 'open', allowedHosts: [] }, new EgressLog(join(dir, 'o.jsonl')))
    assert.doesNotThrow(() => open.assertSpawn('platform', 'comments.list'))
  })
})

test('审计文件：一行一条 JSON，且不写入任何凭据或查询串', () => {
  withDir((dir) => {
    const path = join(dir, 'egress.jsonl')
    const guard = new EgressGuard({ mode: 'open', allowedHosts: [] }, new EgressLog(path))
    guard.check('https://api.openai.com/v1/chat/completions?api_key=sk-secret&q=hello', 'model')
    const raw = readFileSync(path, 'utf8')
    assert.equal(raw.includes('sk-secret'), false, '审计不能把查询串里的密钥抄进去')
    assert.equal(raw.includes('api_key'), false)
    assert.equal(raw.includes('hello'), false)
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed).sort(), ['at', 'decision', 'host', 'mode', 'purpose', 'reason'].sort())
  })
})

test('平台主机识别：子域算，仿冒域名不算', () => {
  assert.equal(isPlatformHost('weibo.com'), true)
  assert.equal(isPlatformHost('api.weibo.com'), true)
  assert.equal(isPlatformHost('tieba.baidu.com'), true)
  assert.equal(isPlatformHost('m.weibo.cn'), true)
  assert.equal(isPlatformHost('weibo.com.evil.example'), false, '前缀仿冒不是平台')
  assert.equal(isPlatformHost('notweibo.com'), false)
  assert.equal(isPlatformHost('api.openai.com'), false)
})

test('策略生成：模型地址自动进白名单，端口不影响主机判断', () => {
  const policy = egressPolicyOf({ mode: 'manual', llmBaseUrl: 'http://127.0.0.1:58999/v1' })
  assert.deepEqual(policy.allowedHosts, ['127.0.0.1'])
  assert.equal(policy.mode, 'manual')
  const guard = new EgressGuard(policy, new EgressLog())
  assert.doesNotThrow(() => guard.check('http://127.0.0.1:58999/v1/chat/completions', 'model'))
})
