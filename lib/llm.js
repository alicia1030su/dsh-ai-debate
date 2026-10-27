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
    async complete(request) {
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
            const text = parsed.choices?.[0]?.message?.content ?? '';
            if (!text.trim())
                throw new LlmError('模型返回了空内容', 'bad_response');
            return {
                text,
                inputTokens: parsed.usage?.prompt_tokens,
                outputTokens: parsed.usage?.completion_tokens,
                model,
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
    if (status === 401 || status === 403)
        return new LlmError(`模型接口鉴权失败（${status}）：${snippet}`, 'unavailable', { status });
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