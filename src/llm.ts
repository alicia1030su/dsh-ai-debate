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

    const messages: LlmMessage[] = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    messages.push(...request.messages)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: request.temperature ?? 0.8,
          max_tokens: request.maxTokens ?? 900,
        }),
        signal: controller.signal,
      })

      const raw = await response.text()
      if (!response.ok) throw classifyHttpFailure(response.status, raw)

      let parsed: {
        choices?: { message?: { content?: string }; finish_reason?: string }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new LlmError(`模型返回了非 JSON 内容：${raw.slice(0, 160)}`, 'bad_response')
      }

      // A 200 with no `choices` is a response the caller cannot use, and saying "empty
      // content" hides that the *shape* was wrong — which is the difference between "the
      // model had nothing to say" and "this endpoint is not a chat-completions API".
      if (!Array.isArray(parsed.choices)) {
        throw new LlmError(
          '模型响应缺少 choices 字段：这个地址可能不是 chat/completions 接口，或协议不兼容',
          'bad_response',
        )
      }

      const choice = parsed.choices[0]
      const text = choice?.message?.content ?? ''
      if (!text.trim()) throw new LlmError('模型返回了空内容', 'bad_response')

      // `finish_reason: 'length'` means the provider stopped at the token cap. The bytes we
      // got are real, and half a sentence can still parse as a plausible reply — which is
      // exactly why this must be reported rather than left for the content check to guess.
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
      return {
        text,
        inputTokens: parsed.usage?.prompt_tokens,
        outputTokens: parsed.usage?.completion_tokens,
        model,
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(finishReason === 'length' ? { truncated: true } : {}),
      }
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
