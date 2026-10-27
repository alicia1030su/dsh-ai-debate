/**
 * The plugin-owned settings API — the configuration page's read/write path.
 *
 * Why a plugin-owned route instead of the Harness settings RPC: that wire only
 * exposes namespaces on a hard-coded allowlist (`WEB_SETTINGS_NAMESPACES` plus
 * model providers and product namespaces). A third-party plugin cannot widen it
 * without patching DSH source. The namespace itself *is* registered host-side
 * (the row's `Config` schema), so this plugin serves loopback-only endpoints
 * that read and write it through the settings service, exactly like the shipped
 * `dsh-mem0` card does.
 *
 * Three families, one fence:
 *
 *   GET  /api/dsh-ai-debate/settings          -> redacted config view
 *   POST /api/dsh-ai-debate/settings          -> { set?: {field: value}, unset?: [field] }
 *   POST /api/dsh-ai-debate/secrets           -> { ref, value } | { ref, clear: true }
 *   GET  /api/dsh-ai-debate/status            -> live diagnostics
 *   POST /api/dsh-ai-debate/action            -> { action: 'test-llm' | 'check-login' | 'preview-persona' }
 *   GET  /api/dsh-ai-debate/records           -> publish ledger for the UI
 *
 * Every response is redacted by construction: no handler here ever returns a
 * cookie, an API key, or any substring of one beyond the four-character tail the
 * status view already exposes. That is a rule of this module, not a check that
 * could be forgotten — the redaction happens when the value is read, in
 * `viewOfSettings` and `describeSecrets`, and no other path sends one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { resolveConfig, type ResolvedConfig } from './config.js'
import type { CredentialPhase } from './credential-mirror.js'
import {
  clearSecret,
  describeSecrets,
  maskedTail,
  storeSecret,
  type CredentialSeam,
  type SecretOverlay,
  type SecretRefName,
  type SecretStatus,
} from './secrets.js'

/**
 * The credential phase as the page receives it.
 *
 * Structurally typed rather than importing the mirror's class: this module must
 * stay testable with a hand-written double, and a `CredentialPhase` union is
 * cheap to restate. The values are checked against the mirror by
 * `test/credential-states.test.ts`.
 */
export interface CredentialStatusView {
  readonly phase: CredentialPhase
  readonly settled: boolean
  readonly unresolved: readonly SecretRefName[]
  readonly error?: string
  readonly canPublish: boolean
}

/** Structural stand-in for the Host webserver's WebRoute (no build-time dep). */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle. */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The route family path prefix. */
export const ROUTE_PREFIX = '/api/dsh-ai-debate'

/** Cap on JSON request bodies (every payload here is tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * Fields the settings page may edit.
 *
 * An explicit allowlist rather than "anything in the schema": the schema is
 * shared with the Host settings form, and one of its fields (`storeDir`) points
 * at the filesystem. A wire that accepts arbitrary field names is a wire that
 * accepts a path traversal the moment a field is added.
 */
const EDITABLE_FIELDS = new Set([
  'enabled',
  'ownerUserId',
  'ownerUserName',
  'aiAccountName',
  'aiAccountUserId',
  'allowedOwnerIds',
  'personaStyle',
  'intensity',
  'maxLength',
  'emojiLevel',
  'sarcasmLevel',
  'directness',
  'llmBaseUrl',
  'llmModel',
  'llmTimeoutMs',
  'llmTemperature',
  'llmMaxOutputTokens',
  'contextPreset',
  'contextTokens',
  'interactionMode',
  'maxAutoPerSession',
  'cooldownSeconds',
  'maxPerThread',
  'maxFloorPages',
  'pageDelayMs',
  'requestTimeoutMs',
  'requestRetries',
  'sessionTtlDays',
  'announceToAgent',
  'logLevel',
])

/** Legacy secret fields, accepted only as a *clear* target — never as a write. */
const LEGACY_SECRET_FIELDS = new Set(['tiebaCookie', 'llmApiKey'])

