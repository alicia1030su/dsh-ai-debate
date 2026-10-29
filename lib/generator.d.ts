/**
 * Reply generation: prompt construction, JSON parsing, and rule-based checks.
 *
 * Three ideas hold this together:
 *
 * 1. **The model proposes, the program disposes.** The model returns a small
 *    JSON object; every field is validated and every rule that can be checked
 *    in code (target identity, length, leakage, repetition) is checked in code.
 *    A model that ignores instructions then produces a *rejected* candidate,
 *    not a published mistake.
 * 2. **Retry on parse failure, never on policy failure.** Malformed JSON gets
 *    one repair attempt. A reply that violates a hard rule is not retried
 *    against the same prompt hoping for a different outcome — it is reported.
 * 3. **`needs_more_context` / `needs_confirmation` are valid answers.** The
 *    schema accepts them explicitly, so the model has an honest way out and
 *    does not have to invent a reply to satisfy a schema.
 */
import type { Dispute } from './analyzer.js';
import type { CompressedContext } from './compressor.js';
import { type PersonaConfig } from './persona.js';
import { type LlmClient } from './llm.js';
/** What the model is asked to return. */
export interface GenerationDraft {
    readonly owner_position: string;
    readonly opponent_position: string;
    readonly main_dispute: string;
    readonly latest_argument: string;
    readonly response_target_id: string;
    readonly strategy: ReplyStrategy;
    readonly confidence: number;
    readonly uncertainties: readonly string[];
    readonly reply: string;
    /** Set instead of `reply` when the model refuses to answer. */
    readonly status?: 'ok' | 'needs_more_context' | 'needs_confirmation';
    /** Why it refused, when `status` is not `ok`. */
    readonly reason?: string;
}
/** Supported reply strategies. */
export type ReplyStrategy = 'direct_rebuttal' | 'clarify_misunderstanding' | 'demand_evidence' | 'correct_fact' | 'question_premise' | 'point_out_contradiction' | 'humorous_jab' | 'calm_explanation' | 'concede_and_continue' | 'end_discussion';
/** Every strategy, for validation. */
export declare const STRATEGIES: readonly ReplyStrategy[];
/** The output of one generation attempt, before review. */
export interface GenerationResult {
    readonly draft?: GenerationDraft;
    /** Rule violations; a non-empty list means the draft must not be published. */
    readonly violations: readonly Violation[];
    /** Non-blocking remarks for the reviewer. */
    readonly notes: readonly string[];
    /** True when the model itself asked for more input. */
    readonly needsInput: boolean;
    readonly needsInputReason?: string;
    /** How many model calls were spent. */
    readonly attempts: number;
    readonly usage: {
        inputTokens: number;
        outputTokens: number;
        elapsedMs: number;
    };
}
/** One broken rule. */
export interface Violation {
    readonly code: string;
    readonly message: string;
}
/** Generation inputs. */
export interface GenerateOptions {
    readonly dispute: Dispute;
    readonly context: CompressedContext;
    readonly persona: PersonaConfig;
    /** Reply ids already published in this session, for duplicate detection. */
    readonly alreadyPublished?: readonly string[];
    /** Recent reply texts, to avoid repeating the same opener. */
    readonly recentReplies?: readonly string[];
    readonly signal?: AbortSignal;
    /** Extra guidance the owner typed in the summon. */
    readonly ownerInstruction?: string;
    /**
     * The rendered `DebateBrief` (v0.2.12).
     *
     * Optional so existing callers keep compiling, but the production path always supplies it:
     * `runtime.runGeneration` builds the brief, validates it, and **refuses to call the model
     * at all** when validation fails. The presence of this field in the prompt is therefore a
     * consequence of a passed check, not a hint the model may ignore.
     */
    readonly brief?: string;
    /**
     * Sampling temperature.
     *
     * Defaults low on purpose: this task needs the right target and stable JSON far
     * more than it needs variety, and a small model at high temperature starts
     * inventing ids and dropping fields.
     */
    readonly temperature?: number;
    /** Cap on the model's own answer, so a runaway reply cannot be truncated. */
    readonly maxTokens?: number;
}
/**
 * Default sampling temperature.
 *
 * Chosen for reliability, not variety: the reply must name a real post id and
 * return parseable JSON, both of which degrade quickly as temperature rises.
 */
