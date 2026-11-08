/**
 * The LLM boundary: one narrow interface, two implementations.
 *
 * Analysis and generation need "give me JSON back for this prompt". They do
 * not need to know whether the answer came from the Harness's own model
 * service or from a user-configured OpenAI-compatible endpoint. Keeping that
 * behind one interface is what makes the plugin testable without a network and
 * portable across Harness versions.
 */

/** A message in a chat-style request. */
export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** A request for one completion. */
export interface LlmRequest {
  readonly messages: readonly LlmMessage[]
  readonly system?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

/** The result of one completion. */
export interface LlmResponse {
  readonly text: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** Provider/model label, for the usage log. */
  readonly model?: string
  /**
   * Why generation stopped, when the provider said so (`finish_reason`).
   *
   * `length` is the one that matters: the answer was cut off at `max_tokens`. The text is
   * still real, but it is *incomplete*, and treating it as a finished reply is how a
   * truncated sentence reaches a publish button. Kept as the provider's own word rather
   * than collapsed into a boolean, so a future provider-specific reason is not lost.
   */
  readonly finishReason?: string
  /**
   * True when the provider reported that generation stopped because it hit the token cap.
   *
   * Derived here, in the transport, because it is a fact about the response, not an opinion
   * about the text: no content check can distinguish "short answer" from "answer cut in
   * half".
   */
  readonly truncated?: boolean
  /** How many attempts the client made before returning this, when retrying is enabled. */
  readonly attempts?: number
}

/** A classified LLM failure. */
export type LlmErrorCode =
  | 'unavailable'
  | 'unauthorized'
  | 'timeout'
  | 'rate_limited'
  | 'quota'
  | 'bad_response'
  | 'truncated'
  | 'context_too_long'
  | 'cancelled'
  | 'unknown'

/** An error from the LLM layer, with a code the caller can act on. */
export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly status?: number

  constructor(message: string, code: LlmErrorCode, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.code = code
    this.status = options.status
  }
}

/** The one method the rest of the plugin uses. */
export interface LlmClient {
  /** Short label used in logs and health reports. */
  readonly label: string
  /** Run one completion. Throws {@link LlmError} on failure. */
  complete(request: LlmRequest): Promise<LlmResponse>
}

/** Options for the OpenAI-compatible client. */
export interface OpenAiClientOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  /**
   * 用哪一套请求/响应形状（v0.2.34）。
   *
   * ## 为什么必须显式配置，而不是「看起来像就猜」
   *
   * 同一个 Base URL 上可能同时挂着 `/chat/completions` 与 `/responses`，而两家
   * 的 JSON 形状完全不同：前者读 `choices[0].message.content`，后者读
   * `output_text`（或 `output[].content[].text`）。用返回体去猜「这大概是哪一种」
   * 在成功时看不出问题，在**失败时会把「协议不对」报成「模型没说话」**——
   * 那正是最难查的一类故障。
   *
   * 所以这里要求调用方说清楚。默认 `chat`：它是最普遍的兼容形状，也是 v0.2.33
   * 之前唯一支持的形状，升级不该改变既有部署的行为。
   */
  readonly protocol?: 'chat' | 'responses'
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
  /**
   * How many *additional* attempts to make after a failure the transport classifies as
   * transient. Default 0: no retry unless asked.
   *
   * ## Why this is off by default, and what it is allowed to retry
   *
   * Retrying a generation is not free and not always safe. A timeout may mean the provider
   * is still working on the request; a 429 counts against the same quota the retry will
   * spend. So the default is "do not retry", and the caller that wants it must ask.
   *
   * When it is on, only failures where the request provably did not take effect are retried:
   * a connection error, a timeout, a 429, or a 5xx. Authentication (401/403), quota (402),
   * a context that is too long, a malformed response, or an explicit cancellation are **not**
   * retried — repeating them produces the same answer and spends the budget twice. This is
   * the rule `classifyHttpFailure` already encodes in the error codes; the retry loop reads
   * those codes rather than inspecting messages.
   */
  readonly maxRetries?: number
  /** Base delay for exponential backoff, in ms. Injected so tests do not wait. */
  readonly retryDelayMs?: number
  /** Called before each retry, for logging. */
  readonly onRetry?: (info: { attempt: number; code: LlmErrorCode; message: string }) => void
}

/** Failures that did not take effect and are worth one more attempt. */
const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(['unavailable', 'timeout', 'rate_limited'])

