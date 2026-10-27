/**
 * Plugin configuration schema.
 *
 * Uses `@deepseek-ai/schemastery` because that is what the Host's Settings
 * surface understands, and marks every field `.volatile()` so an edit takes
 * effect without remounting the plugin. Secrets carry `role('secret')` so the
 * Harness redacts them anywhere they would otherwise be echoed.
 */
import z from '@deepseek-ai/schemastery';
/** The plugin's configuration. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** Master switch. */
    enabled: z<boolean, boolean, "volatile-defined">;
    /** The owner's stable Tieba user id. Preferred over the name. */
    ownerUserId: z<string, string, "volatile-defined">;
    /** The owner's Tieba username, used only when no id is configured. */
    ownerUserName: z<string, string, "volatile-defined">;
    /** The AI account's display name, for the summon hint. */
    aiAccountName: z<string, string, "volatile-defined">;
    /** The AI account's user id, when known. */
    aiAccountUserId: z<string, string, "volatile-defined">;
    /** Extra owner ids allowed to summon, comma separated. */
    allowedOwnerIds: z<string, string, "volatile-defined">;
    /** A Tieba cookie header copied from a logged-in browser. Never logged. */
    tiebaCookie: z<string, string, "volatile-defined">;
    /** Default persona style. */
    personaStyle: z<"tieba_veteran" | "soft_defensive" | "tsundere" | "aloof", "tieba_veteran" | "soft_defensive" | "tsundere" | "aloof", "volatile-defined">;
    /** 1 (mild) to 5 (sharp). */
    intensity: z<number, number, "volatile-defined">;
    /** Maximum reply length in Chinese characters. */
    maxLength: z<number, number, "volatile-defined">;
    /** Emoji usage, 0 to 3. */
    emojiLevel: z<number, number, "volatile-defined">;
    /** Sarcasm, 0 to 3. */
    sarcasmLevel: z<number, number, "volatile-defined">;
    /** Directness, 1 to 5. */
    directness: z<number, number, "volatile-defined">;
    /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1. */
    llmBaseUrl: z<string, string, "volatile-defined">;
    /** API key for that endpoint. Never logged. */
    llmApiKey: z<string, string, "volatile-defined">;
    /** Model name. */
    llmModel: z<string, string, "volatile-defined">;
    /** Per-request timeout. */
    llmTimeoutMs: z<number, number, "volatile-defined">;
    /**
     * Sampling temperature.
     *
     * Low by default: this task is precision, not creativity. Raise it only if the
     * drafts read too stiffly and the model still returns valid JSON.
     */
    llmTemperature: z<number, number, "volatile-defined">;
    /** Cap on the model's own answer; 0 leaves the size to the persona length. */
    llmMaxOutputTokens: z<number, number, "volatile-defined">;
    /** Budget preset for the model's context. */
    contextPreset: z<"small" | "medium" | "large", "small" | "medium" | "large", "volatile-defined">;
    /** Explicit token budget; overrides the preset when > 0. */
    contextTokens: z<number, number, "volatile-defined">;
    /** How much the plugin may do without a human click. */
    interactionMode: z<"manual" | "single_shot" | "limited_auto", "manual" | "single_shot" | "limited_auto", "volatile-defined">;
    /** Automatic publishes allowed per session. */
    maxAutoPerSession: z<number, number, "volatile-defined">;
    /** Cooldown between automatic publishes, in seconds. */
    cooldownSeconds: z<number, number, "volatile-defined">;
    /** Maximum publishes in one thread. */
    maxPerThread: z<number, number, "volatile-defined">;
    /** Maximum floor pages read per thread. */
    maxFloorPages: z<number, number, "volatile-defined">;
    /** Pause between page requests, in milliseconds. */
    pageDelayMs: z<number, number, "volatile-defined">;
    /** HTTP timeout for platform requests. */
    requestTimeoutMs: z<number, number, "volatile-defined">;
    /** Extra attempts on transport failures. */
    requestRetries: z<number, number, "volatile-defined">;
    /** Override the store directory; empty means the profile default. */
    storeDir: z<string, string, "volatile-defined">;
    /** Session retention in days. */
    sessionTtlDays: z<number, number, "volatile-defined">;
    /** When true, a system-prompt section tells the agent the tools exist. */
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    /** Log verbosity. */
    logLevel: z<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn", "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Master switch. */
    enabled: z<boolean, boolean, "volatile-defined">;
    /** The owner's stable Tieba user id. Preferred over the name. */
    ownerUserId: z<string, string, "volatile-defined">;
    /** The owner's Tieba username, used only when no id is configured. */
    ownerUserName: z<string, string, "volatile-defined">;
    /** The AI account's display name, for the summon hint. */
    aiAccountName: z<string, string, "volatile-defined">;
    /** The AI account's user id, when known. */
    aiAccountUserId: z<string, string, "volatile-defined">;
    /** Extra owner ids allowed to summon, comma separated. */
    allowedOwnerIds: z<string, string, "volatile-defined">;
    /** A Tieba cookie header copied from a logged-in browser. Never logged. */
    tiebaCookie: z<string, string, "volatile-defined">;
    /** Default persona style. */
    personaStyle: z<"tieba_veteran" | "soft_defensive" | "tsundere" | "aloof", "tieba_veteran" | "soft_defensive" | "tsundere" | "aloof", "volatile-defined">;
    /** 1 (mild) to 5 (sharp). */
    intensity: z<number, number, "volatile-defined">;
    /** Maximum reply length in Chinese characters. */
    maxLength: z<number, number, "volatile-defined">;
    /** Emoji usage, 0 to 3. */
    emojiLevel: z<number, number, "volatile-defined">;
    /** Sarcasm, 0 to 3. */
    sarcasmLevel: z<number, number, "volatile-defined">;
    /** Directness, 1 to 5. */
    directness: z<number, number, "volatile-defined">;
    /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1. */
    llmBaseUrl: z<string, string, "volatile-defined">;
    /** API key for that endpoint. Never logged. */
    llmApiKey: z<string, string, "volatile-defined">;
    /** Model name. */
    llmModel: z<string, string, "volatile-defined">;
    /** Per-request timeout. */
    llmTimeoutMs: z<number, number, "volatile-defined">;
    /**
     * Sampling temperature.
     *
     * Low by default: this task is precision, not creativity. Raise it only if the
     * drafts read too stiffly and the model still returns valid JSON.
     */
    llmTemperature: z<number, number, "volatile-defined">;
    /** Cap on the model's own answer; 0 leaves the size to the persona length. */
    llmMaxOutputTokens: z<number, number, "volatile-defined">;
    /** Budget preset for the model's context. */
    contextPreset: z<"small" | "medium" | "large", "small" | "medium" | "large", "volatile-defined">;
    /** Explicit token budget; overrides the preset when > 0. */
    contextTokens: z<number, number, "volatile-defined">;
    /** How much the plugin may do without a human click. */
    interactionMode: z<"manual" | "single_shot" | "limited_auto", "manual" | "single_shot" | "limited_auto", "volatile-defined">;
    /** Automatic publishes allowed per session. */
    maxAutoPerSession: z<number, number, "volatile-defined">;
    /** Cooldown between automatic publishes, in seconds. */
    cooldownSeconds: z<number, number, "volatile-defined">;
    /** Maximum publishes in one thread. */
    maxPerThread: z<number, number, "volatile-defined">;
    /** Maximum floor pages read per thread. */
    maxFloorPages: z<number, number, "volatile-defined">;
    /** Pause between page requests, in milliseconds. */
    pageDelayMs: z<number, number, "volatile-defined">;
    /** HTTP timeout for platform requests. */
    requestTimeoutMs: z<number, number, "volatile-defined">;
    /** Extra attempts on transport failures. */
    requestRetries: z<number, number, "volatile-defined">;
    /** Override the store directory; empty means the profile default. */
    storeDir: z<string, string, "volatile-defined">;
    /** Session retention in days. */
    sessionTtlDays: z<number, number, "volatile-defined">;
    /** When true, a system-prompt section tells the agent the tools exist. */
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    /** Log verbosity. */
    logLevel: z<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn", "volatile-defined">;
}>>, "plain">;
/** Defaults mirroring the schema, for hand-built test contexts. */
export declare const DEFAULT_CONFIG: {
    enabled: boolean;
    ownerUserId: string;
    ownerUserName: string;
    aiAccountName: string;
    aiAccountUserId: string;
    allowedOwnerIds: string;
    tiebaCookie: string;
    personaStyle: "tieba_veteran";
    intensity: number;
    maxLength: number;
    emojiLevel: number;
    sarcasmLevel: number;
    directness: number;
    llmBaseUrl: string;
    llmApiKey: string;
    llmModel: string;
    llmTimeoutMs: number;
    llmTemperature: number;
    llmMaxOutputTokens: number;
    contextPreset: "small";
    contextTokens: number;
    interactionMode: "manual";
    maxAutoPerSession: number;
    cooldownSeconds: number;
    maxPerThread: number;
    maxFloorPages: number;
    pageDelayMs: number;
    requestTimeoutMs: number;
    requestRetries: number;
    storeDir: string;
    sessionTtlDays: number;
    announceToAgent: boolean;
    logLevel: "info";
};
/** The resolved configuration shape. */
export type ResolvedConfig = typeof DEFAULT_CONFIG;
/** Normalize a raw config against the defaults. */
export declare function resolveConfig(input: unknown): ResolvedConfig;
/** Split a comma-separated id list, dropping blanks. */
export declare function splitIds(raw: string): readonly string[];
//# sourceMappingURL=config.d.ts.map