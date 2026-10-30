/**
 * v0.2.13 §四：微博动态诊断的 Host 链路。
 *
 * ## 这个文件防的是什么
 *
 * v0.2.12 写了 `src/platforms/weibo/diagnostics.ts` 和 `Provider.describeDiagnostics()`，
 * 但**设置页面的路由里没有任何一处调用它**。独立审计的结论「没有发现设置页面真正调用该诊断
 * 的正式链路」是对的：能力写了，通道没接。
 *
 * 这里断言的是通道本身：
 * 1. `/status` 把平台块带给客户端；
 * 2. 未认证请求读不到；
 * 3. 平台报错时**显示失败**，而不是渲染成「没有平台」；
 * 4. `refresh-platforms` 动作真的会重新探测，而不是读缓存。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { makeSettingsRoutes } from '../lib/settings-routes.js'
import type { PlatformDiagnosticBlock, SettingsRouteDeps } from '../lib/settings-routes.js'

/** A minimal deps object; only the fields these tests exercise are meaningful. */
function makeDeps(overrides: Partial<SettingsRouteDeps> = {}): SettingsRouteDeps {
  const noop = async (): Promise<never> => {
    throw new Error('not used in this test')
  }
  return {
    // `authorize` is synchronous in the Host contract: it answers 'ok' | 401 | 403.
    authorize: () => 'ok',
    view: async () => ({
      status: 'ready',
      writable: true,
      values: {},
      secrets: [],
      platforms: [],
    }),
    mutate: noop,
    setSecret: noop,
    clearSecret: noop,
    refreshSecrets: async () => undefined,
    testModel: async () => ({ ok: true }),
    checkLogin: async () => ({ ok: true }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({ stopped: 0 }),
    diagnostics: async () => ({
      enabled: true,
      storePath: '/tmp/store.json',
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.2.13',
    }),
    ...overrides,
  } as SettingsRouteDeps
}

/** Drive one route handler directly, bypassing the HTTP server. */
async function callRoute(
  deps: SettingsRouteDeps,
  path: string,
  init: { method?: string; body?: unknown; origin?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`没有注册路由 ${path}`)

  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status
      if (headers !== undefined) Object.assign(this.headers, headers)
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') this.chunks.push(chunk)
      return this
    },
  }

  const bodyText = init.body === undefined ? undefined : JSON.stringify(init.body)
  const request = {
    method: init.method ?? 'GET',
    url: path,
    headers: {
      host: '127.0.0.1:1',
      origin: init.origin ?? 'http://127.0.0.1:1',
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (bodyText !== undefined) yield Buffer.from(bodyText, 'utf8')
    },
  }

  // The handlers are async; awaiting the return value is what actually lets the response be
  // written. Without it every assertion below reads an empty status code.
  await route.handler(request as never, response as never)
  const text = response.chunks.join('')
  return {
    status: response.statusCode,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  }
}

const STATUS_PATH = '/api/dsh-ai-debate/status'
const ACTION_PATH = '/api/dsh-ai-debate/action'

const WEIBO_BLOCK: PlatformDiagnosticBlock = {
  platform: 'weibo',
  displayName: '微博',
  state: {
    cliInstalled: false,
    lines: [
      { state: 'cli_missing', message: '没有安装 weibo-cli', steps: ['先安装'] },
      { state: 'not_implemented', message: '子评论读取参数尚未确认' },
    ],
    scope: 'read-only',
  },
}

// ---------------------------------------------------------------------------
// 1. /status 带上平台块
// ---------------------------------------------------------------------------

test('诊断链路：/status 把平台块带给客户端', async () => {
  const deps = makeDeps({ platformDiagnostics: async () => [WEIBO_BLOCK] })
  const answer = await callRoute(deps, STATUS_PATH)
  assert.equal(answer.status, 200)
  const body = answer.body as { platforms?: PlatformDiagnosticBlock[] }
  assert.equal(Array.isArray(body.platforms), true, `应带 platforms 字段：${JSON.stringify(body)}`)
  assert.equal(body.platforms!.length, 1)
  assert.equal(body.platforms![0]!.platform, 'weibo')
  // The negative answer survives the trip: this is the whole point of the field.
  const state = body.platforms![0]!.state as { cliInstalled: boolean }
  assert.equal(state.cliInstalled, false)
})

