/**
 * dsh-ai-debate — AI代吵架.
 *
 * Entry point. Responsibilities, in order of importance:
 *
 * 1. Register the nine tools inside an `effect`, so unloading the plugin
 *    removes them and leaves no half-mounted state.
 * 2. Build the runtime eagerly but cheaply: constructing the store does no
 *    disk I/O (the first `ready()` does), so mount stays fast while every tool
 *    gets a fully-formed runtime synchronously.
 * 3. Add a system-prompt section telling the agent the tools exist and when to
 *    reach for them — without it an agent has no reason to use them.
 * 4. On dispose, drop the registrations and release the runtime. Persisted
 *    state is already committed per mutation, so there is nothing to flush.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Config, DEFAULT_CONFIG, resolveConfig } from './config.js'
import { loggerOf, type PluginContext } from './host.js'
import { DebateStore } from './store.js'
import type { ThreadRef } from './types.js'
import {
  buildLlm,
  policyFromConfig,
  cancelInFlight,
  inFlightPublishCount,
  stopSession,
  type Runtime,
} from './runtime.js'
import { buildTools } from './tools.js'
import { PlatformRegistry } from './platforms/registry.js'
import { tiebaProvider } from './platforms/tieba/provider.js'
import { PLATFORM_MANIFESTS } from './platforms/manifests.js'
import { CAPABILITY_NAMES, markOf, stateOf } from './platforms/contracts.js'
import type { PlatformCapabilityMatrix } from './platforms/contracts.js'
import { AdapterManager } from './platforms/adapter-manager.js'
import { platformSettingsOf } from './runtime.js'

/**
 * Flatten a capability matrix into the row shape the settings page renders.
 *
 * Iterating {@link CAPABILITY_NAMES} rather than the matrix's own keys means a
 * platform that forgot to declare a capability still shows a row — with the
 * honest `unavailable` state — instead of silently omitting it.
 */
function flattenCapabilities(matrix: PlatformCapabilityMatrix): PlatformView['capabilities'] {
  return CAPABILITY_NAMES.map((name) => {
    const declaration = stateOf(matrix, name)
    return {
      name,
      state: declaration.state,
      mark: markOf(declaration.state),
      reason: declaration.reason,
      ...(declaration.limits === undefined ? {} : { limits: declaration.limits }),
      ...(declaration.requiredPermissions === undefined
        ? {}
        : { requiredPermissions: declaration.requiredPermissions }),
      ...(declaration.lastVerifiedAt === undefined
        ? {}
        : { lastVerifiedAt: declaration.lastVerifiedAt }),
    }
  })
}
import { collectDiagnostics, checkLogin, previewPersonas, testModel, PLUGIN_VERSION } from './diagnostics.js'
import { TERMINAL_STATES } from './store.js'
import {
  makeSettingsRoutes,
  type PauseOutcome,
  type PlatformView,
  type RequestAuthorizer,
  type SettingsRouteDeps,
  type SecurityView,
  type WebRoute,
} from './settings-routes.js'
import type { InjectableScope } from './host.js'
import { CredentialMirror } from './credential-mirror.js'
import { countersOf, type SecurityEvent } from './security/security-events.js'
import type { SecurityDecision } from './security/security-policy.js'
import { COOKIE_REF, SECRET_REFS, findCredentialSeam, type SecretOverlay } from './secrets.js'

/** Stable Loader identity; matches the row id in `cordis.patch.yml`. */
export const name = 'dsh-ai-debate'