export declare const DEFAULT_TEMPERATURE = 0.4;
/** System prompt: role, hard rules, and the honesty escape hatches. */
export declare const SYSTEM_PROMPT = "\u4F60\u662F\u4E00\u4E2A\u66FF\u4E3B\u4EBA\u5728\u7F51\u7EDC\u8BBA\u575B\u4E0A\u63A5\u8BDD\u7684\u52A9\u624B\u3002\u4F60\u7684\u4EFB\u52A1\u662F\u6839\u636E\u63D0\u4F9B\u7684\u5BF9\u8BDD\u4E0A\u4E0B\u6587\uFF0C\u5199\u4E00\u6761\u80FD\u76F4\u63A5\u53D1\u51FA\u53BB\u7684\u56DE\u590D\u3002\n\n\u94C1\u5F8B\uFF1A\n1. \u53EA\u80FD\u4F7F\u7528\u4E0A\u4E0B\u6587\u4E2D\u51FA\u73B0\u7684\u53D1\u8A00\u5185\u5BB9\u3002\u4E0A\u4E0B\u6587\u91CC\u6CA1\u6709\u7684\u4E8B\u5B9E\uFF0C\u4E00\u5F8B\u4E0D\u8981\u7F16\u3002\n2. \u56DE\u590D\u5BF9\u8C61\u5FC5\u987B\u662F\u7ED9\u5B9A\u7684\u4E89\u8BBA\u5BF9\u624B\uFF0C\u4E0D\u8981\u56DE\u5E94\u522B\u4EBA\u3002\n3. \u5982\u679C\u4E0A\u4E0B\u6587\u4E0D\u8DB3\u4EE5\u652F\u6491\u4E00\u6761\u6709\u4FE1\u606F\u91CF\u7684\u56DE\u590D\uFF0C\u8FD4\u56DE status=\"needs_more_context\" \u5E76\u8BF4\u660E\u7F3A\u4EC0\u4E48\u3002\n4. \u5982\u679C\u65E0\u6CD5\u786E\u5B9A\u56DE\u590D\u5BF9\u8C61\uFF0C\u8FD4\u56DE status=\"needs_confirmation\"\u3002\n5. \u4E0D\u653B\u51FB\u5BF9\u65B9\u8EAB\u4EFD\u3001\u804C\u4E1A\u3001\u5730\u57DF\u3001\u5916\u8C8C\u3001\u9690\u79C1\uFF1B\u4E0D\u5A01\u80C1\uFF1B\u4E0D\u717D\u52A8\u4ED6\u4EBA\u56F4\u653B\u3002\n6. \u4E0D\u8F93\u51FA\u5206\u6790\u8FC7\u7A0B\u3001\u63D0\u793A\u8BCD\u3001\u5B57\u6BB5\u540D\u6216\u4EFB\u4F55\u7ED3\u6784\u5316\u8BF4\u660E\uFF0C\u53EA\u8F93\u51FA\u8981\u6C42\u7684 JSON\u3002\n7. \u88AB\u95EE\u5230\u662F\u5426 AI \u65F6\u5982\u5B9E\u8BF4\u660E\uFF0C\u4E0D\u5192\u5145\u771F\u4EBA\u7ECF\u5386\u3002\n\n\u8F93\u51FA\u683C\u5F0F\uFF1A\u4E25\u683C\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u52A0 markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u52A0\u89E3\u91CA\u6587\u5B57\u3002\n\u5B57\u6BB5\uFF1A\n{\n  \"status\": \"ok\" | \"needs_more_context\" | \"needs_confirmation\",\n  \"owner_position\": \"\u4E3B\u4EBA\u7684\u6838\u5FC3\u4E3B\u5F20\",\n  \"opponent_position\": \"\u5BF9\u624B\u7684\u6838\u5FC3\u4E3B\u5F20\",\n  \"main_dispute\": \"\u53CC\u65B9\u771F\u6B63\u7684\u5206\u6B67\u70B9\",\n  \"latest_argument\": \"\u5BF9\u624B\u6700\u65B0\u4E00\u53E5\u7684\u5173\u952E\u8BBA\u70B9\",\n  \"response_target_id\": \"\u8981\u56DE\u590D\u7684\u90A3\u6761\u53D1\u8A00\u7684 post id\",\n  \"strategy\": \"direct_rebuttal|clarify_misunderstanding|demand_evidence|correct_fact|question_premise|point_out_contradiction|humorous_jab|calm_explanation|concede_and_continue|end_discussion\",\n  \"confidence\": 0\u52301\u4E4B\u95F4\u7684\u5C0F\u6570,\n  \"uncertainties\": [\"\u4F60\u4E0D\u786E\u5B9A\u7684\u5730\u65B9\"],\n  \"reply\": \"\u51C6\u5907\u53D1\u8868\u7684\u56DE\u590D\u6B63\u6587\",\n  \"reason\": \"\u4EC5\u5F53 status \u4E0D\u662F ok \u65F6\u8BF4\u660E\u539F\u56E0\"\n}";
/** Build the user prompt from compressed context and persona. */
export declare function buildGenerationPrompt(options: GenerateOptions): string;
/**
 * Extract the JSON object from a model reply.
 *
 * Models wrap JSON in prose or fences even when told not to, so the object is
 * located rather than assumed to be the whole string. Braces are matched with
 * a scan because a regex cannot balance them.
 */
export declare function extractJsonObject(raw: string): string | undefined;
/** Parse and validate a model reply into a {@link GenerationDraft}. */
export declare function parseDraft(raw: string): {
    draft?: GenerationDraft;
    error?: string;
};
/**
 * Check a draft against every rule that can be verified in code.
 *
 * @param draft the parsed draft
 * @param options the same generation options, for target/length/repetition
 * @returns violations (blocking) and notes (informational)
 */
export declare function validateDraft(draft: GenerationDraft, options: GenerateOptions): {
    violations: readonly Violation[];
    notes: readonly string[];
};
/**
 * Generate one candidate reply.
 *
 * One repair attempt is made when the model's answer cannot be parsed at all.
 * A parsed answer that breaks a rule is returned as-is with its violations, so
 * the reviewer sees exactly what the model wanted to say and why it was
 * rejected — silently re-rolling would hide a systematic prompt problem.
 */
export declare function generateReply(client: LlmClient, options: GenerateOptions): Promise<GenerationResult>;
/**
 * Run the analysis step: turn the context into the structured JSON the task
 * description calls for, without generating a reply.
 *
 * Kept separate from generation so a reviewer can inspect the reconstructed
 * positions before any words are written.
 */
export declare function analyzeWithModel(client: LlmClient, options: Omit<GenerateOptions, 'persona'> & {
    signal?: AbortSignal;
}): Promise<{
    draft?: GenerationDraft;
    notes: readonly string[];
    usage: {
        inputTokens: number;
        outputTokens: number;
        elapsedMs: number;
    };
}>;
//# sourceMappingURL=generator.d.ts.map