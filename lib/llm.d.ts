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
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
}
/** A request for one completion. */
export interface LlmRequest {
    readonly messages: readonly LlmMessage[];
    readonly system?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly signal?: AbortSignal;
}
/** The result of one completion. */
export interface LlmResponse {
    readonly text: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /** Provider/model label, for the usage log. */
    readonly model?: string;
    /**
     * Why generation stopped, when the provider said so (`finish_reason`).
     *
     * `length` is the one that matters: the answer was cut off at `max_tokens`. The text is
     * still real, but it is *incomplete*, and treating it as a finished reply is how a
     * truncated sentence reaches a publish button. Kept as the provider's own word rather
     * than collapsed into a boolean, so a future provider-specific reason is not lost.
     */
    readonly finishReason?: string;
    /**
     * True when the provider reported that generation stopped because it hit the token cap.
     *
     * Derived here, in the transport, because it is a fact about the response, not an opinion
     * about the text: no content check can distinguish "short answer" from "answer cut in
     * half".
     */
    readonly truncated?: boolean;
    /** How many attempts the client made before returning this, when retrying is enabled. */
    readonly attempts?: number;
}
/** A classified LLM failure. */
export type LlmErrorCode = 'unavailable' | 'unauthorized' | 'timeout' | 'rate_limited' | 'quota' | 'bad_response' | 'truncated' | 'context_too_long' | 'cancelled' | 'unknown';
/** An error from the LLM layer, with a code the caller can act on. */
export declare class LlmError extends Error {
    readonly code: LlmErrorCode;
    readonly status?: number;
    constructor(message: string, code: LlmErrorCode, options?: {
        status?: number;
        cause?: unknown;
    });
}
/** The one method the rest of the plugin uses. */
export interface LlmClient {
    /** Short label used in logs and health reports. */
    readonly label: string;
    /** Run one completion. Throws {@link LlmError} on failure. */
    complete(request: LlmRequest): Promise<LlmResponse>;
}
/** Options for the OpenAI-compatible client. */
export interface OpenAiClientOptions {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
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
    readonly protocol?: 'chat' | 'responses';
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
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
    readonly maxRetries?: number;
    /** Base delay for exponential backoff, in ms. Injected so tests do not wait. */
    readonly retryDelayMs?: number;
    /** Called before each retry, for logging. */
    readonly onRetry?: (info: {
        attempt: number;
        code: LlmErrorCode;
        message: string;
    }) => void;
}
/**
 * An OpenAI-compatible chat-completions client.
 *
 * Written against the wire format directly instead of pulling in an SDK: the
 * whole protocol used here is one POST with a JSON body, and a dependency for
 * that would be more surface area than code.
 */
export declare class OpenAiCompatibleClient implements LlmClient {
    readonly label: string;
    private readonly options;
    private readonly fetchImpl;
    constructor(options: OpenAiClientOptions);
    /**
     * Run one completion, retrying only failures that provably did not take effect.
     *
     * The loop is deliberately outside `completeOnce`, so a single attempt stays a single
     * request: nothing here re-sends half a stream or reuses an aborted controller.
     */
    complete(request: LlmRequest): Promise<LlmResponse>;
    /** One request, one response. No retry, no shared state. */
    private completeOnce;
}
/**
 * A deterministic client for tests.
 *
 * It returns whatever the test queued, and records the requests it received so
 * a test can assert on the prompt rather than only on the output.
 */
export declare class ScriptedLlmClient implements LlmClient {
    readonly label = "scripted";
    readonly requests: LlmRequest[];
    private readonly queue;
    constructor(responses: readonly (LlmResponse | Error)[]);
    complete(request: LlmRequest): Promise<LlmResponse>;
}
//# sourceMappingURL=llm.d.ts.map