/**
 * Reject a request that has not been authenticated as the browser session.
 *
 * Supplied by the host half from `ctx.connection.requestRejection`, which
 * applies the DSH Connection layer's own Host/Origin trust checks *and* its
 * signed-browser-cookie authentication. Returning `undefined` means "admit".
 *
 * Deliberately a callback rather than a direct service handle: this module
 * stays free of a build-time Harness dependency (the same reason `host.ts`
 * declares its own structural interfaces), and a test can drive the fence
 * without constructing a Connection.
 */
export type RequestAuthorizer = (request: IncomingMessage) => 'ok' | 401 | 403

/** The services and callbacks the route family needs from its host half. */
export interface SettingsRouteDeps {
  /**
   * Authenticate the caller.
   *
   * Absent means this deployment has no browser-session mechanism. The routes
   * then refuse every request — a settings API whose only credential is
   * "the socket came from 127.0.0.1" cannot tell the owner's browser from any
   * other local process, and this plugin owns a Tieba cookie and an API key.
   */
  authorize?: RequestAuthorizer
  /** Read the live resolved config. */
  config(): ResolvedConfig
  /** The credential seam, or undefined when unavailable. */
  credentials(): CredentialSeam | undefined
  /** The overlay currently in force. */
  overlay(): SecretOverlay
  /**
   * What the plugin currently believes about the credential store.
   *
   * The phase is what lets the page say "尚未确认" instead of picking one of two
   * lies: "未配置" (a fact the plugin does not have) or "已配置 · 长度 0" (the
   * v0.1.10 defect). Optional so a test double written against the older shape
   * keeps compiling; absent means the page falls back to the overlay alone.
   */
  credentialState?(): CredentialStatusView
  /**
   * Install a value the store already confirmed.
   *
   * Called after a successful write so the mirror holds the new value before the
   * next read can race it. Optional for the same reason as `credentialState`.
   */
  acceptSecret?(ref: SecretRefName, value: string): void
  /** Install a deletion the store already confirmed. */
  acceptSecretClear?(ref: SecretRefName): void
  /** Re-read the credential store and install the result. */
  refreshSecrets(): Promise<void>
  /** The settings service, or undefined. */
  settings(): SettingsService | undefined
  /** The settings namespace (the row id). */
  namespace(): string
  /** Run the model-connection probe. */
  testModel(): Promise<ModelProbe>
  /** Probe the Tieba login state. */
  checkLogin(): Promise<LoginProbe>
  /** Preview all four personas against a fixed exchange. */
  previewPersonas(): Promise<readonly PersonaPreview[]>
  /**
   * Stop every task that is still in a non-terminal state.
   *
   * This is the honest half of the "pause everything" affordance: the plugin
   * has no background scheduler, so there is nothing to switch off, but there
   * **are** live sessions and publishes in flight, and those can be stopped for
   * real. Publish records that already reached the platform are left alone.
   */
  stopAllActive(): Promise<PauseOutcome>
  /** Read the publish ledger and session counters. */
  diagnostics(): Promise<Diagnostics>
}

/** What a real "stop everything now" call actually managed to do. */
export interface PauseOutcome {
  /** Sessions moved to CANCELLED by this call. */
  readonly stopped: readonly string[]
  /** Sessions that refused to stop, with the reason the state machine gave. */
  readonly refused: readonly { readonly sessionId: string; readonly reason: string }[]
  /** Publishes whose in-flight request was aborted before it was sent. */
  readonly abortedInFlight: number
  /**
   * Replies that already reached the platform. Those are not withdrawn — no
   * API can recall them, and claiming otherwise would be a lie the user acts on.
   */
  readonly alreadyPublished: number
}

/** The settings service face used here (structural; see `host.ts` for the why). */
export interface SettingsService {
  writable: boolean
  update(namespace: string, patch: Record<string, unknown>): Promise<unknown>
  mutate(namespace: string, ops: readonly { op: 'unset'; path: readonly string[] }[]): Promise<unknown>
}