test('诊断链路：没有平台诊断能力时不伪造空数组（保持字段缺失）', async () => {
  // An absent field is distinguishable from "checked, found nothing". The client renders
  // "no live diagnostic" for the former; an empty array would read as all-clear.
  const deps = makeDeps()
  const answer = await callRoute(deps, STATUS_PATH)
  const body = answer.body as { platforms?: unknown }
  assert.equal('platforms' in body, false, '无能力时不该出现 platforms 字段')
})

test('诊断链路：平台探测抛错时显示失败，而不是显示为「没有平台」', async () => {
  const deps = makeDeps({
    platformDiagnostics: async () => {
      throw new Error('OAuth 状态读取失败')
    },
  })
  const answer = await callRoute(deps, STATUS_PATH)
  assert.equal(answer.status, 200, '诊断失败不该让整页 500')
  const body = answer.body as { platforms?: { error?: string }[] }
  assert.equal(Array.isArray(body.platforms), true)
  assert.equal(body.platforms!.length, 1)
  assert.match(body.platforms![0]!.error ?? '', /OAuth 状态读取失败/)
})

// ---------------------------------------------------------------------------
// 2. 未认证读不到
// ---------------------------------------------------------------------------

test('诊断链路：未认证请求读不到平台诊断', async () => {
  const deps = makeDeps({
    authorize: () => 401,
    platformDiagnostics: async () => [WEIBO_BLOCK],
  })
  const answer = await callRoute(deps, STATUS_PATH)
  assert.equal(answer.status, 401, `应拒绝，实际 ${answer.status}`)
  assert.equal(
    JSON.stringify(answer.body).includes('weibo-cli'),
    false,
    '被拒时不得泄露诊断内容',
  )
})

// ---------------------------------------------------------------------------
// 3. 刷新动作真的重新探测
// ---------------------------------------------------------------------------

test('诊断链路：refresh-platforms 传 refresh=true 给适配器', async () => {
  const seen: (boolean | undefined)[] = []
  const deps = makeDeps({
    platformDiagnostics: async (options) => {
      seen.push(options?.refresh)
      return [WEIBO_BLOCK]
    },
  })
  const answer = await callRoute(deps, ACTION_PATH, {
    method: 'POST',
    body: { action: 'refresh-platforms' },
  })
  assert.equal(answer.status, 200)
  assert.deepEqual(seen, [true], '刷新按钮必须传 refresh=true，否则只会读缓存')
  const body = answer.body as { platforms?: unknown[] }
  assert.equal(Array.isArray(body.platforms), true)
})

test('诊断链路：refresh-platforms 是 POST，GET 不被接受', async () => {
  // A GET that triggers a probe would be cacheable by intermediaries and reachable by a
  // prefetch; the state change needs a POST.
  const deps = makeDeps({
    platformDiagnostics: async () => [WEIBO_BLOCK],
  })
  const answer = await callRoute(deps, ACTION_PATH, { body: { action: 'refresh-platforms' } })
  assert.equal(answer.status, 405, `GET 应 405，实际 ${answer.status}`)
})

test('诊断链路：刷新失败时报告错误，不返回空成功', async () => {
  const deps = makeDeps({
    platformDiagnostics: async () => {
      throw new Error('探测进程启动失败')
    },
  })
  const answer = await callRoute(deps, ACTION_PATH, {
    method: 'POST',
    body: { action: 'refresh-platforms' },
  })
  assert.equal(answer.status, 200)
  const body = answer.body as { platforms?: unknown[]; error?: string }
  assert.equal(Array.isArray(body.platforms), true)
  assert.equal(body.platforms!.length, 0)
  assert.match(body.error ?? '', /探测进程启动失败/)
})