/** Services required before the tools can mount. */
export const inject = ['tools', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 170

/**
 * Turn a delay into an awaitable timer that cannot hold the process open.
 *
 * `credential-mirror.ts` takes its sleep as a dependency so tests can advance a
 * fake clock; the real one has to be unref'd, or a settings-page read could keep
 * a shutting-down Host alive for the length of the warm-up.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
}

/** Re-export the config schema so the Host can render settings. */
export { Config, DEFAULT_CONFIG, resolveConfig }

/** What the agent is told about this plugin. */
export const DEBATE_GUIDANCE =
  '本机已安装 dsh-ai-debate 插件（AI代吵架）：读取百度贴吧帖子与楼中楼，还原主人和对手的争论，' +
  '按选定人格起草接话，经主人确认后再发表。\n' +
  '工具：debate_bind_owner（绑定主人/AI 账号）、debate_set_personality（选人格）、' +
  'debate_analyze_thread（读整帖并分析）、debate_analyze_reply（锁定某条回复分析）、' +
  'debate_generate_reply（生成候选）、debate_publish_reply（确认后发表）、' +
  'debate_get_session（查会话）、debate_stop_session（停止）、debate_health_check（健康检查）。\n' +
  '典型流程：绑定 → 分析（返回 sessionId）→ 生成候选 → 把候选正文原样交给主人看 → ' +
  '主人同意后才调用 debate_publish_reply 并传 confirm=true。\n' +
  '注意：发表是真实写操作，必须由主人明确同意；贴吧的艾特通知读取不可用，请让主人提供帖子链接手动召唤。'

/** Resolve the state directory from config, creating it. */
export function resolveStoreDir(config: ReturnType<typeof resolveConfig>): string {
  const dir = config.storeDir || join(homedir(), '.dsh', 'ai-debate')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Build the runtime synchronously; disk reads happen on first use.
 *
 * Multi-platform: no adapter is constructed here. `PlatformRuntime.adapterFor`
 * builds one per platform on demand, from that platform's own settings and
 * credentials, so the platform a URL resolves to is the platform whose adapter
 * actually reads and publishes.
 *
 * @param registry the platform registry
 * @param resolveSettings per-platform settings (may default to the whole config)
 */
export function buildRuntime(
  resolve: () => ReturnType<typeof resolveConfig>,
  log: ReturnType<typeof loggerOf>,
  registry: PlatformRegistry,
  resolveSettings?: (config: ReturnType<typeof resolveConfig>, platform: string) => Readonly<Record<string, unknown>>,
  options: {
    /**
     * Platform-scoped credential lookup.
     *
     * Passed in rather than read here because the credential mirror belongs to the
     * mounted plugin instance. The manager wraps it so a provider can only reach
     * its own namespace.
     */
    resolveCredential?: (platform: string, ref: string) => Promise<string | undefined>
  } = {},
): Runtime {
  const config = resolve()
  const store = new DebateStore({
    dir: resolveStoreDir(config),
    sessionTtlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  })

  const settingsFor = (platform: string): Readonly<Record<string, unknown>> =>
    (resolveSettings ?? ((value, id) => platformSettingsOf(value, id)))(resolve(), platform)

  const manager = new AdapterManager({
    registry,
    settingsFor,
    // Injected by the caller, which is where the credential mirror lives. A
    // platform-scoped resolver cannot be built here: this function is module-level
    // and has no access to the mounted plugin's credential state.
    ...(options.resolveCredential === undefined ? {} : { resolveCredential: options.resolveCredential }),
    log: (level, message) => {
      log[level](message)
    },
  })

  /**
   * The single-platform fallback.
   *
   * `runtime.adapter` still exists because a lot of code reads it and because a
   * one-platform deployment has an obvious answer. It is the *default* platform's
   * adapter — never another platform's — and every multi-platform code path calls
   * `adapterFor(runtime, platform)` instead.
   */
  const defaultPlatform = DEFAULT_PLATFORM_ID

  return {
    get adapter() {
      return manager.adapterFor(defaultPlatform)
    },
    store,
    policy: policyFromConfig(config),
    config: resolve,
    llm: () => buildLlm(resolve()),
    log: (level, message) => {
      log[level](message)
    },
    platforms: {
      resolveUrl: (url) => resolveThreadRefFromRegistry(registry, url),
      diagnostics: () => registry.diagnostics(),
      capabilitiesOf: (platform) => registry.getCapabilities(platform),
      adapterFor: (platform) => manager.adapterFor(platform),
      assertCapability: (platform, capability) => {
        registry.assertCapability(platform, capability)
      },
    },
  }
}

/**
 * Resolve a URL through the registry.
 *
 * Kept as a free function so `buildRuntime` can hand it to the runtime object
 * without the runtime holding a registry reference it could misuse.
 */
function resolveThreadRefFromRegistry(registry: PlatformRegistry, url: string): ThreadRef {
  return registry.parseUrl(url)
}

/**
 * The platform this deployment talks to.
 *
 * Still a constant in v0.2.0: the architecture is multi-platform, the shipped
 * integration set is not. Keeping it named (rather than scattering `'tieba'`
 * literals) means adding a second platform is changing this line plus registering
 * a provider.
 */
const DEFAULT_PLATFORM_ID = tiebaProvider.id

/**
 * Fields whose change invalidates the built adapter.
 *
 * The adapter holds a cookie jar and a forum-metadata cache, so a new cookie or
 * timeout cannot be applied to the old instance — it has to be rebuilt. Without
 * this, the settings panel shows the new value while requests keep using the old
 * one, which looks like a working feature that silently does nothing.
 */
const ADAPTER_FIELDS = [
  'tiebaCookie',
  'requestTimeoutMs',
  'requestRetries',
  'pageDelayMs',
  'maxFloorPages',
] as const

/** A stable key for the adapter-relevant part of a config snapshot. */
function adapterKey(config: ReturnType<typeof resolveConfig>): string {
  return ADAPTER_FIELDS.map((field) => String(config[field] ?? '')).join('\u0000')
}

/**
 * Best-effort read of the Harness version, for the diagnostics panel.
 *
 * Probed rather than required: the version lives in different services across
 * releases, and a missing version is a blank line in the panel, not a reason to
 * fail a mount.
 */
function readDshVersion(ctx: PluginContext): string | undefined {
  const probe = ctx as { get?: (name: string, strict?: boolean) => unknown }
  if (typeof probe.get !== 'function') return undefined
  for (const key of ['desktopVersion', 'hostVersion', 'appInfo', 'version']) {
    try {
      const value = probe.get(key, false)
      if (typeof value === 'string' && value.length > 0) return value
      if (typeof value === 'object' && value !== null) {
        const version = (value as { version?: unknown }).version
        if (typeof version === 'string' && version.length > 0) return version
      }
    } catch {
      // A missing service is expected; keep probing.
    }
  }
  return undefined
}

/**
 * Fold the credential overlay into a resolved config.
 *
 * The overlay wins over the config field whenever it holds a value. That order is
 * deliberate and not configurable: the credential store is the place designed to
 * hold a secret, the config field is the legacy path kept working for v0.1.5
 * users, and a store value that could be shadowed by a stale patch entry would be
 * the worst of both — silently ignored while looking configured.
 */
function applyOverlay(
  config: ReturnType<typeof resolveConfig>,
  overlay: SecretOverlay,
): ReturnType<typeof resolveConfig> {
  const cookie = overlay.cookie || config.tiebaCookie
  const llmApiKey = overlay.llmApiKey || config.llmApiKey
  if (cookie === config.tiebaCookie && llmApiKey === config.llmApiKey) return config
  return { ...config, tiebaCookie: cookie, llmApiKey }
}

/**
 * Mount the plugin.
 *
 * @param ctx the Host plugin context
 * @param config raw plugin config; volatile fields arrive as references
 * @returns the disposer that unmounts everything
 */
export function apply(ctx: PluginContext, config?: unknown): () => void {
  const log = loggerOf(ctx, 'dsh-ai-debate')
  const dshVersion = readDshVersion(ctx)

  /**
   * Credential values, mirrored so the synchronous config reader can see them.
   *
   * `ctx.credentials` is async while `resolveConfig` is sync and the adapter is
   * built synchronously at mount, so the store's values are mirrored into a small
   * overlay that `resolveConfig` reads synchronously.
   *
   * The mirroring lives in `credential-mirror.ts` since v0.1.12. It used to be a
   * `let overlayStale` right here, and that boolean could not distinguish "the
   * store is empty" from "the store has not finished parsing" — so an all-empty
   * read at mount cleared it and froze an empty mirror for the process lifetime.
   * It also gave concurrent refreshes no ordering, so a read that started before
   * a save could land after it and install the pre-save value.
   */
  const seam = findCredentialSeam(ctx as { get?: (name: string, strict?: boolean) => unknown })

  const credentialMirror = new CredentialMirror({
    seam,
    sleep: (ms) => sleepMs(ms),
    // Re-key eagerly on every accepted state change: the adapter holds a cookie
    // jar, so a rotated cookie must invalidate it now rather than on whichever
    // call happens to read next.
    onSettled: () => {
      rekeyRuntime()
    },
  })

  /** The resolved config with credential-store values folded in. */
  const effectiveConfig = (): ReturnType<typeof resolveConfig> => {    const resolved = resolveConfig(config)
    // With no credential service the legacy config fields are the whole story;
    // teach the mirror that so `canPublish()` reasons about a real cookie rather
    // than about a store that does not exist.
    if (seam === undefined) {
      credentialMirror.adoptConfigFallback({
        cookie: resolved.tiebaCookie.trim(),
        llmApiKey: resolved.llmApiKey.trim(),
        stored: new Set(),
      })
    }
    return applyOverlay(resolved, credentialMirror.overlay)
  }

  // The platform registry, built once per mount.
  //
  // One provider today (Tieba). A second platform is `registry.register(...)`
  // here plus a new file under `src/platforms/`, with no change to runtime,
  // publisher, generator or analyzer — that is the v0.2.0 acceptance criterion.
  const platforms = new PlatformRegistry()
  platforms.register(tiebaProvider)

  /**
   * What the settings page shows in its platform section.
   *
   * Registered adapters come first (they are code that exists), then manifests
   * (they are a plan). The two are told apart by `implemented`, never by wording,
   * so the page cannot present a research note as a shipped feature.
   */
  /**
   * The effective security state, for the settings page.
   *
   * Read from the running configuration and the retained event log, not from the
   * schema defaults: a panel that reports what *should* be on while it is off is
   * the one failure mode a security panel must not have.
   */
  const describeSecurity = (): SecurityView => {
    const config = runtime.config()
    // The stored records are structurally a superset of `SecurityEvent` except
    // that their string fields are widened for forward compatibility with a newer
    // writer. Narrowing on read keeps the analysis honest: an event whose `kind`
    // this build does not recognise still displays, it simply counts as `none`.
    const events = runtime.store.getSecurityEvents().map(
      (record): SecurityEvent => ({
        id: record.id,
        at: record.at,
        kind: record.kind as SecurityEvent['kind'],
        severity: record.severity as SecurityEvent['severity'],
        summary: record.summary,
        ...(record.platform !== undefined ? { platform: record.platform } : {}),
        ...(record.threadId !== undefined ? { threadId: record.threadId } : {}),
        ...(record.postId !== undefined ? { postId: record.postId } : {}),
        ...(record.decision !== undefined
          ? { decision: record.decision as SecurityDecision }
          : {}),
        ...(record.excerpt !== undefined ? { excerpt: record.excerpt } : {}),
      }),
    )
    return {
      protectionEnabled: config.securityProtection,
      strictness: config.securityStrictness,
      // Always true: the deterministic rules have no off switch. Declared as the
      // literal `true` in the type so removing that property would be a type
      // error rather than a quiet behaviour change.
      hardRulesEnforced: true,
      inputScanning: config.securityProtection,
      outputGate: true,
      // Stance checking is part of the output gate and therefore unconditional;
      // it is reported separately so the page can name it.
      stanceGuard: true,
      // The semantic reviewer is optional: this build ships the deterministic
      // layer only, and the page must say so rather than imply a second reviewer
      // is running.
      semanticReview: false,
      counters: countersOf(events),
      recent: [...events]
        .reverse()
        .slice(0, 10)
        .map((event) => ({
          at: event.at,
          summary: event.summary,
          severity: event.severity,
          ...(event.decision !== undefined ? { decision: event.decision } : {}),
        })),
    }
  }

  const describePlatforms = (): readonly PlatformView[] => {    const activeId = runtime.adapter.id
    const rows: PlatformView[] = []
    for (const provider of platforms.list()) {
      const matrix = provider.describeCapabilities()
      rows.push({
        id: provider.id,
        displayName: provider.displayName,
        shape: provider.shape,
        implemented: true,
        active: provider.id === activeId,
        capabilities: flattenCapabilities(matrix),
      })
    }
    for (const manifest of PLATFORM_MANIFESTS) {
      // A manifest whose platform is also registered (not true today) would be
      // rendered twice; the registered row wins because it is the real one.
      if (platforms.get(manifest.id) !== undefined) continue
      rows.push({
        id: manifest.id,
        displayName: manifest.displayName,
        shape: manifest.shape,
        implemented: false,
        active: false,
        research: manifest.research,
        capabilities: flattenCapabilities(manifest.capabilities),
        prerequisites: manifest.prerequisites,
        constraints: manifest.constraints,
        authModel: manifest.authModel,
        urlShapes: manifest.urlShapes,
      })
    }
    return rows
  }

  /**
   * Resolve one platform's credential, by reference.
   *
   * The manager calls this only after checking that the reference belongs to the
   * asking platform, so the namespace boundary is enforced one level up. A
   * platform with no credential of its own answers `undefined` rather than
   * borrowing one — which is what makes "the Weibo adapter has no Tieba cookie" a
   * fact rather than a hope.
   *
   * Only tieba has a credential seam today. A future platform adds its case here
   * and registers its own reference; nothing else needs to change.
   */
  const resolvePlatformCredential = async (
    platform: string,
    ref: string,
  ): Promise<string | undefined> => {
    if (platform !== 'tieba') return undefined
    if (ref !== COOKIE_REF) return undefined
    // The mirror wins once it holds a value; the config field is the legacy path
    // and `effectiveConfig` has already folded it in.
    const fromMirror = credentialMirror.overlay.cookie
    if (fromMirror.length > 0) return fromMirror
    const fromConfig = effectiveConfig().tiebaCookie.trim()
    return fromConfig.length > 0 ? fromConfig : undefined
  }

  // Rebuilt on every read so a live settings edit takes effect without a
  // remount — that is what `.volatile()` fields are for.
  let runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
    resolveCredential: resolvePlatformCredential,
  })
  let currentKey = adapterKey(effectiveConfig())
  let disposed = false

  /**
   * The runtime for the *current* config.
   *
   * When the cookie or a request parameter changed, the adapter is rebuilt and
   * the previous one is dropped. Sessions are not touched: they describe what was
   * read, and their stored targets are re-verified before any publish anyway.
   */
  const currentRuntime = (): Runtime => {
    if (disposed) throw new Error('插件已卸载，不能继续调用')
    const next = effectiveConfig()
    const key = adapterKey(next)
    if (key !== currentKey) {
      log.info('配置或凭据中的平台请求参数已变化，正在重建平台适配器')
      runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
        resolveCredential: resolvePlatformCredential,
      })
      currentKey = key
    }
    return runtime
  }

  /**
   * Rebuild the adapter if the effective config moved.
   *
   * Never throws after dispose: the mirror calls this from `onSettled`, and a
   * read that lands during unmount must not resurrect a runtime that has already
   * been dropped.
   */
  const rekeyRuntime = (): void => {
    if (disposed) return
    effectiveConfig()
    const key = adapterKey(effectiveConfig())
    if (key === currentKey) return
    log.info('配置或凭据中的平台请求参数已变化，正在重建平台适配器')
    runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
        resolveCredential: resolvePlatformCredential,
      })
    currentKey = key
  }

  /**
   * Re-read the credential store and install the result.
   *
   * Public through the routes so a save made in the browser takes effect on the
   * very next tool call, without a page reload or a plugin remount.
   *
   * The warm-up schedule lives in the mirror: a read that returns nothing is
   * ambiguous between "empty" and "not parsed yet", the store exposes no ready
   * flag or event, so the mirror retries over a bounded window and then reports
   * `timeout` rather than guessing.
   */
  const refreshSecrets = async (): Promise<void> => {
    if (disposed) return
    await credentialMirror.refresh()
    const state = credentialMirror.state
    if (state.error !== undefined && state.phase !== 'timeout') {
      log.warn(`读取凭据失败：${state.error}`)
    }
  }

  /**
   * Re-read once per consumer call while the mirror is still unproven.
   *
   * The mirror bounds its own warm-up, so this only decides *whether* a consumer
   * should trigger a read at all: an unproven phase is worth one more attempt, a
   * terminal one is not.
   */
  const ensureSecretsFresh = async (): Promise<void> => {
    if (disposed || seam === undefined) return
    const phase = credentialMirror.state.phase
    if (phase === 'ready' || phase === 'unavailable' || phase === 'empty') return
    await refreshSecrets()
  }

  // Refuse to do anything when the plugin is switched off.
  const assertEnabled = (action: string): void => {
    const value = effectiveConfig()
    if (!value.enabled) {
      throw new Error(
        `插件当前是关闭状态（enabled=false），不能${action}。` +
          '请在插件设置里打开后再试；关闭状态下不会读取帖子、不会调用模型、也不会发表。',
      )
    }
  }

  const runtimeView: Runtime = {
    get adapter() {
      return currentRuntime().adapter
    },
    get store() {
      return currentRuntime().store
    },
    get platforms() {
      // Forwarded, not copied.
      //
      // v0.2.0 had `buildRuntime` construct a `platforms` object and then this view
      // *omit* it — so in production `runtime.platforms` was undefined. Three things
      // silently degraded at once: the capability gate was never wired (every
      // publish skipped it), URL parsing fell back to "treat the whole link as a
      // thread id", and adapter selection always used the default platform. Tests
      // could not see it because they build a Runtime directly rather than through
      // this view.
      //
      // Reading it through `currentRuntime()` also means a config change swaps in a
      // fresh registry-backed view rather than a stale closure.
      return currentRuntime().platforms
    },
    get policy() {
      return policyFromConfig(effectiveConfig())
    },
    config: () => {
      // A cold start can leave the mirror empty even though the store has a
      // value (v0.1.9 bug). Kick a bounded re-read; the CURRENT call still sees
      // the old mirror, but it no longer poisons every later call, and the
      // routes refresh synchronously before answering.
      void ensureSecretsFresh().catch(() => undefined)
      assertEnabled('执行操作')
      return effectiveConfig()
    },
    llm: () => buildLlm(effectiveConfig()),
    credentialState: () => {
      const state = credentialMirror.state
      return {
        phase: state.phase,
        canPublish: credentialMirror.canPublish(),
        ...(state.error === undefined ? {} : { error: state.error }),
      }
    },
    log: (level, message) => {
      log[level](message)
    },
  }

  const tools = buildTools(runtimeView, ctx)

  const disposers: (() => void)[] = []
  const register = (label: string, execute: () => (() => void) | void): void => {
    if (typeof ctx.effect === 'function') {
      disposers.push(ctx.effect(execute, label))
      return
    }
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  register('dsh-ai-debate: tools', () => {
    const offs = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const off of offs) off()
    }
  })

  register('dsh-ai-debate: announcement', () => {
    const value = effectiveConfig()
    if (!value.enabled || !value.announceToAgent) return
    return ctx.systemPrompt.section({
      name: 'plugin:dsh-ai-debate',
      order: SECTION_ORDER,
      text: DEBATE_GUIDANCE,
    })
  })

  // ---- settings API ---------------------------------------------------------
  //
  // The Host's settings RPC only exposes its own allowlisted namespaces, so a
  // third-party plugin cannot use it. These routes are the plugin's own read/write
  // path for the page in `client/client.js`.
  //
  // Authentication is the DSH Connection layer's, not ours. `ctx.connection`
  // mints a signed, `HttpOnly`, `SameSite=Strict` browser-session cookie bound to
  // the listening authority, and `requestRejection()` applies that check plus the
  // Host/Origin trust rules to a plain Web route. Reusing it is both safer than a
  // bespoke scheme and the only way this route family benefits from future fixes
  // to that boundary. A loopback socket address alone is *not* identity: every
  // local process has one, and this plugin holds a Tieba cookie and an API key.
  const authorizer: RequestAuthorizer = (request) => {
    const connection = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.(
      'connection',
      false,
    ) as
      | {
          requestRejection?: (req: { headers: unknown }) => 401 | 403 | undefined
        }
      | undefined
    if (connection === undefined || connection === null) return 403
    if (typeof connection.requestRejection !== 'function') return 403
    const rejection = connection.requestRejection({ headers: request.headers })
    return rejection === undefined ? 'ok' : rejection
  }

  /**
   * Stop every live session and abort every publish still in flight.
   *
   * The plugin has no scheduler, so "pause all automatic tasks" has no queue to
   * switch off. What it does have is real work in progress, and this stops it:
   * terminal sessions already have their outcome recorded and are left exactly
   * as they are; a reply that already reached the platform stays recorded as
   * published, because cancelling is not an undo.
   */
  const stopAllActive = async (): Promise<PauseOutcome> => {
    await runtime.store.ready()
    const stopped: string[] = []
    const refused: { sessionId: string; reason: string }[] = []
    let alreadyPublished = 0
    let abortedInFlight = 0
    for (const session of runtime.store.snapshot().sessions) {
      // A reply that already reached the platform is reported, never hidden and
      // never "withdrawn": cancelling stops future work, it is not an undo.
      if (session.publishedPostIds.length > 0) alreadyPublished += 1
      if (TERMINAL_STATES.includes(session.state)) continue
      // Count what is actually in flight *before* aborting it. Reporting the
      // number of stopped sessions here would overstate the abort: a session
      // that had not started sending has nothing to abort.
      const inFlight = inFlightPublishCount(session.id)
      abortedInFlight += inFlight
      // Signal first, so a publish that is still validating stops before it
      // becomes a network request.
      cancelInFlight(session.id)
      try {
        await stopSession(runtime, session.id, '主人在设置页点了「立即暂停」')
        stopped.push(session.id)
      } catch (error) {
        refused.push({
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { stopped, refused, abortedInFlight, alreadyPublished }
  }

  const settingsRouteDeps: SettingsRouteDeps = {
    authorize: authorizer,
    // Platform state, for the page's platform section.
    //
    // Two groups, deliberately kept apart: registered adapters (code that exists)
    // and manifests (a plan). A page that renders them identically is exactly how
    // "we support Weibo" starts being read as true.
    platforms: () => describePlatforms(),
    // The security panel reads the effective state, not the configured defaults: a
    // page that showed "protection on" while it was off would teach the owner to
    // stop looking, which is worse than having no panel.
    security: () => describeSecurity(),
    // The page must not be told "unconfigured" because the mirror loaded too
    // early. This is the visible half of the v0.1.9 bug: after a restart the
    // badge said the cookie was missing while the store had it all along.
    //
    // A route read is a deliberate, human-paced action, so it always re-reads
    // rather than going through `ensureSecretsFresh`, which skips a proven
    // mirror: the settings page must never show state older than the last
    // request. The mirror's own warm-up bounds what that costs.
    refreshSecrets: async () => {
      await refreshSecrets()
    },
    config: () => effectiveConfig(),
    credentials: () => seam,
    overlay: () => credentialMirror.overlay,
    credentialState: () => {
      const state = credentialMirror.state
      return {
        phase: state.phase,
        settled: state.settled,
        unresolved: state.unresolved,
        canPublish: credentialMirror.canPublish(),
        ...(state.error === undefined ? {} : { error: state.error }),
      }
    },
    acceptSecret: (ref, value) => credentialMirror.commit(ref, value),
    acceptSecretClear: (ref) => credentialMirror.commitClear(ref),
    settings: () => {
      const candidate = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.('settings', false)
      if (candidate === undefined || candidate === null) return undefined
      const service = candidate as Partial<{
        writable: boolean
        update(namespace: string, patch: Record<string, unknown>): Promise<unknown>
        mutate(namespace: string, ops: readonly { op: 'unset'; path: readonly string[] }[]): Promise<unknown>
      }>
      if (typeof service.update !== 'function' || typeof service.mutate !== 'function') return undefined
      return {
        writable: service.writable !== false,
        update: (namespace, patch) => service.update!(namespace, patch),
        mutate: (namespace, ops) => service.mutate!(namespace, ops),
      }
    },
    namespace: () => name,
    testModel: async () => {
      try {
        return await testModel(runtimeView, effectiveConfig())
      } catch (error) {
        return {
          ok: false,
          baseUrl: effectiveConfig().llmBaseUrl,
          model: effectiveConfig().llmModel,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
    checkLogin: async () => {
      try {
        return await checkLogin(runtimeView)
      } catch (error) {
        return {
          ok: false,
          authenticated: false,
          message: error instanceof Error ? error.message : String(error),
          cookieNames: [],
        }
      }
    },
    previewPersonas: () => previewPersonas(effectiveConfig()),
    stopAllActive,
    diagnostics: async () => {
      const report = await collectDiagnostics(runtimeView, effectiveConfig())
      return { ...report, pluginVersion: PLUGIN_VERSION, ...(dshVersion === undefined ? {} : { dshVersion }) }
    },
  }

  // /api/dsh-ai-debate/* — the configuration page's read/write path.
  //
  // Registered through `ctx.inject(['webServer'], ...)` rather than one `ctx.get`
  // at mount time, because the two are not equivalent:
  //
  // - `ctx.get` at mount answers a single question at a single instant. In a
  //   headless or CLI composition the webserver service may not exist at all (a
  //   probe should then find nothing and stay quiet), but in a profile whose
  //   webserver activates after this plugin it exists *later* — and a one-shot
  //   probe silently loses the routes for the rest of the process lifetime. That
  //   failure is invisible: the tools keep working, and only the page 404s.
  // - `ctx.inject` fires on activation and again whenever the service comes
  //   back, does not make webServer a hard dependency of the plugin, and hands
  //   the disposer a scope that tears down with the service.
  //
  // The `strict` flag of `ctx.get` is deliberately not used: its behaviour
  // differs across dsh versions, so relying on it would make this plugin's
  // correctness depend on the host version.
  const ctxInjectable = ctx as unknown as {
    inject?: (deps: string[], fn: (scope: InjectableScope) => void) => unknown
  }

  if (typeof ctxInjectable.inject === 'function') {
    register('dsh-ai-debate: settings routes', () => {
      let disposeScope: (() => void) | undefined
      ctxInjectable.inject!(['webServer'], (scope) => {
        const server = scope.get?.('webServer') as
          | { register(route: WebRoute): () => void }
          | undefined
        if (server === undefined || server === null || typeof server.register !== 'function') {
          log.debug('webServer 已注入但没有 register 方法，配置页路由未注册（工具不受影响）')
          return
        }
        const routes = makeSettingsRoutes(settingsRouteDeps)
        const offs = routes.map((route) => server.register(route))
        // The injected scope's own effect owns the route lifetime: routes go away
        // with the service, and a service restart registers them again.
        const disposeRoutes = (): void => {
          for (const off of offs) off()
        }
        disposeScope =
          typeof scope.effect === 'function'
            ? scope.effect(() => disposeRoutes, 'dsh-ai-debate: settings routes')
            : disposeRoutes
      })
      return () => {
        disposeScope?.()
        disposeScope = undefined
      }
    })
  } else {
    // A host without the injectable-context contract: fall back to the one-shot
    // probe, so the routes still register when the service is already up.
    register('dsh-ai-debate: settings routes', () => {
      const webServer = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.(
        'webServer',
        false,
      ) as { register(route: WebRoute): () => void } | undefined
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
        log.debug('本部署没有 webServer 服务，配置页路由没有注册（工具不受影响）')
        return
      }
      const routes = makeSettingsRoutes(settingsRouteDeps)
      const offs = routes.map((route) => webServer.register(route))
      return () => {
        for (const off of offs) off()
      }
    })
  }

  // ---- credential subscription ---------------------------------------------
  //
  // Rotating a secret must reach the next request without a reload, and the
  // adapter holds a cookie jar, so the refresh also re-keys the runtime. The
  // subscription is optional: a deployment without credentials simply never
  // fires one, and the config fallbacks stay in force.
  if (seam !== undefined) {
    const ctxWithEvents = ctx as {
      on?: (event: string, listener: (...args: unknown[]) => void) => () => void
      effect?: (execute: () => (() => void) | void, label?: string) => () => void
    }
    if (typeof ctxWithEvents.on === 'function') {
      register('dsh-ai-debate: credential updates', () => {
        const offs = SECRET_REFS.map((ref) =>
          ctxWithEvents.on!('credentials/reference-updated', (updated: unknown) => {
            if (updated !== undefined && updated !== ref) return
            void refreshSecrets().catch((error: unknown) => {
              log.warn(`凭据更新后重建失败：${error instanceof Error ? error.message : String(error)}`)
            })
          }),
        )
        return () => {
          for (const off of offs) off()
        }
      })
    }
    // The first read is fire-and-forget: mount must stay synchronous, and the
    // config fallbacks already make the plugin usable until it lands.
    void refreshSecrets().catch((error: unknown) => {
      log.warn(`首次读取凭据失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        log.warn(`卸载 ${name} 时出错：${(error as Error).message}`)
      }
    }
    runtime = undefined as unknown as Runtime
  }
}