/** Result of probing the configured model endpoint. */
export interface ModelProbe {
  readonly ok: boolean
  readonly baseUrl: string
  readonly model: string
  readonly latencyMs?: number
  readonly message: string
  readonly sample?: string
}

/** Result of probing the Tieba login state. */
export interface LoginProbe {
  readonly ok: boolean
  readonly authenticated: boolean
  readonly message: string
  readonly userName?: string
  readonly userId?: string
  readonly cookieNames: readonly string[]
}

/** One persona's preview against a fixed, non-published exchange. */
export interface PersonaPreview {
  readonly style: string
  readonly name: string
  readonly summary: string
  readonly sample: string
  readonly promptShape: string
}

/** The live status block the diagnostics panel renders. */
export interface Diagnostics {
  readonly enabled: boolean
  readonly storePath: string
  readonly sessions: { total: number; active: number; awaitingConfirmation: number; published: number }
  readonly publishLedger: {
    total: number
    confirmed: number
    pending: number
    failed: number
    overCapacity: boolean
  }
  readonly usage: { calls: number; inputTokens: number; outputTokens: number; failures: number }
  readonly recentErrors: readonly { at: string; message: string }[]
  readonly rateLimit: { limited: boolean; note: string }
  readonly dshVersion?: string
  readonly pluginVersion: string
}

/** Send one JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * The cheap structural fence: loopback peer plus browser same-origin markers.
 *
 * This is **not** authentication and is no longer the only check. It answers
 * "does this look like a browser request aimed at this same origin", which
 * still usefully rejects DNS rebinding and a cross-site form post before any
 * work happens. Identity comes from {@link SettingsRouteDeps.authorize}.
 *
 * Two rules here are load-bearing and easy to get wrong:
 *
 * - A missing `Origin` does **not** mean trusted. Non-browser clients omit it,
 *   and a non-browser client on loopback is exactly what this fence cannot
 *   distinguish from the owner's page. It is admitted here only so the
 *   authorizer can judge it; the authorizer is what actually decides.
 * - A loopback socket address does **not** mean trusted either, for the same
 *   reason: every local process has one.
 */
export function isTrustedRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (
    hostUrl.hostname !== '127.0.0.1' &&
    hostUrl.hostname !== 'localhost' &&
    hostUrl.hostname !== '[::1]' &&
    hostUrl.hostname !== '::1'
  ) {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a JSON request body; undefined when oversized or unparseable. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) {
      // Drain rather than abort: an aborted request leaves the keep-alive
      // connection in a state Node will not reuse.
      overflow = true
      continue
    }
    chunks.push(buffer)
  }
  if (overflow) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The redacted settings view.
 *
 * `secrets` carries per-reference status only: `configured`, where it came from,
 * whether it is writable, and a four-character tail. The value itself is never
 * read here — `describeSecrets` is given a reader that returns the *legacy
 * config* field, which is already in the profile file and therefore not a
 * disclosure, and the store value never leaves `describe`.
 */
export async function viewOfSettings(deps: SettingsRouteDeps): Promise<Record<string, unknown>> {
  const config = deps.config()
  const settings = deps.settings()
  const overlay = deps.overlay()
  const secrets = await describeSecrets(deps.credentials(), overlay, (ref) =>
    ref === 'DSH_AI_DEBATE_TIEBA_COOKIE' ? config.tiebaCookie : config.llmApiKey,
  )
  const credential = deps.credentialState?.()
  return {
    status: 'ready',
    writable: settings?.writable ?? false,
    // A copy of the resolved (defaults applied) config, minus every secret. The
    // legacy secret fields are answered as booleans so the page can tell the
    // user their old config value is still in effect without echoing it.
    values: publicConfig(config),
    secrets: secrets.map(publicSecret),
    // What the plugin believes about the store. This is the field that lets the
    // page distinguish "unconfigured" from "not confirmed yet" instead of
    // guessing — the two look identical in `secrets` alone.
    credentials: credential === undefined ? undefined : publicCredentialState(credential),
    capabilities: {
      // The settings RPC is unavailable to third-party namespaces, so the write
      // path is this route; `writable` above mirrors the Host's own flag.
      settingsService: settings !== undefined,
      credentialService: deps.credentials() !== undefined,
    },
  }
}