/**
 * Wait before a retry, bailing out if the caller cancels.
 *
 * A backoff timer that ignores cancellation keeps a closed page's request alive and, worse,
 * fires one more model call after the owner has already moved on.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new LlmError('生成被取消', 'cancelled'))
    }
    if (signal?.aborted === true) {
      clearTimeout(timer)
      reject(new LlmError('生成被取消', 'cancelled'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * An OpenAI-compatible chat-completions client.
 *
 * Written against the wire format directly instead of pulling in an SDK: the
 * whole protocol used here is one POST with a JSON body, and a dependency for
 * that would be more surface area than code.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly label: string
  private readonly options: OpenAiClientOptions
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAiClientOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.label = `openai-compatible:${options.model}`
  }

  /**
   * Run one completion, retrying only failures that provably did not take effect.
   *
   * The loop is deliberately outside `completeOnce`, so a single attempt stays a single
   * request: nothing here re-sends half a stream or reuses an aborted controller.
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const maxRetries = Math.max(0, this.options.maxRetries ?? 0)
    const baseDelay = this.options.retryDelayMs ?? 500
    let lastError: LlmError | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await this.completeOnce(request)
        return attempt === 0 ? response : { ...response, attempts: attempt + 1 }
      } catch (error) {
        const failure =
          error instanceof LlmError
            ? error
            : new LlmError(`模型接口请求失败：${String(error)}`, 'unavailable', { cause: error })
        lastError = failure
        // Cancellation is the caller's decision, and a 401 will not become a 200 by waiting.
        if (!RETRYABLE.has(failure.code) || attempt === maxRetries) throw failure
        // A cancelled caller must not be kept alive by a backoff timer.
        if (request.signal?.aborted === true) throw failure
        this.options.onRetry?.({
          attempt: attempt + 1,
          code: failure.code,
          message: failure.message,
        })
        await sleep(baseDelay * 2 ** attempt, request.signal)
      }
    }

    // Unreachable: the loop either returns or throws.
    throw lastError ?? new LlmError('模型接口请求失败', 'unknown')
  }

  /** One request, one response. No retry, no shared state. */
  private async completeOnce(request: LlmRequest): Promise<LlmResponse> {
    const { baseUrl, apiKey, model, timeoutMs = 120_000 } = this.options
    if (!baseUrl) throw new LlmError('没有配置模型接口地址（baseUrl）', 'unavailable')
    if (!model) throw new LlmError('没有配置模型名称（model）', 'unavailable')

    const protocol = this.options.protocol ?? 'chat'

    const messages: LlmMessage[] = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    messages.push(...request.messages)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(
          protocol === 'responses'
            ? responsesBody(model, messages, request)
            : chatBody(model, messages, request),
        ),
        signal: controller.signal,
      })

      const raw = await response.text()
      if (!response.ok) throw classifyHttpFailure(response.status, raw)

      const parsed = parseJsonBody(raw)

      return protocol === 'responses' ? readResponsesBody(parsed, model) : readChatBody(parsed, model)
    } catch (error) {
      if (error instanceof LlmError) throw error
      const err = error as { name?: string; message?: string }
      if (err?.name === 'AbortError') {
        throw new LlmError(request.signal?.aborted ? '生成被取消' : '模型接口超时', request.signal?.aborted ? 'cancelled' : 'timeout')
      }
      throw new LlmError(`模型接口请求失败：${err?.message ?? String(error)}`, 'unavailable', { cause: error })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** chat/completions 的请求体。 */
function chatBody(model: string, messages: readonly LlmMessage[], request: LlmRequest): Record<string, unknown> {
  return {
    model,
    messages,
    temperature: request.temperature ?? 0.8,
    max_tokens: request.maxTokens ?? 900,
  }
}

/**
 * Responses 协议的请求体。
 *
 * ## 只映射我们真的会用的字段
 *
 * `instructions` 对应 system，`input` 对应对话，`max_output_tokens` 对应输出上限。
 * 不猜别的字段：多传一个对方不认的键，有些网关会整条拒绝，而错误信息通常
 * 只会说 400。
 */
function responsesBody(model: string, messages: readonly LlmMessage[], request: LlmRequest): Record<string, unknown> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  return {
    model,
    ...(system === '' ? {} : { instructions: system }),
    input: rest.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'input_text', text: m.content }],
    })),
    temperature: request.temperature ?? 0.8,
    max_output_tokens: request.maxTokens ?? 900,
  }
}

function parseJsonBody(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new LlmError(`模型返回了非 JSON 内容：${raw.slice(0, 160)}`, 'bad_response')
  }
}

