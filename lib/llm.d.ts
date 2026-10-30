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
}
/** A classified LLM failure. */
export type LlmErrorCode = 'unavailable' | 'timeout' | 'rate_limited' | 'quota' | 'bad_response' | 'context_too_long' | 'cancelled' | 'unknown';
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
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
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
    complete(request: LlmRequest): Promise<LlmResponse>;
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