/** The credential phase, with nothing that could carry a value. */
function publicCredentialState(state: CredentialStatusView): Record<string, unknown> {
  return {
    phase: state.phase,
    settled: state.settled,
    unresolved: [...state.unresolved],
    canPublish: state.canPublish,
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

/** Every config field except the secrets, as plain JSON. */
function publicConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    ownerUserId: config.ownerUserId,
    ownerUserName: config.ownerUserName,
    aiAccountName: config.aiAccountName,
    aiAccountUserId: config.aiAccountUserId,
    allowedOwnerIds: config.allowedOwnerIds,
    personaStyle: config.personaStyle,
    intensity: config.intensity,
    maxLength: config.maxLength,
    emojiLevel: config.emojiLevel,
    sarcasmLevel: config.sarcasmLevel,
    directness: config.directness,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    llmTimeoutMs: config.llmTimeoutMs,
    llmTemperature: config.llmTemperature,
    llmMaxOutputTokens: config.llmMaxOutputTokens,
    contextPreset: config.contextPreset,
    contextTokens: config.contextTokens,
    interactionMode: config.interactionMode,
    maxAutoPerSession: config.maxAutoPerSession,
    cooldownSeconds: config.cooldownSeconds,
    maxPerThread: config.maxPerThread,
    maxFloorPages: config.maxFloorPages,
    pageDelayMs: config.pageDelayMs,
    requestTimeoutMs: config.requestTimeoutMs,
    requestRetries: config.requestRetries,
    sessionTtlDays: config.sessionTtlDays,
    announceToAgent: config.announceToAgent,
    logLevel: config.logLevel,
  }
}

/** One secret row, with no value in it. */
function publicSecret(status: SecretStatus): Record<string, unknown> {
  return {
    ref: status.ref,
    configured: status.configured,
    ...(status.source === undefined ? {} : { source: status.source }),
    writable: status.writable,
    configSuperseded: status.configSuperseded,
    fromConfigFallback: status.fromConfigFallback,
    length: status.length,
    ...(status.tail === undefined ? {} : { tail: status.tail }),
  }
}

/** Coerce one edited field to the type its schema declares. */
function coerceField(field: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const numeric = new Set([
    'intensity',
    'maxLength',
    'emojiLevel',
    'sarcasmLevel',
    'directness',
    'llmTimeoutMs',
    'llmTemperature',
    'llmMaxOutputTokens',
    'contextTokens',
    'maxAutoPerSession',
    'cooldownSeconds',
    'maxPerThread',
    'maxFloorPages',
    'pageDelayMs',
    'requestTimeoutMs',
    'requestRetries',
    'sessionTtlDays',
  ])
  const boolean = new Set(['enabled', 'announceToAgent'])
  if (boolean.has(field)) {
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true') return { ok: true, value: true }
    if (value === 'false') return { ok: true, value: false }
    return { ok: false, error: `字段 ${field} 需要布尔值` }
  }
  if (numeric.has(field)) {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) return { ok: false, error: `字段 ${field} 需要数字` }
    return { ok: true, value: number }
  }
  if (typeof value !== 'string') return { ok: false, error: `字段 ${field} 需要字符串` }
  return { ok: true, value }
}

/**
 * Build the route family.
 *
 * Every handler resolves its dependencies at request time, never at
 * registration time: a settings edit changes the resolved config immediately,
 * and the credential overlay is refreshed by its own subscription, so a capture
 * of either at mount would serve stale answers.
 *
 * @param deps the host-half callbacks
 * @returns the routes to register
 */
