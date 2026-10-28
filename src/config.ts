/**
 * Plugin configuration schema.
 *
 * Uses `@deepseek-ai/schemastery` because that is what the Host's Settings
 * surface understands, and marks every field `.volatile()` so an edit takes
 * effect without remounting the plugin. Secrets carry `role('secret')` so the
 * Harness redacts them anywhere they would otherwise be echoed.
 */

import z from '@deepseek-ai/schemastery'

/** The plugin's configuration. */
export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true).volatile(),

  // ---- owner and account binding -------------------------------------------
  /** The owner's stable Tieba user id. Preferred over the name. */
  ownerUserId: z.string().default('').volatile(),
  /** The owner's Tieba username, used only when no id is configured. */
  ownerUserName: z.string().default('').volatile(),
  /** The AI account's display name, for the summon hint. */
  aiAccountName: z.string().default('').volatile(),
  /** The AI account's user id, when known. */
  aiAccountUserId: z.string().default('').volatile(),
  /** Extra owner ids allowed to summon, comma separated. */
  allowedOwnerIds: z.string().default('').volatile(),
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
  platformAccounts: z.string().default('').volatile(),

  // ---- security ------------------------------------------------------------
  /**
   * Master switch for injection protection.
   *
   * Defaults to `true`, and turning it off does **not** disable the deterministic
   * checks (target identity, credential leakage, owner attack) — those are not
   * configurable, because an option to disable them is an option an attacker only
   * has to talk the owner into flipping.
   */
  securityProtection: z.boolean().default(true).volatile(),
  /**
   * How eagerly text-level injection evidence forces a human review.
   *
   * Only the *semantic* threshold moves. `strict` flags anything at all (use it if
   * the account is being actively targeted), `relaxed` only high and critical.
   */
  securityStrictness: z
    .union([z.const('strict'), z.const('standard'), z.const('relaxed')])
    .default('standard')
    .volatile(),
  /**
   * How many recent security events to keep for the settings page.
   *
   * Events store a redacted excerpt, never a whole post, so a large number is not
   * a memory risk — but it is also not useful, and a long list makes the important
   * ones harder to see.
   */
  securityEventLimit: z.number().min(0).max(200).default(50).volatile(),

  // ---- credentials ---------------------------------------------------------
  /** A Tieba cookie header copied from a logged-in browser. Never logged. */
  tiebaCookie: z.string().role('secret').default('').volatile(),

  // ---- persona -------------------------------------------------------------
  /** Default persona style. */
  personaStyle: z
    .union([
      z.const('tieba_veteran'),
      z.const('soft_defensive'),
      z.const('tsundere'),
      z.const('aloof'),
    ])
    .default('tieba_veteran')
    .volatile(),
  /** 1 (mild) to 5 (sharp). */
  intensity: z.number().min(1).max(5).default(3).volatile(),
  /** Maximum reply length in Chinese characters. */
  maxLength: z.number().min(20).max(600).default(150).volatile(),
  /** Emoji usage, 0 to 3. */
  emojiLevel: z.number().min(0).max(3).default(0).volatile(),
  /** Sarcasm, 0 to 3. */
  sarcasmLevel: z.number().min(0).max(3).default(2).volatile(),
  /** Directness, 1 to 5. */
  directness: z.number().min(1).max(5).default(4).volatile(),

  // ---- model ---------------------------------------------------------------
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1. */
  llmBaseUrl: z.string().default('').volatile(),
  /** API key for that endpoint. Never logged. */
  llmApiKey: z.string().role('secret').default('').volatile(),
  /** Model name. */
  llmModel: z.string().default('').volatile(),
  /** Per-request timeout. */
  llmTimeoutMs: z.number().min(1000).max(600000).default(120000).volatile(),
  /**
   * Sampling temperature.
   *
   * Low by default: this task is precision, not creativity. Raise it only if the
   * drafts read too stiffly and the model still returns valid JSON.
   */
  llmTemperature: z.number().min(0).max(2).default(0.4).volatile(),
  /** Cap on the model's own answer; 0 leaves the size to the persona length. */
  llmMaxOutputTokens: z.number().min(0).max(32000).default(0).volatile(),

  // ---- context budget ------------------------------------------------------
  /** Budget preset for the model's context. */
  contextPreset: z
    .union([z.const('small'), z.const('medium'), z.const('large')])
    .default('small')
    .volatile(),
  /** Explicit token budget; overrides the preset when > 0. */
  contextTokens: z.number().min(0).max(200000).default(0).volatile(),

  // ---- interaction policy --------------------------------------------------
  /** How much the plugin may do without a human click. */
  interactionMode: z
    .union([z.const('manual'), z.const('single_shot'), z.const('limited_auto')])
    .default('manual')
    .volatile(),
  /** Automatic publishes allowed per session. */
  maxAutoPerSession: z.number().min(0).max(50).default(0).volatile(),
  /** Cooldown between automatic publishes, in seconds. */
  cooldownSeconds: z.number().min(0).max(3600).default(60).volatile(),
  /** Maximum publishes in one thread. */
  maxPerThread: z.number().min(1).max(100).default(10).volatile(),

  // ---- collection limits ---------------------------------------------------
  /** Maximum floor pages read per thread. */
  maxFloorPages: z.number().min(1).max(500).default(60).volatile(),
  /** Pause between page requests, in milliseconds. */
  pageDelayMs: z.number().min(0).max(5000).default(400).volatile(),
  /** HTTP timeout for platform requests. */
  requestTimeoutMs: z.number().min(1000).max(120000).default(20000).volatile(),
  /** Extra attempts on transport failures. */
  requestRetries: z.number().min(0).max(5).default(2).volatile(),

  // ---- storage -------------------------------------------------------------
  /** Override the store directory; empty means the profile default. */
  storeDir: z.string().default('').volatile(),
  /** Session retention in days. */
  sessionTtlDays: z.number().min(1).max(365).default(7).volatile(),

  // ---- misc ----------------------------------------------------------------
  /** When true, a system-prompt section tells the agent the tools exist. */
  announceToAgent: z.boolean().default(true).volatile(),
  /** Log verbosity. */
  logLevel: z
    .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
    .default('info')
    .volatile(),
})

