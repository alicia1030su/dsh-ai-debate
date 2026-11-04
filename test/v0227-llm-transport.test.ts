/**
 * The transport contract for a real model endpoint (v0.2.27 §三).
 *
 * ## What this file is about
 *
 * "The model returned HTTP 200" is not success. It is one fact about the transport. Whether
 * a reply exists, whether it is complete, whether it is even the shape this endpoint claims
 * to speak — those are separate questions, and each one has a failure mode that looks like
 * a working system if it is not checked.
 *
 * The list below is the task book's §三, one test per line, plus the ones the existing
 * `llm-e2e-mock` file already covered (kept there, not duplicated here):
 *
 * | case | what must happen |
 * | --- | --- |
 * | empty body | `bad_response`, never an empty candidate |
 * | non-JSON | `bad_response` |
 * | missing `choices` | `bad_response`, and the message says the protocol may be wrong |
 * | `finish_reason: length` | `truncated: true`, and the generator refuses it |
 * | 401 / 403 | `unauthorized`, **not retried** |
 * | 402 | `quota`, not retried |
 * | 429 | `rate_limited`, retried when a budget is given |
 * | 500 | `unavailable`, retried when a budget is given |
 * | timeout | `timeout`, retried, and cancellation still wins |
 * | cancellation | `cancelled`, immediate, no retry afterwards |
 *
 * The retry tests matter as much as the classification: a retry loop that re-sends a 401
 * spends three requests to learn the same thing, and one that re-sends after the caller
 * cancelled makes a closed page keep working.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError, OpenAiCompatibleClient, type OpenAiClientOptions } from '../lib/llm.js'

/** A fetch double: a queue of replies, and a count of how many were requested. */
function scriptedFetch(
  replies: readonly (
    | { status?: number; body: string }
    | { throws: Error }
  )[],
): { fetchImpl: typeof fetch; calls: { url: string; body: unknown; headers: Record<string, string> }[] } {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
  let index = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers,
    })
    const next = replies[index]
    index += 1
    if (next === undefined) throw new Error('测试没有更多响应')
    if ('throws' in next) throw next.throws
    return new Response(next.body, { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(
  fetchImpl: typeof fetch,
  extra: Partial<OpenAiClientOptions> = {},
): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 5_000,
    fetchImpl,
    // Most tests are about one attempt; each retry test opts in explicitly.
    maxRetries: 0,
    retryDelayMs: 1,
    ...extra,
  })
}

const okBody = (content: string, finishReason = 'stop'): string =>
  JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  })

// ── The response shape ──────────────────────────────────────────────────────

test('空正文是失败，不是一条空回复', async () => {
  const { fetchImpl } = scriptedFetch([{ body: okBody('   ') }])
  await assert.rejects(
    () => client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'bad_response')
      return true
    },
  )
})

test('非 JSON 响应是 bad_response，并把响应片段带进消息', async () => {
  const { fetchImpl } = scriptedFetch([{ body: 'this is not json' }])
  await assert.rejects(
    () => client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'bad_response')
      assert.match(error.message, /非 JSON/)
      return true
    },
  )
})

test('缺少 choices 时说明「可能是协议不兼容」，而不是说模型没说话', async () => {
  // A `/v1/responses` endpoint answers 200 with a different shape. Reporting `空内容` sends
  // the owner to check the prompt; the actual fix is the Base URL.
  const { fetchImpl } = scriptedFetch([{ body: JSON.stringify({ output: [] }) }])
  await assert.rejects(
    () => client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'bad_response')
      assert.match(error.message, /choices/)
      assert.match(error.message, /协议不兼容|chat\/completions/)
      return true
    },
  )
})

test('finish_reason=length 被标成 truncated，且正文仍然返回', async () => {
  const { fetchImpl } = scriptedFetch([{ body: okBody('{"status":"ok","reply":"说到一半', 'length') }])
  const response = await client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(response.truncated, true, '被截断必须显式标记，不能只靠正文长度猜')
  assert.equal(response.finishReason, 'length')
  assert.match(response.text, /说到一半/, '截断的正文本身仍是真实收到的内容')
})

test('正常结束时 truncated 不是 true（不能把「短回答」当成「被截断」）', async () => {
  const { fetchImpl } = scriptedFetch([{ body: okBody('好') }])
  const response = await client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] })
  assert.notEqual(response.truncated, true)
  assert.equal(response.finishReason, 'stop')
})