/** 读 chat/completions 的返回体。 */
function readChatBody(parsed: Record<string, unknown>, model: string): LlmResponse {
  const choices = parsed.choices
  // A 200 with no `choices` is a response the caller cannot use, and saying "empty
  // content" hides that the *shape* was wrong — which is the difference between "the
  // model had nothing to say" and "this endpoint is not a chat-completions API".
  if (!Array.isArray(choices)) {
    throw new LlmError(
      '模型响应缺少 choices 字段：这个地址可能不是 chat/completions 接口；如果它实现的是 Responses 协议，请把协议改成 responses',
      'bad_response',
    )
  }
  const choice = choices[0] as { message?: { content?: string }; finish_reason?: string } | undefined
  const text = choice?.message?.content ?? ''
  if (!text.trim()) throw new LlmError('模型返回了空内容', 'bad_response')
  const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
  return {
    text,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
    model,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(finishReason === 'length' ? { truncated: true } : {}),
  }
}

/**
 * 读 Responses 的返回体。
 *
 * 两种形状都要认：
 * - SDK 风格：顶层 `output_text` 直接是字符串；
 * - 原始风格：`output[]` 里每一项的 `content[]` 里是 `{type:'output_text', text}`。
 *
 * 空 `output` 数组是「模型没产出」，不是协议错 —— 这两件事的下一步不同：
 * 前者该改提示词或放宽上限，后者该改配置。
 */
function readResponsesBody(parsed: Record<string, unknown>, model: string): LlmResponse {
  const direct = parsed.output_text
  let text = typeof direct === 'string' ? direct : ''

  if (text.trim() === '' && Array.isArray(parsed.output)) {
    const pieces: string[] = []
    for (const item of parsed.output) {
      const content = (item as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const chunk = part as { type?: string; text?: string }
        if (typeof chunk.text === 'string' && (chunk.type === 'output_text' || chunk.type === undefined)) {
          pieces.push(chunk.text)
        }
      }
    }
    text = pieces.join('')
  }

  // 连 output 都没有 → 这不是 Responses 返回体，说明配置指错了地方。
  if (text === '' && !Array.isArray(parsed.output)) {
    throw new LlmError(
      '模型响应里既没有 output_text 也没有 output 数组：这个地址可能不是 Responses 接口；' +
        '如果它实现的是 chat/completions，请把协议改成 chat',
      'bad_response',
    )
  }
  if (text.trim() === '') throw new LlmError('模型返回了空内容', 'bad_response')

  const usage = parsed.usage as
    | { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
    | undefined
  const status = parsed.status
  const incomplete = parsed.incomplete_details as { reason?: string } | undefined
  const truncated = status === 'incomplete' && (incomplete?.reason === 'max_output_tokens' || incomplete?.reason === 'length')

  return {
    text,
    inputTokens: usage?.input_tokens ?? usage?.prompt_tokens,
    outputTokens: usage?.output_tokens ?? usage?.completion_tokens,
    model,
    ...(typeof status === 'string' ? { finishReason: status === 'incomplete' ? (incomplete?.reason ?? 'incomplete') : status } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}

/** Map an HTTP failure from the model endpoint onto an {@link LlmError}. */
function classifyHttpFailure(status: number, body: string): LlmError {
  const snippet = body.slice(0, 200)
  // ## 401/403 are their own code (v0.2.27)
  //
  // They used to be `unavailable`, which is in the retryable set. Retrying a rejected key
  // cannot succeed — it spends three requests and three waits to reach the same 401 — and
  // the diagnostic panel then reported "unavailable", which reads like a network problem
  // rather than "your key is wrong".
  if (status === 401 || status === 403) {
    return new LlmError(`模型接口鉴权失败（${status}）：${snippet}`, 'unauthorized', { status })
  }
  if (status === 402) return new LlmError(`模型接口额度不足（402）：${snippet}`, 'quota', { status })
  if (status === 429) return new LlmError(`模型接口限流（429）：${snippet}`, 'rate_limited', { status })
  if (status === 413 || /context|too long|maximum/i.test(snippet)) {
    return new LlmError(`上下文超出模型限制（${status}）：${snippet}`, 'context_too_long', { status })
  }
  if (status >= 500) return new LlmError(`模型接口内部错误（${status}）：${snippet}`, 'unavailable', { status })
  return new LlmError(`模型接口返回 ${status}：${snippet}`, 'unknown', { status })
}

/**
 * A deterministic client for tests.
 *
 * It returns whatever the test queued, and records the requests it received so
 * a test can assert on the prompt rather than only on the output.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly label = 'scripted'
  readonly requests: LlmRequest[] = []
  private readonly queue: (LlmResponse | Error)[]

  constructor(responses: readonly (LlmResponse | Error)[]) {
    this.queue = [...responses]
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (!next) throw new LlmError('测试用模型没有更多响应', 'unavailable')
    if (next instanceof Error) throw next
    return next
  }
}
