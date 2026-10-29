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
import { weiboProvider } from './platforms/weibo/provider.js'
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
  type ApprovalOutcome,
  type PauseOutcome,
  type PendingApprovalView,
  type PendingApprovalsView,
  type PlatformView,
  type RequestAuthorizer,
  type SettingsRouteDeps,
  type SecurityView,
  type WebRoute,
} from './settings-routes.js'
import type { InjectableScope } from './host.js'
import { CredentialMirror } from './credential-mirror.js'
import { bindingOf, checkApproval, createApproval, hashText } from './security/approvals.js'
import { aiAccountFor } from './platforms/accounts.js'
import { bindingsOf } from './runtime.js'
import {
  checkExpectation,
  checkReassessment,
  isApprovable,
  approvableOf,
  readExpectation,
} from './security/approve-guard.js'
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
    /**
     * Share an existing store instead of opening the file again.
     *
     * ## Why this exists (v0.2.7)
     *
     * `buildRuntime` is called on every config or credential change, and each call
     * used to construct its own `DebateStore`. Two objects then pointed at the same
     * `state.json` and each held a private copy of the document, so whichever wrote
     * second overwrote whatever the first had added — including `confirmed` dedupe
     * rows (the double-post guard) and approval records (the publish authorisation).
     *
     * The single-writer rule fixes that at the source: within one process there is
     * exactly one store per directory, and a rebuild hands the new runtime the
     * existing instance. Cross-process writers are handled separately by the
     * advisory lock in `mutate`.
     */
    store?: DebateStore
  } = {},
): Runtime {
  const config = resolve()
  const store =
    options.store ??
    new DebateStore({
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
   * The single-platform fallback: which platform `runtime.adapter` answers for.
   *
   * `runtime.adapter` still exists because a lot of code reads it and because a
   * one-platform deployment has an obvious answer. Every multi-platform code path
   * calls `adapterFor(runtime, platform)` instead.
   *
   * Resolved from the registry at call time, not frozen to `tieba` (v0.2.6).
   * Before this it was `DEFAULT_PLATFORM_ID = tiebaProvider.id`, so a deployment
   * whose registry held only other platforms threw `平台「tieba」没有注册` from
   * `runtime.adapter` — which took down `healthCheck`, `checkLogin` and the
   * settings page's platform list. That is the "runtime has one fixed adapter"
   * shape v0.2.1 was meant to remove, surviving in the fallback.
   *
   * Order: the registered Tieba provider (so a Tieba deployment keeps answering
   * `tieba` even if another platform registered first), otherwise the first
   * registered platform. An empty registry has no answer and says so.
   */
  const defaultPlatform = (): string => {
    if (registry.get(tiebaProvider.id) !== undefined) return tiebaProvider.id
    const ids = registry.listIds()
    if (ids.length === 0) {
      throw new Error('平台注册中心是空的：没有任何平台可以处理请求。')
    }
    return ids[0]!
  }

  return {
    get adapter() {
      return manager.adapterFor(defaultPlatform())
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
  // Two providers now (v0.2.7): Tieba, which can read and (unverified) publish, and
  // Weibo, which routes links and declares its limits but cannot touch the network
  // until an Open Platform scope is granted. Registering Weibo is what stops a pasted
  // Weibo link being treated as an unknown link that "falls back to Tieba" — the
  // v0.2.0 bug — without claiming any capability it does not have.
  const platforms = new PlatformRegistry()
  platforms.register(tiebaProvider)
  platforms.register(weiboProvider)

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

  const describePlatforms = (): readonly PlatformView[] => {
    const activeId = runtime.adapter.id
    const rows: PlatformView[] = []
    for (const provider of platforms.list()) {
      const matrix = provider.describeCapabilities()
      // `implemented` is not "there is a provider object". It is "this platform can
      // actually read or write something", and it is derived from the capability
      // matrix rather than stated separately so the two cannot disagree.
      //
      // This became load-bearing in v0.2.7, when Weibo's provider was registered. It
      // routes links and declares its limits, but every network method throws because
      // no Open Platform scope exists here — so it is registered *and* not
      // implemented, and the page must say so. Before this, registering any provider
      // painted it green.
      const implemented = Object.values(matrix.capabilities).some(
        (capability) => capability.state === 'supported' || capability.state === 'unverified',
      )
      rows.push({
        id: provider.id,
        displayName: provider.displayName,
        shape: provider.shape,
        implemented,
        active: provider.id === activeId,
        capabilities: flattenCapabilities(matrix),
      })
    }
    for (const manifest of PLATFORM_MANIFESTS) {
      // A manifest whose platform is also registered would be rendered twice; the
      // registered row wins because it carries the real capability matrix. The
      // research/prerequisite text is still worth showing for a registered-but-
      // unimplemented platform, so it is merged in below rather than dropped.
      if (platforms.get(manifest.id) !== undefined) {
        const existing = rows.find((row) => row.id === manifest.id)
        if (existing !== undefined && !existing.implemented) {
          rows[rows.indexOf(existing)] = {
            ...existing,
            research: manifest.research,
            prerequisites: manifest.prerequisites,
            constraints: manifest.constraints,
            authModel: manifest.authModel,
            urlShapes: manifest.urlShapes,
          }
        }
        continue
      }
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

  /**
   * The one store this process writes through.
   *
   * Created once per mount and handed to every `buildRuntime`, so the several
   * runtime objects a plugin ends up with (initial, plus one per config change)
   * share a single authoritative copy of the document instead of each holding its
   * own. Without this, a rebuild silently forked the state: operations holding the
   * older runtime wrote a document that predated the newer one's records.
   *
   * The directory is resolved lazily and pinned on first use: `storeDir` is a
   * config field, and a change to it is a different database, not a rebind.
   */
  let sharedStore: DebateStore | undefined
  let sharedStoreDir: string | undefined
  const storeFor = (config: ReturnType<typeof resolveConfig>): DebateStore => {
    const dir = resolveStoreDir(config)
    if (sharedStore === undefined || sharedStoreDir !== dir) {
      sharedStore = new DebateStore({
        dir,
        sessionTtlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000,
      })
      sharedStoreDir = dir
    }
    return sharedStore
  }

  // Rebuilt on every read so a live settings edit takes effect without a
  // remount — that is what `.volatile()` fields are for.
  let runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
    resolveCredential: resolvePlatformCredential,
    store: storeFor(effectiveConfig()),
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
        store: storeFor(next),
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
      store: storeFor(effectiveConfig()),
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

  /**
   * Create a human approval from the settings page.
   *
   * ## The whole authorisation story is in this one function's placement
   *
   * It is referenced only by `settingsRouteDeps.approve`, which is only reachable
   * through the `/approve` route, which is wrapped by that module's `guard`
   * (loopback + same-origin + a verified DSH session). No `ToolDefinition` calls it and
   * no tool output reveals it. That is what makes "the owner clicked approve" a
   * different event from "the model wrote confirm: true", which is the point of v0.2.5.
   *
   * ## Binding, not vouching
   *
   * The record stores what was approved, not "approval happened": the exact
   * `textHash`, target post, candidate version and assessment fingerprint. A later
   * edit to any of them makes the record unmatchable rather than silently reusable,
   * which is why the publish path can compare instead of trusting.
   */
  const createApprovalForSettings = async (input: Record<string, unknown>): Promise<ApprovalOutcome> => {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const candidateId = typeof input.candidateId === 'string' ? input.candidateId.trim() : ''
    if (!sessionId || !candidateId) {
      return { status: 400, body: { error: '缺少 sessionId 或 candidateId' } }
    }

    // ## The snapshot is mandatory (v0.2.7)
    //
    // Until that version the route accepted `{ sessionId, candidateId }` and bound
    // the approval to whatever was stored *at request time*. That let a page which
    // was three regenerations old approve the current candidate: the owner reviewed
    // one body and authorised another. The record was internally consistent, so
    // nothing downstream could tell.
    //
    // The caller must now say what it was showing. The shape is validated here; the
    // value comparison happens *inside* the transaction below, against the document
    // as it exists on disk at that moment (v0.2.8). v0.2.7 compared against this
    // instance's view and then wrote in a second step, so a candidate replaced
    // between the two produced a record describing content nobody had reviewed.
    const readBack = readExpectation(input.expected, sessionId, candidateId)
    if (!readBack.ok) {
      return { status: readBack.status, body: { error: readBack.reason, code: readBack.code } }
    }
    const expected = readBack.expectation

    // The account the publish path will use, resolved the same way. It does not
    // depend on stored state, so it can be resolved before the transaction.
    const config = effectiveConfig()

    type ApprovalVerdict =
      | { status: 200; body: Record<string, unknown> }
      | { status: 404 | 409; body: Record<string, unknown> }

    const outcome = await runtimeView.store.transact<ApprovalVerdict>((data) => {
      const session = data.sessions.find((row) => row.id === sessionId)
      if (session === undefined) {
        return { abort: { status: 404, body: { error: `找不到会话 ${sessionId}` } } }
      }
      const candidate = session.candidates.find((row) => row.replyId === candidateId)
      if (candidate === undefined) {
        return { abort: { status: 404, body: { error: `找不到候选 ${candidateId}` } } }
      }

      const approvable = isApprovable(approvableOf(candidate))
      if (!approvable.ok) {
        return { abort: { status: 409, body: { error: approvable.reason, code: approvable.code } } }
      }
      const reassessed = checkReassessment(approvableOf(candidate), expected.assessmentFingerprint)
      if (!reassessed.ok) {
        return { abort: { status: 409, body: { error: reassessed.reason, code: reassessed.code } } }
      }

      const account = aiAccountFor(bindingsOf(config), session.platform)?.account
      const publishingAccount = (account?.accountId ?? account?.displayName ?? '').trim()
      if (publishingAccount === '') {
        return {
          abort: {
            status: 409,
            body: {
              error:
                '还没有为这个平台绑定 AI 发帖账号，无法创建批准：发布时无法确认用哪个账号发言。' +
                '请在「贴吧账号」区域填写 AI 账号后重试。',
              code: 'account_unbound',
            },
          },
        }
      }

      // Every half of the binding must match what the page claimed to be showing,
      // compared against the document this transaction is about to write.
      const compared = checkExpectation(expected, {
        sessionId: session.id,
        candidateId: candidate.replyId,
        candidateVersion: candidate.candidateVersion ?? 0,
        platform: session.platform,
        targetPostId: candidate.targetPostId,
        publishingAccount,
        textHash: hashText(candidate.text),
        assessmentFingerprint: approvable.fingerprint,
      })
      if (!compared.ok) {
        return { abort: { status: 409, body: { error: compared.reason, code: compared.code } } }
      }

      const binding = bindingOf({
        sessionId: session.id,
        candidateId: candidate.replyId,
        platform: session.platform,
        targetPostId: candidate.targetPostId,
        publishingAccount,
        text: candidate.text,
        candidateVersion: candidate.candidateVersion ?? 0,
        assessmentFingerprint: approvable.fingerprint,
      })

      // One live approval per candidate: an earlier un-consumed one is superseded, so
      // the owner cannot accumulate records and later wonder which one authorises
      // what. Consumed records are history and stay.
      //
      // Read from `data`, not from `getApprovals()`: a record created by another
      // process a moment ago must be superseded too, and this is the fresh copy.
      const record = createApproval(binding, 'owner', () => Date.now())
      const approvals = (data.approvals ?? []).filter(
        // Keep consumed records (they are publish history) and drop every *live*
        // record for this candidate — including ones this transaction did not just
        // create, which is what keeps two concurrent approvals from both leaving an
        // authorising record behind.
        (row) =>
          row.consumedAt !== undefined ||
          row.sessionId !== session.id ||
          row.candidateId !== candidate.replyId,
      )
      approvals.push(record)

      return {
        commit: { ...data, approvals },
        value: {
          status: 200,
          body: {
            approved: true,
            approvalId: record.id,
            expiresAt: new Date(Date.parse(record.grantedAt) + 30 * 60 * 1000).toISOString(),
          },
        } satisfies ApprovalVerdict,
      }
    })

    return outcome.value
  }

  /**
   * Candidates waiting for the owner's approval.
   *
   * ## Why it is derived, not stored
   *
   * "Waiting for approval" is not a flag anyone sets; it is the conjunction of facts the
   * store already holds: the session is in a state that can still publish, the candidate
   * carries an assessment that is `allow` or `review` (never `block`), and no live
   * approval exists for it yet. Deriving it means the list cannot drift out of sync with
   * the publish path — the two read the same store and the same assessment.
   *
   * ## Why an already-approved candidate drops out
   *
   * Otherwise the button would stay on screen after a successful click and the owner
   * would approve the same reply repeatedly, accumulating records that all describe the
   * same attempt. The publisher would only spend one, but the page would be lying about
   * what is still pending.
   */
  const listPendingApprovals = async (): Promise<PendingApprovalsView> => {
    // ## Read the file, not the cache (v0.2.8)
    //
    // This list is the one thing on the settings page that changes because of work
    // happening *elsewhere* — the agent generates a candidate in a different
    // conversation, possibly in a different Host process. This instance's `data` is a
    // cache from whenever it last read; reporting it as the pending list means a
    // candidate created one process away is invisible until a restart, and the owner
    // concludes there is nothing to approve.
    //
    // `refreshFromDisk` is the same call the publish path makes before deciding
    // whether a dedupe record exists, so both sides read the same document.
    await runtimeView.store.refreshFromDisk()
    const staleness = runtimeView.store.staleness
    if (staleness !== undefined) {
      // A failed refresh must not render as an empty list. The owner would read "nothing
      // is waiting for approval" from a document that may be corrupt, missing, or held
      // by another writer — and then wonder why the agent says otherwise.
      return {
        ok: false,
        reason: staleness.reason,
        ...(staleness.code === undefined ? {} : { code: staleness.code }),
      }
    }

    const now = Date.now()
    const config = effectiveConfig()
    const approvals = runtimeView.store.getApprovals()

    const out: PendingApprovalView[] = []
    for (const session of runtimeView.store.snapshot().sessions) {
      // Only a session that can still publish needs a decision. A published, cancelled
      // or paused one is not waiting for approval — it is waiting for something else,
      // and listing it would send the owner to a button that cannot help.
      if (session.state !== 'READY' && session.state !== 'NEEDS_CONFIRMATION') continue

      // Resolved once per session, exactly as the approve route will resolve it, so
      // the expectation the page echoes back is the account the publish will really
      // use. Two resolutions would let the two disagree.
      const account = aiAccountFor(bindingsOf(config), session.platform)?.account
      const publishingAccount = (account?.accountId ?? account?.displayName ?? '').trim()

      for (const candidate of session.candidates) {
        const verdict = candidate.security?.decision
        if (verdict !== 'allow' && verdict !== 'review') continue

        // The expectation is built from stored values only. If any of them is
        // missing the row is still listed (the owner should see the candidate) but
        // without an `expected` block, which makes the approve route refuse it for
        // being unsnapshotted rather than binding an approval to a guess.
        const fingerprint = candidate.security?.fingerprint
        const expectation =
          fingerprint === undefined || publishingAccount === ''
            ? undefined
            : {
                sessionId: session.id,
                candidateId: candidate.replyId,
                candidateVersion: candidate.candidateVersion ?? 0,
                platform: session.platform,
                targetPostId: candidate.targetPostId,
                publishingAccount,
                textHash: hashText(candidate.text),
                assessmentFingerprint: fingerprint,
              }

        // ## Whether this row is already authorised (v0.2.9)
        //
        // v0.2.8 answered that with `sessionId + candidateId`. That is the *identity*
        // of the row, not the *authorisation*: it cannot tell "this exact text was
        // approved" from "something with this id was approved at some point". So a
        // stale approval — granted for the previous body, the previous target, the
        // previous account, or a superseded assessment — still hid the row, and the
        // owner saw a candidate with no button while the approve route would have
        // refused the record it was hiding behind.
        //
        // `checkApproval` is the same function the publish path uses, so this list
        // cannot drift from it: a row is treated as authorised only when the stored
        // record would actually authorise a publish *right now* — matching text hash,
        // version, target, platform, account and assessment fingerprint, and still
        // within its TTL and neither consumed nor revoked.
        //
        // When the expectation is unavailable (no fingerprint or no bound account) the
        // row is listed regardless: there is no binding to compare, and listing it
        // with the "cannot approve" note is more honest than hiding the candidate.
        const authorising =
          expectation === undefined
            ? undefined
            : approvals.find(
                (record) =>
                  record.sessionId === session.id &&
                  record.candidateId === candidate.replyId &&
                  checkApproval(record, expectation, () => now).ok,
              )
        if (authorising !== undefined) continue

        out.push({
          sessionId: session.id,
          candidateId: candidate.replyId,
          platform: session.platform,
          threadTitle: session.threadTitle,
          threadUrl: session.threadUrl,
          targetPostId: candidate.targetPostId,
          text: candidate.text,
          candidateVersion: candidate.candidateVersion ?? 0,
          verdict,
          createdAt: candidate.createdAt,
          ...(fingerprint === undefined ? {} : { assessmentFingerprint: fingerprint }),
          ...(expectation === undefined ? {} : { expected: expectation }),
          reason:
            expectation === undefined
              ? '这条候选缺少批准所需的快照（安全评估指纹或 AI 发帖账号），无法批准。' +
                '请在「贴吧账号」里补上 AI 账号，或重新生成一次候选。'
              : verdict === 'review'
                ? '安全闸门把它标记为「需要人工确认」：必须由你看过正文后批准，任何自动模式都不能替你做这个决定。'
                : '当前是人工审核模式：通过自动检查的候选也需要你批准才能发表。',
        })
      }
    }
    // Newest first: the reply the owner just generated is the one they are looking at.
    return { ok: true, rows: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  }

  const settingsRouteDeps: SettingsRouteDeps = {    authorize: authorizer,
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
    approve: createApprovalForSettings,
    pendingApprovals: listPendingApprovals,
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