test('token 用量被原样带回，用于统计', async () => {
  const { fetchImpl } = scriptedFetch([{ body: okBody('ok') }])
  const response = await client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(response.inputTokens, 11)
  assert.equal(response.outputTokens, 7)
})

// ── HTTP failures ───────────────────────────────────────────────────────────

test('401 是 unauthorized，不是 unavailable', async () => {
  // `unavailable` is in the retryable set; 401 was classified as it, so a wrong key was
  // retried and the panel blamed the network.
  const { fetchImpl } = scriptedFetch([{ status: 401, body: 'bad key' }])
  await assert.rejects(
    () => client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unauthorized')
      assert.equal(error.status, 401)
      return true
    },
  )
})

test('403 同样是 unauthorized', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 403, body: 'forbidden' }])
  await assert.rejects(
    () => client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => (error instanceof LlmError ? error.code === 'unauthorized' : false),
  )
})

test('402 是额度不足，不重试', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 402, body: 'no money' }])
  await assert.rejects(
    () => client(fetchImpl, { maxRetries: 3 }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => (error instanceof LlmError ? error.code === 'quota' : false),
  )
  assert.equal(calls.length, 1, '额度不足重试也不会变好，只会多花三次配额')
})

test('429 是限流，给了预算才重试，且重试成功就返回', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 429, body: 'slow down' },
    { body: okBody('第二次成功') },
  ])
  const response = await client(fetchImpl, { maxRetries: 1 }).complete({
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(response.text, '第二次成功')
  assert.equal(calls.length, 2)
  assert.equal(response.attempts, 2, '要能看出这次结果用了几次尝试')
})

test('500 是内部错误，重试到预算用尽后抛出最后一次失败', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 500, body: 'boom' },
    { status: 502, body: 'still boom' },
    { status: 503, body: 'nope' },
  ])
  await assert.rejects(
    () => client(fetchImpl, { maxRetries: 2 }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unavailable')
      assert.equal(error.status, 503, '抛出的是最后一次真实状态码，不是笼统的失败')
      return true
    },
  )
  assert.equal(calls.length, 3, '默认预算之外不能无限重试')
})

test('没有给预算时不重试（默认行为不能偷偷多花钱）', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 500, body: 'boom' }])
  await assert.rejects(
    () => client(fetchImpl).complete({ messages: [{ role: 'user', content: 'x' }] }),
    () => true,
  )
  assert.equal(calls.length, 1)
})

test('重试会调用 onRetry，让日志能记录分类而不是只看到次数', async () => {
  const seen: { attempt: number; code: string }[] = []
  const { fetchImpl } = scriptedFetch([{ status: 429, body: '' }, { body: okBody('ok') }])
  await client(fetchImpl, {
    maxRetries: 1,
    onRetry: (info: { attempt: number; code: string }) => seen.push({ attempt: info.attempt, code: info.code }),
  }).complete({ messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual(seen, [{ attempt: 1, code: 'rate_limited' }])
})

// ── Time and cancellation ───────────────────────────────────────────────────

test('超时被标成 timeout，且与取消区分开', async () => {
  const { fetchImpl } = scriptedFetch([
    {
      throws: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    },
  ])
  await assert.rejects(
    () => client(fetchImpl, { timeoutMs: 5_000 }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => (error instanceof LlmError ? error.code === 'timeout' : false),
  )
})

test('外部取消立即生效，归为 cancelled，且不会被重试', async () => {
  const controller = new AbortController()
  const { fetchImpl, calls } = scriptedFetch([
    { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
  ])
  const promise = client(fetchImpl, { maxRetries: 3 }).complete({
    messages: [{ role: 'user', content: 'x' }],
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(promise, (error: unknown) =>
    error instanceof LlmError ? error.code === 'cancelled' : false,
  )
  assert.equal(calls.length, 1, '取消之后不能再发请求')
})

test('等待重试期间取消，立刻结束而不是等到退避结束', async () => {
  const controller = new AbortController()
  const { fetchImpl, calls } = scriptedFetch([{ status: 500, body: '' }])
  const promise = client(fetchImpl, { maxRetries: 3, retryDelayMs: 5_000 }).complete({
    messages: [{ role: 'user', content: 'x' }],
    signal: controller.signal,
  })
  // Abort while the backoff timer is pending.
  setTimeout(() => controller.abort(), 30)
  const started = Date.now()
  await assert.rejects(promise, (error: unknown) =>
    error instanceof LlmError ? error.code === 'cancelled' : false,
  )
  assert.ok(Date.now() - started < 2_000, '取消必须打断退避，而不是等它自然结束')
  assert.equal(calls.length, 1)
})

// ── Request shape ───────────────────────────────────────────────────────────

test('请求发到 /chat/completions，带 Bearer 与 system 消息', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: okBody('ok') }])
  await client(fetchImpl).complete({
    system: '你是辩论助手',
    messages: [{ role: 'user', content: '开始' }],
    temperature: 0.3,
    maxTokens: 64,
  })
  assert.equal(calls[0]!.url, 'http://127.0.0.1:9/v1/chat/completions')
  assert.equal(calls[0]!.headers['authorization'], 'Bearer test-key')
  const body = calls[0]!.body as { model: string; messages: { role: string; content: string }[] }
  assert.equal(body.model, 'test-model')
  assert.equal(body.messages[0]!.role, 'system')
  assert.equal(body.messages[0]!.content, '你是辩论助手')
})

test('没有配置 Base URL 或模型名时立刻拒绝，不发出空请求', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: okBody('ok') }])
  await assert.rejects(
    () => client(fetchImpl, { baseUrl: '' } as never).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => (error instanceof LlmError ? error.code === 'unavailable' : false),
  )
  await assert.rejects(
    () => client(fetchImpl, { model: '' } as never).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => (error instanceof LlmError ? error.code === 'unavailable' : false),
  )
  assert.equal(calls.length, 0, '配置不全时一个网络请求都不该发出去')
})

