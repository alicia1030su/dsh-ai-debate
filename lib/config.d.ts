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
    /**
     * The owner's **numeric** Tieba account id.
     *
     * v0.2.23 keeps the field name so existing profiles keep working, but changes
     * what it is compared against: `authorNumericUid` only. It is no longer
     * compared against `authorId`, because on the WAP surface `authorId` holds a
     * login name — and `348099763 === "银狐_玉耀"` can never be true.
     *
     * A profile that only sets this, reading a thread that exposes no numeric uid,
     * is now told exactly that instead of being told the owner never posted.
     */
    ownerUserId: z<string, string, "volatile-defined">;
    /**
     * The owner's **login name** (`un`), introduced in v0.2.23.
     *
     * This is the field that actually works against a WAP read: the WAP page
     * publishes `un` and nothing numeric. It is separate from `ownerUserName`
     * because a login name is not a nickname — it is the account's own name that
     * the owner cannot change, whereas a nickname can be set to anything by
     * anyone.
     *
     * Leave empty if you do not know it; the plugin will refuse to guess rather
     * than fall back to a nickname.
     */
    ownerHandle: z<string, string, "volatile-defined">;
    /**
     * The owner's Tieba username, used only when neither an id nor a handle is set.
     *
     * A nickname. It can be duplicated and changed, so a match on it is recorded
     * as `display_name_match_only` and never treated as proof of identity.
     */
    ownerUserName: z<string, string, "volatile-defined">;
    /** The AI account's display name, for the summon hint. */
    aiAccountName: z<string, string, "volatile-defined">;
    /** The AI account's user id, when known. */
    aiAccountUserId: z<string, string, "volatile-defined">;
    /** Extra owner ids allowed to summon, comma separated. */
    allowedOwnerIds: z<string, string, "volatile-defined">;
    /**
     * Per-platform account bindings, as JSON.
     *
     * Empty means "derive from the legacy globals above", which keeps existing
     * profiles working unchanged (the globals describe Tieba, which is what they
     * always did). Setting it opts into the platform-scoped model, so a Weibo or
     * Zhihu account can be bound without inventing a second set of global fields.
     *
     * Shape: `{ "owners": [...], "aiAccounts": [...] }` — see
     * `platforms/accounts.ts`. Stored as a string rather than a nested schema
     * because this field is edited by the settings page, and a malformed value must
     * degrade to "unbound" rather than prevent the plugin from mounting.
     */
    platformAccounts: z<string, string, "volatile-defined">;
    /**
     * Master switch for injection protection.
     *
     * Defaults to `true`, and turning it off does **not** disable the deterministic
     * checks (target identity, credential leakage, owner attack) — those are not
     * configurable, because an option to disable them is an option an attacker only
     * has to talk the owner into flipping.
     */
    securityProtection: z<boolean, boolean, "volatile-defined">;
    /**
     * How eagerly text-level injection evidence forces a human review.
     *
     * Only the *semantic* threshold moves. `strict` flags anything at all (use it if
     * the account is being actively targeted), `relaxed` only high and critical.
     */
    securityStrictness: z<"strict" | "standard" | "relaxed", "strict" | "standard" | "relaxed", "volatile-defined">;
    /**
     * How many recent security events to keep for the settings page.
     *
     * Events store a redacted excerpt, never a whole post, so a large number is not
     * a memory risk — but it is also not useful, and a long list makes the important
     * ones harder to see.
     */
    securityEventLimit: z<number, number, "volatile-defined">;
    /** A Tieba cookie header copied from a logged-in browser. Never logged. */
    tiebaCookie: z<string, string, "volatile-defined">;
    /**
     * A thread id used to read the login banner, when no better page is at hand.
     *
     * The adapter asks for a page to read `data_editor` from. Verification passes the thread
     * the owner authorised, so this is only needed for callers that have no thread to name
     * — but the option existed on the adapter with no way to set it, which made the
     * "not configured" case the only case. Blank means "not configured".
     */
    authProbeThreadId: z<string, string, "volatile-defined">;
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
    /**
     * 模型接口的请求形状（v0.2.34 §3.1）。
     *
     * `chat` = `/chat/completions`（读 `choices[0].message.content`）；
     * `responses` = `/responses`（读 `output_text` 或 `output[].content[].text`）。
     *
     * 为什么要人填：同一个 Base URL 上两种协议都可能有，而它们的失败方式不同 ——
     * 协议填错时对方通常返回 200 但结构不对，看起来像「模型没说话」。靠名字猜
     * （例如「gpt-5 大概是 responses」）会在换模型的那天悄悄坏掉。
     */
    llmProtocol: z<"chat" | "responses", "chat" | "responses", "volatile-defined">;
    /** Per-request timeout. */
    llmTimeoutMs: z<number, number, "volatile-defined">;
    /**
     * Extra attempts after a *transient* model failure (v0.2.27).
     *
     * Default 0, matching the transport's own default, because a generation is not free and
     * a timeout may mean the provider is still working. When set, only failures that provably
     * did not take effect are retried — connection errors, timeouts, 429 and 5xx. A rejected
     * key, an exhausted quota, an over-long context and an explicit cancellation are never
     * retried: repeating them produces the same answer and spends the budget twice.
     */
    llmRetries: z<number, number, "volatile-defined">;
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
    /**
     * How much the plugin may do without a human click.
     *
     * ## v0.2.21 §二：三个模式都不再决定「要不要人工批准」
     *
     * 真实发表一律需要**该候选**的人工批准记录（见 `safety.ts` 的 `checkPublishPolicy`）。
     * 这个字段只决定「除了批准之外还要不要额外的限制」：
     *
     * - `manual` —— 只有批准这一道
     * - `single_shot` —— 同样只有批准这一道（一次性授权影响候选生成，不替代批准）
     * - `limited_auto` —— **实验能力**：额外受会话条数与冷却限制。它比别的模式更严格，
     *   不是更宽松；把它理解成「少点一次确认」是 v0.2.20 及以前的语义，已经结束
     */
    interactionMode: z<"manual" | "single_shot" | "limited_auto", "manual" | "single_shot" | "limited_auto", "volatile-defined">;
    /**
     * How many approved publishes one session may make, and how often.
     *
     * v0.2.21 起这两个数字限的是**频率**，不是放行条件：它们只在 `limited_auto` 下检查，
     * 而对已批准的发表同样生效。把额度当成「免批准次数」是旧语义。
     */
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
    /**
     * The owner's **numeric** Tieba account id.
     *
     * v0.2.23 keeps the field name so existing profiles keep working, but changes
     * what it is compared against: `authorNumericUid` only. It is no longer
     * compared against `authorId`, because on the WAP surface `authorId` holds a
     * login name — and `348099763 === "银狐_玉耀"` can never be true.
     *
     * A profile that only sets this, reading a thread that exposes no numeric uid,
     * is now told exactly that instead of being told the owner never posted.
     */
    ownerUserId: z<string, string, "volatile-defined">;
    /**
     * The owner's **login name** (`un`), introduced in v0.2.23.
     *
     * This is the field that actually works against a WAP read: the WAP page
     * publishes `un` and nothing numeric. It is separate from `ownerUserName`
     * because a login name is not a nickname — it is the account's own name that
     * the owner cannot change, whereas a nickname can be set to anything by
     * anyone.
     *
     * Leave empty if you do not know it; the plugin will refuse to guess rather
     * than fall back to a nickname.
     */
    ownerHandle: z<string, string, "volatile-defined">;
    /**
     * The owner's Tieba username, used only when neither an id nor a handle is set.
     *
     * A nickname. It can be duplicated and changed, so a match on it is recorded
     * as `display_name_match_only` and never treated as proof of identity.
     */
    ownerUserName: z<string, string, "volatile-defined">;
    /** The AI account's display name, for the summon hint. */
    aiAccountName: z<string, string, "volatile-defined">;
    /** The AI account's user id, when known. */
    aiAccountUserId: z<string, string, "volatile-defined">;
    /** Extra owner ids allowed to summon, comma separated. */
    allowedOwnerIds: z<string, string, "volatile-defined">;
    /**
     * Per-platform account bindings, as JSON.
     *
     * Empty means "derive from the legacy globals above", which keeps existing
     * profiles working unchanged (the globals describe Tieba, which is what they
     * always did). Setting it opts into the platform-scoped model, so a Weibo or
     * Zhihu account can be bound without inventing a second set of global fields.
     *
     * Shape: `{ "owners": [...], "aiAccounts": [...] }` — see
     * `platforms/accounts.ts`. Stored as a string rather than a nested schema
     * because this field is edited by the settings page, and a malformed value must
     * degrade to "unbound" rather than prevent the plugin from mounting.
     */
    platformAccounts: z<string, string, "volatile-defined">;
    /**
     * Master switch for injection protection.
     *
     * Defaults to `true`, and turning it off does **not** disable the deterministic
     * checks (target identity, credential leakage, owner attack) — those are not
     * configurable, because an option to disable them is an option an attacker only
     * has to talk the owner into flipping.
     */
    securityProtection: z<boolean, boolean, "volatile-defined">;
    /**
     * How eagerly text-level injection evidence forces a human review.
     *
     * Only the *semantic* threshold moves. `strict` flags anything at all (use it if
     * the account is being actively targeted), `relaxed` only high and critical.
     */
    securityStrictness: z<"strict" | "standard" | "relaxed", "strict" | "standard" | "relaxed", "volatile-defined">;
    /**
     * How many recent security events to keep for the settings page.
     *
     * Events store a redacted excerpt, never a whole post, so a large number is not
     * a memory risk — but it is also not useful, and a long list makes the important
     * ones harder to see.
     */
    securityEventLimit: z<number, number, "volatile-defined">;
    /** A Tieba cookie header copied from a logged-in browser. Never logged. */
    tiebaCookie: z<string, string, "volatile-defined">;
    /**
     * A thread id used to read the login banner, when no better page is at hand.
     *
     * The adapter asks for a page to read `data_editor` from. Verification passes the thread
     * the owner authorised, so this is only needed for callers that have no thread to name
     * — but the option existed on the adapter with no way to set it, which made the
     * "not configured" case the only case. Blank means "not configured".
     */
    authProbeThreadId: z<string, string, "volatile-defined">;
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
    /**
     * 模型接口的请求形状（v0.2.34 §3.1）。
     *
     * `chat` = `/chat/completions`（读 `choices[0].message.content`）；
     * `responses` = `/responses`（读 `output_text` 或 `output[].content[].text`）。
     *
     * 为什么要人填：同一个 Base URL 上两种协议都可能有，而它们的失败方式不同 ——
     * 协议填错时对方通常返回 200 但结构不对，看起来像「模型没说话」。靠名字猜
     * （例如「gpt-5 大概是 responses」）会在换模型的那天悄悄坏掉。
     */
    llmProtocol: z<"chat" | "responses", "chat" | "responses", "volatile-defined">;
    /** Per-request timeout. */
    llmTimeoutMs: z<number, number, "volatile-defined">;
    /**
     * Extra attempts after a *transient* model failure (v0.2.27).
     *
     * Default 0, matching the transport's own default, because a generation is not free and
     * a timeout may mean the provider is still working. When set, only failures that provably
     * did not take effect are retried — connection errors, timeouts, 429 and 5xx. A rejected
     * key, an exhausted quota, an over-long context and an explicit cancellation are never
     * retried: repeating them produces the same answer and spends the budget twice.
     */
    llmRetries: z<number, number, "volatile-defined">;
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
    /**
     * How much the plugin may do without a human click.
     *
     * ## v0.2.21 §二：三个模式都不再决定「要不要人工批准」
     *
     * 真实发表一律需要**该候选**的人工批准记录（见 `safety.ts` 的 `checkPublishPolicy`）。
     * 这个字段只决定「除了批准之外还要不要额外的限制」：
     *
     * - `manual` —— 只有批准这一道
     * - `single_shot` —— 同样只有批准这一道（一次性授权影响候选生成，不替代批准）
     * - `limited_auto` —— **实验能力**：额外受会话条数与冷却限制。它比别的模式更严格，
     *   不是更宽松；把它理解成「少点一次确认」是 v0.2.20 及以前的语义，已经结束
     */
    interactionMode: z<"manual" | "single_shot" | "limited_auto", "manual" | "single_shot" | "limited_auto", "volatile-defined">;
    /**
     * How many approved publishes one session may make, and how often.
     *
     * v0.2.21 起这两个数字限的是**频率**，不是放行条件：它们只在 `limited_auto` 下检查，
     * 而对已批准的发表同样生效。把额度当成「免批准次数」是旧语义。
     */
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
    ownerHandle: string;
    ownerUserName: string;
    aiAccountName: string;
    aiAccountUserId: string;
    allowedOwnerIds: string;
    platformAccounts: string;
    securityProtection: boolean;
    securityStrictness: "strict" | "standard" | "relaxed";
    securityEventLimit: number;
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
    llmProtocol: "chat" | "responses";
    llmTimeoutMs: number;
    llmRetries: number;
    llmTemperature: number;
    llmMaxOutputTokens: number;
    authProbeThreadId: string;
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