/** Defaults mirroring the schema, for hand-built test contexts. */
export const DEFAULT_CONFIG = {
  enabled: true,
  ownerUserId: '',
  ownerUserName: '',
  aiAccountName: '',
  aiAccountUserId: '',
  allowedOwnerIds: '',
  platformAccounts: '',
  securityProtection: true,
  securityStrictness: 'standard' as 'strict' | 'standard' | 'relaxed',
  securityEventLimit: 50,
  tiebaCookie: '',
  personaStyle: 'tieba_veteran' as const,
  intensity: 3,
  maxLength: 150,
  emojiLevel: 0,
  sarcasmLevel: 2,
  directness: 4,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  llmTimeoutMs: 120000,
  llmTemperature: 0.4,
  llmMaxOutputTokens: 0,
  contextPreset: 'small' as const,
  contextTokens: 0,
  interactionMode: 'manual' as const,
  maxAutoPerSession: 0,
  cooldownSeconds: 60,
  maxPerThread: 10,
  maxFloorPages: 60,
  pageDelayMs: 400,
  requestTimeoutMs: 20000,
  requestRetries: 2,
  storeDir: '',
  sessionTtlDays: 7,
  announceToAgent: true,
  logLevel: 'info' as const,
}

/** The resolved configuration shape. */
export type ResolvedConfig = typeof DEFAULT_CONFIG

/**
 * Unwrap one volatile field.
 *
 * A `.volatile()` schema field arrives as a reference exposing `get()` rather
 * than a bare value; plain values pass through so hand-built contexts work.
 */
function unwrap(field: unknown): unknown {
  if (field === undefined || field === null) return undefined
  const ref = field as { get?: () => unknown }
  if (typeof ref.get === 'function') {
    const value = ref.get()
    return value === null ? undefined : value
  }
  return field
}

/** Read a string field with a fallback. */
function readString(field: unknown, fallback: string): string {
  const value = unwrap(field)
  return typeof value === 'string' ? value : fallback
}

