/**
 * Context compression under an explicit token budget.
 *
 * The constraint that shapes this module: a small model gets ~2000 tokens for
 * the whole task, so "paste the thread" is not an option and neither is a
 * summarizer that drops the one line that matters. Instead every piece of
 * context has a **priority**, the budget is spent top-down, and each item is
 * either included whole or replaced by a marked truncation — never silently
 * dropped, so the generator can say "I don't have that" instead of inventing it.
 */
import type { Dispute } from './analyzer.js';
import type { CollectedThread } from './collector.js';
import type { PersonaConfig } from './persona.js';
/**
 * Rough token accounting for mixed Chinese/ASCII text.
 *
 * Chinese characters cost roughly one token each in modern tokenizers while
 * ASCII costs about a quarter; over-estimating is the safe direction, because
 * exceeding the window fails the whole call while under-using it merely wastes
 * headroom.
 */
export declare function estimateTokens(text: string): number;
/** Names of the context slots, highest priority first. */
export type ContextSlot = 'trigger' | 'opponentLatest' | 'disputeChain' | 'ownerClaims' | 'threadMeta' | 'background';
/** One assembled piece of prompt context. */
export interface ContextChunk {
    readonly slot: ContextSlot;
    readonly label: string;
    readonly text: string;
    readonly tokens: number;
}
/** The compressed context plus a full account of what was cut. */
export interface CompressedContext {
    readonly chunks: readonly ContextChunk[];
    /** Rendered prompt text. */
    readonly text: string;
    /** Tokens the quoted context actually uses. */
    readonly tokens: number;
    /** The slice of the total budget available to the quoted context. */
    readonly budget: number;
    /** The whole request's budget, including fixed costs. */
    readonly totalBudget: number;
    /** What the request costs outside the quoted context. */
    readonly fixedCosts: FixedCosts;
    /** Slots that were dropped or shortened, with the reason. */
    readonly omissions: readonly string[];
}
/** A token budget preset. */
export interface ContextBudget {
    /**
     * Total tokens for the **whole request**, not just the quoted thread.
     *
     * The old accounting counted only the compressed thread text, so a "2000 token"
     * context really meant 2000 + the system prompt + the persona + the reply +
     * the JSON scaffolding — which is how a small model blows its window while the
     * report says "736/2000".
     */
    readonly tokens: number;
    /** Max characters quoted from any single statement. */
    readonly quoteLimit: number;
}
/** Preset budgets for common model sizes. */
export declare const BUDGET_PRESETS: Readonly<Record<'small' | 'medium' | 'large', ContextBudget>>;
/**
 * Tokens the request spends outside the quoted context.
 *
 * These are measured, not guessed: the generator builds its system prompt from
 * constants, the persona block from the configured parameters, and asks for a
 * fixed-shape JSON object, so their cost is stable enough to reserve up front.
 */
export interface FixedCosts {
    /** The generator's system prompt. */
    readonly systemPrompt: number;
    /** Persona instructions embedded in the user message. */
    readonly persona: number;
    /** The structural wrapper around the quoted context. */
    readonly scaffold: number;
    /** The model's own answer, reserved so it is not truncated. */
    readonly reply: number;
}
/**
 * Fixed-cost defaults, matching what the generator actually sends.
 *
 * `systemPrompt` is measured from `SYSTEM_PROMPT` by a test, which fails if the
 * prompt grows past this reservation. Keep them in step rather than guessing.
 */
export declare const FIXED_COSTS: FixedCosts;
/** Sum of the non-context costs. */
export declare function fixedCostTotal(costs?: FixedCosts): number;
/** The token split for one request. */
export interface BudgetBreakdown {
    /** Tokens available for quoted context after fixed costs. */
    readonly contextTokens: number;
    readonly fixed: FixedCosts;
    readonly total: number;
}
/**
 * Split a total budget into "what the thread may use" and "what the request
 * always costs", so the reported usage describes the real request.
 *
 * If the fixed costs alone exceed the total, context gets a floor rather than a
 * negative number: the call will still be attempted, but the report says the
 * budget is too small for this model.
 */
export declare function splitBudget(tokens: number, costs?: FixedCosts): BudgetBreakdown;
/** Resolve a preset name or an explicit token count. */
export declare function resolveBudget(input: {
    preset?: 'small' | 'medium' | 'large';
    tokens?: number;
    quoteLimit?: number;
}): ContextBudget;
/** Truncate text to a character limit with a visible marker. */
export declare function clampText(text: string, limit: number): string;
/**
 * Assemble context for one reply under a hard budget.
 *
 * Priority order is fixed and deliberate: the trigger and the opponent's latest
 * line are what the reply must answer, so they are never the ones cut. Thread
 * background is the cheapest to lose and goes last.
 *
 * @param input dispute, collection, personas and budget
 * @returns chunks in priority order plus a list of what was omitted
 */
export declare function compressContext(input: {
    collected: CollectedThread;
    dispute: Dispute;
    trigger: {
        postId: string;
        content?: string;
    };
    persona: PersonaConfig;
    budget: ContextBudget;
    /** The whole request's budget, when the caller already split it. */
    totalTokens?: number;
    /** Extra instruction the owner typed when summoning. */
    ownerInstruction?: string;
}): CompressedContext;
//# sourceMappingURL=compressor.d.ts.map