test('Base URL 末尾的斜杠不会拼出双斜杠', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: okBody('ok') }])
  await client(fetchImpl, { baseUrl: 'http://127.0.0.1:9/v1///' } as never).complete({
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(calls[0]!.url, 'http://127.0.0.1:9/v1/chat/completions')
})

// ── The generator must not treat a cut-off answer as an answer ──────────────

test('被截断的输出不会变成候选；两次都截断时报 truncated，不是 unparseable', async () => {
  const { generateReply } = await import('../lib/generator.js')
  const { analyzeDispute } = await import('../lib/analyzer.js')
  const { compressContext } = await import('../lib/compressor.js')
  const { resolveBudget } = await import('../lib/compressor.js')
  const { DEFAULT_PERSONA } = await import('../lib/persona.js')
  const { makeFloor, makeNested } = await import('./helpers.ts')

  // Build the options the same way `generator.test.ts` does, so this test cannot drift into
  // asserting against a hand-rolled shape the real caller never produces.
  const floorPostId = '3000'
  const nested = [
    makeNested({ postId: 'g1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '成本会翻倍。' }),
    makeNested({ postId: 'g2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :有依据吗？', replyToName: '主人' }),
    makeNested({ postId: 'g3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@小号 上。' }),
  ]
  const collected = {
    thread: {
      platform: 'tieba' as const,
      forum: { platform: 'tieba' as const, id: '1', name: '测试吧' },
      id: '1',
      title: '方案值不值得做',
      content: '大家看看。',
      url: 'https://tieba.baidu.com/p/1',
      images: [],
    },
    floors: [
      {
        floor: makeFloor({ floorNumber: 2, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length }),
        nested,
        nestedComplete: true,
      },
    ],
    complete: true,
    completeness: { sourceComplete: true, retainedComplete: true, analysisComplete: true, nestedComplete: true, reasons: [] },
    issues: [],
  }
  const dispute = analyzeDispute(collected as never, { userId: 'o' }, { postId: 'g3' })
  const context = compressContext({
    collected: collected as never,
    dispute,
    trigger: { postId: 'g3' },
    persona: DEFAULT_PERSONA,
    budget: resolveBudget({ preset: 'small' }),
  })

  let calls = 0
  const truncatedClient = {
    label: 'truncated-double',
    complete: async () => {
      calls += 1
      return {
        text: '{"status":"ok","owner_position":"甲方","reply":"成本可以分摊到',
        truncated: true,
        finishReason: 'length',
        outputTokens: 400,
      }
    },
  }

  const result = await generateReply(truncatedClient as never, {
    dispute,
    context,
    persona: DEFAULT_PERSONA,
  } as never)

  assert.equal(result.draft, undefined, '截断的输出不能变成候选——它只是一句话的前半截')
  assert.ok(
    result.violations.some((violation) => violation.code === 'truncated'),
    `必须报成 truncated，让主人去调大输出上限；实际：${result.violations.map((v) => v.code).join(',')}`,
  )
  assert.equal(calls, 2, '先重试一次（常见原因就是上限太低），两次都截断才报错')
})