/** Read a number field with a fallback. */
function readNumber(field: unknown, fallback: number): number {
  const value = unwrap(field)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

/** Read a boolean field with a fallback. */function readBoolean(field: unknown, fallback: boolean): boolean {
  const value = unwrap(field)
  return typeof value === 'boolean' ? value : fallback
}

/** Normalize a raw config against the defaults. */
export function resolveConfig(input: unknown): ResolvedConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  const style = readString(raw.personaStyle, DEFAULT_CONFIG.personaStyle)
  const preset = readString(raw.contextPreset, DEFAULT_CONFIG.contextPreset)
  const mode = readString(raw.interactionMode, DEFAULT_CONFIG.interactionMode)
  const level = readString(raw.logLevel, DEFAULT_CONFIG.logLevel)

  return {
    enabled: readBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
    ownerUserId: readString(raw.ownerUserId, '').trim(),
    ownerUserName: readString(raw.ownerUserName, '').trim(),
    aiAccountName: readString(raw.aiAccountName, '').trim(),
    aiAccountUserId: readString(raw.aiAccountUserId, '').trim(),
    allowedOwnerIds: readString(raw.allowedOwnerIds, '').trim(),
    platformAccounts: readString(raw.platformAccounts, '').trim(),
    securityProtection: readBoolean(raw.securityProtection, DEFAULT_CONFIG.securityProtection),
    securityStrictness: (['strict', 'standard', 'relaxed'] as const).includes(
      readString(raw.securityStrictness, 'standard') as never,
    )
      ? (readString(raw.securityStrictness, 'standard') as ResolvedConfig['securityStrictness'])
      : DEFAULT_CONFIG.securityStrictness,
    securityEventLimit: readNumber(raw.securityEventLimit, DEFAULT_CONFIG.securityEventLimit),
    tiebaCookie: readString(raw.tiebaCookie, '').trim(),
    personaStyle: (['tieba_veteran', 'soft_defensive', 'tsundere', 'aloof'] as const).includes(
      style as never,
    )
      ? (style as ResolvedConfig['personaStyle'])
      : DEFAULT_CONFIG.personaStyle,
    intensity: readNumber(raw.intensity, DEFAULT_CONFIG.intensity),
    maxLength: readNumber(raw.maxLength, DEFAULT_CONFIG.maxLength),
    emojiLevel: readNumber(raw.emojiLevel, DEFAULT_CONFIG.emojiLevel),
    sarcasmLevel: readNumber(raw.sarcasmLevel, DEFAULT_CONFIG.sarcasmLevel),
    directness: readNumber(raw.directness, DEFAULT_CONFIG.directness),
    llmBaseUrl: readString(raw.llmBaseUrl, '').trim(),
    llmApiKey: readString(raw.llmApiKey, '').trim(),
    llmModel: readString(raw.llmModel, '').trim(),
    llmTimeoutMs: readNumber(raw.llmTimeoutMs, DEFAULT_CONFIG.llmTimeoutMs),
    llmTemperature: clampNumber(
      readNumber(raw.llmTemperature, DEFAULT_CONFIG.llmTemperature),
      0,
      2,
      DEFAULT_CONFIG.llmTemperature,
    ),
    llmMaxOutputTokens: clampNumber(
      readNumber(raw.llmMaxOutputTokens, DEFAULT_CONFIG.llmMaxOutputTokens),
      0,
      32000,
      DEFAULT_CONFIG.llmMaxOutputTokens,
    ),
    contextPreset: (['small', 'medium', 'large'] as const).includes(preset as never)
      ? (preset as ResolvedConfig['contextPreset'])
      : DEFAULT_CONFIG.contextPreset,
    contextTokens: readNumber(raw.contextTokens, 0),
    interactionMode: (['manual', 'single_shot', 'limited_auto'] as const).includes(mode as never)
      ? (mode as ResolvedConfig['interactionMode'])
      : DEFAULT_CONFIG.interactionMode,
    maxAutoPerSession: readNumber(raw.maxAutoPerSession, DEFAULT_CONFIG.maxAutoPerSession),
    cooldownSeconds: readNumber(raw.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds),
    maxPerThread: readNumber(raw.maxPerThread, DEFAULT_CONFIG.maxPerThread),
    maxFloorPages: readNumber(raw.maxFloorPages, DEFAULT_CONFIG.maxFloorPages),
    pageDelayMs: readNumber(raw.pageDelayMs, DEFAULT_CONFIG.pageDelayMs),
    requestTimeoutMs: readNumber(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
    requestRetries: readNumber(raw.requestRetries, DEFAULT_CONFIG.requestRetries),
    storeDir: readString(raw.storeDir, '').trim(),
    sessionTtlDays: readNumber(raw.sessionTtlDays, DEFAULT_CONFIG.sessionTtlDays),
    announceToAgent: readBoolean(raw.announceToAgent, DEFAULT_CONFIG.announceToAgent),
    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(level as never)
      ? (level as ResolvedConfig['logLevel'])
      : DEFAULT_CONFIG.logLevel,
  }
}

/** Split a comma-separated id list, dropping blanks. */
export function splitIds(raw: string): readonly string[] {
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Read a number and keep it inside a range, falling back on nonsense. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
