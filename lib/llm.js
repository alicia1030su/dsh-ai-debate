/**
 * The LLM boundary: one narrow interface, two implementations.
 *
 * Analysis and generation need "give me JSON back for this prompt". They do
 * not need to know whether the answer came from the Harness's own model
 * service or from a user-configured OpenAI-compatible endpoint. Keeping that
 * behind one interface is what makes the plugin testable without a network and
 * portable across Harness versions.
 */
/** An error from the LLM layer, with a code the caller can act on. */
export class LlmError extends Error {
    code;
    status;
    constructor(message, code, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'LlmError';
        this.code = code;
        this.status = options.status;
    }
}
/** Failures that did not take effect and are worth one more attempt. */
const RETRYABLE = new Set(['unavailable', 'timeout', 'rate_limited']);
/**
 * Wait before a retry, bailing out if the caller cancels.
 *
 * A backoff timer that ignores cancellation keeps a closed page's request alive and, worse,
 * fires one more model call after the owner has already moved on.
 */
function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new LlmError('生成被取消', 'cancelled'));
        };
        if (signal?.aborted === true) {
            clearTimeout(timer);
            reject(new LlmError('生成被取消', 'cancelled'));
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * An OpenAI-compatible chat-completions client.
 *
 * Written against the wire format directly instead of pulling in an SDK: the
 * whole protocol used here is one POST with a JSON body, and a dependency for
 * that would be more surface area than code.
 */
export class OpenAiCompatibleClient {
    label;
    options;
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.label = `openai-compatible:${options.model}`;
    }
    /**
     * Run one completion, retrying only failures that provably did not take effect.
     *
     * The loop is deliberately outside `completeOnce`, so a single attempt stays a single
     * request: nothing here re-sends half a stream or reuses an aborted controller.
     */
    async complete(request) {
        const maxRetries = Math.max(0, this.options.maxRetries ?? 0);
        const baseDelay = this.options.retryDelayMs ?? 500;
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            try {
                const response = await this.completeOnce(request);
                return attempt === 0 ? response : { ...response, attempts: attempt + 1 };
            }
            catch (error) {
                const failure = error instanceof LlmError
                    ? error
                    : new LlmError(`模型接口请求失败：${String(error)}`, 'unavailable', { cause: error });
                lastError = failure;
                // Cancellation is the caller's decision, and a 401 will not become a 200 by waiting.
                if (!RETRYABLE.has(failure.code) || attempt === maxRetries)
                    throw failure;
                // A cancelled caller must not be kept alive by a backoff timer.
                if (request.signal?.aborted === true)
                    throw failure;
                this.options.onRetry?.({
                    attempt: attempt + 1,
                    code: failure.code,
                    message: failure.message,
                });
                await sleep(baseDelay * 2 ** attempt, request.signal);
            }
        }
        // Unreachable: the loop either returns or throws.
        throw lastError ?? new LlmError('模型接口请求失败', 'unknown');
    }
    /** One request, one response. No retry, no shared state. */
    async completeOnce(request) {
        const { baseUrl, apiKey, model, timeoutMs = 120_000 } = this.options;
        if (!baseUrl)
            throw new LlmError('没有配置模型接口地址（baseUrl）', 'unavailable');
        if (!model)
            throw new LlmError('没有配置模型名称（model）', 'unavailable');
        const messages = [];
        if (request.system)
            messages.push({ role: 'system', content: request.system });
        messages.push(...request.messages);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        request.signal?.addEventListener('abort', onAbort, { once: true });
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
            });
            const raw = await response.text();
            if (!response.ok)
                throw classifyHttpFailure(response.status, raw);
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                throw new LlmError(`模型返回了非 JSON 内容：${raw.slice(0, 160)}`, 'bad_response');
            }
            // A 200 with no `choices` is a response the caller cannot use, and saying "empty
            // content" hides that the *shape* was wrong — which is the difference between "the
            // model had nothing to say" and "this endpoint is not a chat-completions API".
            if (!Array.isArray(parsed.choices)) {
                throw new LlmError('模型响应缺少 choices 字段：这个地址可能不是 chat/completions 接口，或协议不兼容', 'bad_response');
            }
            const choice = parsed.choices[0];
            const text = choice?.message?.content ?? '';
            if (!text.trim())
                throw new LlmError('模型返回了空内容', 'bad_response');
            // `finish_reason: 'length'` means the provider stopped at the token cap. The bytes we
            // got are real, and half a sentence can still parse as a plausible reply — which is
            // exactly why this must be reported rather than left for the content check to guess.
            const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
            return {
                text,
                inputTokens: parsed.usage?.prompt_tokens,
                outputTokens: parsed.usage?.completion_tokens,
                model,
                ...(finishReason === undefined ? {} : { finishReason }),
                ...(finishReason === 'length' ? { truncated: true } : {}),
            };
        }
        catch (error) {
            if (error instanceof LlmError)
                throw error;
            const err = error;
            if (err?.name === 'AbortError') {
                throw new LlmError(request.signal?.aborted ? '生成被取消' : '模型接口超时', request.signal?.aborted ? 'cancelled' : 'timeout');
            }
            throw new LlmError(`模型接口请求失败：${err?.message ?? String(error)}`, 'unavailable', { cause: error });
        }
        finally {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
        }
    }
}
/** Map an HTTP failure from the model endpoint onto an {@link LlmError}. */
function classifyHttpFailure(status, body) {
    const snippet = body.slice(0, 200);
    // ## 401/403 are their own code (v0.2.27)
    //
    // They used to be `unavailable`, which is in the retryable set. Retrying a rejected key
    // cannot succeed — it spends three requests and three waits to reach the same 401 — and
    // the diagnostic panel then reported "unavailable", which reads like a network problem
    // rather than "your key is wrong".
    if (status === 401 || status === 403) {
        return new LlmError(`模型接口鉴权失败（${status}）：${snippet}`, 'unauthorized', { status });
    }
    if (status === 402)
        return new LlmError(`模型接口额度不足（402）：${snippet}`, 'quota', { status });
    if (status === 429)
        return new LlmError(`模型接口限流（429）：${snippet}`, 'rate_limited', { status });
    if (status === 413 || /context|too long|maximum/i.test(snippet)) {
        return new LlmError(`上下文超出模型限制（${status}）：${snippet}`, 'context_too_long', { status });
    }
    if (status >= 500)
        return new LlmError(`模型接口内部错误（${status}）：${snippet}`, 'unavailable', { status });
    return new LlmError(`模型接口返回 ${status}：${snippet}`, 'unknown', { status });
}
/**
 * A deterministic client for tests.
 *
 * It returns whatever the test queued, and records the requests it received so
 * a test can assert on the prompt rather than only on the output.
 */
export class ScriptedLlmClient {
    label = 'scripted';
    requests = [];
    queue;
    constructor(responses) {
        this.queue = [...responses];
    }
    async complete(request) {
        this.requests.push(request);
        const next = this.queue.shift();
        if (!next)
            throw new LlmError('测试用模型没有更多响应', 'unavailable');
        if (next instanceof Error)
            throw next;
        return next;
    }
}
//# sourceMappingURL=llm.js.map