export function makeSettingsRoutes(deps: SettingsRouteDeps): readonly WebRoute[] {
  /** Wrap a handler with the trust fence, the authorization check, and a uniform error shape. */
  const guard = (
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ): (request: IncomingMessage, response: ServerResponse) => Promise<void> => {
    return async (request, response) => {
      // Stage 1 — structural: loopback peer, same-origin Host/Origin markers.
      // Cheap, and it stops DNS rebinding and cross-site posts before any work.
      if (!isTrustedRequest(request)) {
        writeJson(response, 403, { error: 'forbidden: origin' })
        return
      }
      // Stage 2 — identity: the DSH browser session. A loopback socket address
      // says "some local process"; only the signed session cookie says "the
      // owner's browser". Nothing below this line runs unauthenticated, so a
      // rejected request can never reach a settings or credential write.
      const authorize = deps.authorize
      if (authorize === undefined) {
        writeJson(response, 403, {
          error:
            '本部署没有可用的会话认证（ctx.connection 缺失），配置接口已关闭。' +
            '请在 DSH 桌面端或 Web 界面中打开设置页；工具本身不受影响。',
        })
        return
      }
      let verdict: 'ok' | 401 | 403
      try {
        verdict = authorize(request)
      } catch {
        // A throwing authorizer is a refusal, never an admission.
        verdict = 403
      }
      if (verdict !== 'ok') {
        writeJson(response, verdict, {
          error:
            verdict === 401
              ? 'unauthorized: 需要已登录的 DSH 会话。请从 DSH 界面打开设置页。'
              : 'forbidden: 会话校验未通过。',
        })
        return
      }
      try {
        await handler(request, response)
      } catch (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const settingsRoute = guard(async (request, response) => {
    const method = request.method ?? 'GET'
    if (method === 'GET') {
      // Refresh the credential mirror before answering. Without this a cold
      // start reports every credential as unconfigured while the store holds
      // it — the page then shows "未配置" for a cookie that is actually saved.
      await deps.refreshSecrets()
      writeJson(response, 200, await viewOfSettings(deps))
      return
    }
    if (method !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${method}` })
      return
    }
    const settings = deps.settings()
    if (settings === undefined) {
      writeJson(response, 503, { error: '本部署没有 settings 服务，无法保存配置。' })
      return
    }
    if (settings.writable === false) {
      writeJson(response, 409, { error: '本部署的设置为只读（被更高优先级的配置层覆盖）。' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const patch: Record<string, unknown> = {}
    const ops: { op: 'unset'; path: readonly string[] }[] = []

    const set = body.set
    if (set !== undefined) {
      if (typeof set !== 'object' || set === null || Array.isArray(set)) {
        writeJson(response, 400, { error: '"set" 必须是字段到值的对象' })
        return
      }
      for (const [field, raw] of Object.entries(set as Record<string, unknown>)) {
        if (LEGACY_SECRET_FIELDS.has(field)) {
          writeJson(response, 400, {
            error: `${field} 是旧版明文密钥字段，配置页不接受写入。请改用凭据栏保存，或点「清除」把它从配置里删掉。`,
          })
          return
        }
        if (!EDITABLE_FIELDS.has(field)) {
          writeJson(response, 400, { error: `未知配置字段 "${field}"` })
          return
        }
        const coerced = coerceField(field, raw)
        if (!coerced.ok) {
          writeJson(response, 400, { error: coerced.error })
          return
        }
        patch[field] = coerced.value
      }
    }

    const unset = body.unset
    if (unset !== undefined) {
      if (!Array.isArray(unset) || unset.some((item) => typeof item !== 'string')) {
        writeJson(response, 400, { error: '"unset" 必须是字段名数组' })
        return
      }
      for (const field of unset as string[]) {
        if (LEGACY_SECRET_FIELDS.has(field)) {
          ops.push({ op: 'unset', path: [field] })
          continue
        }
        if (!EDITABLE_FIELDS.has(field)) {
          writeJson(response, 400, { error: `未知配置字段 "${field}"` })
          return
        }
        ops.push({ op: 'unset', path: [field] })
      }
    }

    if (Object.keys(patch).length === 0 && ops.length === 0) {
      writeJson(response, 200, await viewOfSettings(deps))
      return
    }

    try {
      if (Object.keys(patch).length > 0) await settings.update(deps.namespace(), patch)
      if (ops.length > 0) await settings.mutate(deps.namespace(), ops)
    } catch (error) {
      writeJson(response, 409, {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    writeJson(response, 200, await viewOfSettings(deps))
  })

  const secretRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const ref = body.ref
    if (ref !== 'DSH_AI_DEBATE_TIEBA_COOKIE' && ref !== 'DSH_AI_DEBATE_LLM_API_KEY') {
      writeJson(response, 400, { error: '未知凭据引用' })
      return
    }
    const target = ref as SecretRefName
    if (body.clear === true) {
      const result = await clearSecret(deps.credentials(), target)
      if (result.cleared) {
        // Install the deletion the store just confirmed, then discard every read
        // that was in flight while it happened. Doing this before the re-read is
        // what keeps a slow pre-clear read from resurrecting the old value.
        deps.acceptSecretClear?.(target)
        await deps.refreshSecrets()
      }
      writeJson(response, result.cleared ? 200 : 409, {
        cleared: result.cleared,
        ...(result.note === undefined ? {} : { error: result.note }),
        view: await viewOfSettings(deps),
      })
      return
    }
    const value = body.value
    if (typeof value !== 'string') {
      writeJson(response, 400, { error: '"value" 必须是字符串' })
      return
    }
    try {
      await storeSecret(deps.credentials(), target, value)
    } catch (error) {
      // The write did not commit, so the mirror keeps whatever it last confirmed.
      // Nothing is installed here on purpose: a failed save must not overwrite the
      // last known-good in-memory state with an unconfirmed value.
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    // Confirmed by the store: install it now so the very next operation — and any
    // read that was already running — uses the new value.
    deps.acceptSecret?.(target, value.trim())
    await deps.refreshSecrets()
    writeJson(response, 200, { saved: true, view: await viewOfSettings(deps) })
  })

  const statusRoute = guard(async (_request, response) => {
    await deps.refreshSecrets()
    writeJson(response, 200, await deps.diagnostics())
  })

  const actionRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const action = body.action
    if (action === 'test-llm') {
      writeJson(response, 200, await deps.testModel())
      return
    }
    if (action === 'check-login') {
      writeJson(response, 200, await deps.checkLogin())
      return
    }
    if (action === 'preview-personas') {
      writeJson(response, 200, { personas: await deps.previewPersonas() })
      return
    }
    // Stop everything that is still live. Distinct from the "switch to manual"
    // form edit above: that only stages config, this actually stops work.
    if (action === 'pause-now') {
      const outcome = await deps.stopAllActive()
      writeJson(response, 200, { ...outcome, view: await viewOfSettings(deps) })
      return
    }
    writeJson(response, 400, { error: `未知操作 "${String(action)}"` })
  })

  return [
    { kind: 'exact', path: `${ROUTE_PREFIX}/settings`, handler: settingsRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/secrets`, handler: secretRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: statusRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/action`, handler: actionRoute },
  ]
}

/** Re-export so the client bundle comment and the tests agree on one spelling. */
export const ROUTE_SETTINGS = `${ROUTE_PREFIX}/settings`
export const ROUTE_SECRETS = `${ROUTE_PREFIX}/secrets`
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`
export const ROUTE_ACTION = `${ROUTE_PREFIX}/action`

/** A masked tail, exposed for the diagnostics panel's credential rows. */
export { maskedTail }

/** The config the route family serves, resolved from a raw row config. */
export function resolvedForRoute(raw: unknown): ResolvedConfig {
  return resolveConfig(raw)
}
