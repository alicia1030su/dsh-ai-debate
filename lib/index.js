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
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, DEFAULT_CONFIG, resolveConfig } from './config.js';
import { loggerOf } from './host.js';
import { DebateStore } from './store.js';
import { buildLlm, makeAdapter, policyFromConfig, cancelInFlight, inFlightPublishCount, stopSession, } from './runtime.js';
import { buildTools } from './tools.js';
import { collectDiagnostics, checkLogin, previewPersonas, testModel, PLUGIN_VERSION } from './diagnostics.js';
import { TERMINAL_STATES } from './store.js';
import { makeSettingsRoutes, } from './settings-routes.js';
import { EMPTY_OVERLAY, SECRET_REFS, findCredentialSeam, loadOverlay, } from './secrets.js';
/** Stable Loader identity; matches the row id in `cordis.patch.yml`. */
export const name = 'dsh-ai-debate';
/** Services required before the tools can mount. */
export const inject = ['tools', 'systemPrompt'];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 170;
/**
 * How long to wait before re-reading a store that answered "nothing at all".
 *
 * `dsh-credentials-local` publishes the service and then runs `loadInitial()`,
 * one file read. This pause covers that window on a settings-page load without
 * turning a genuinely empty store into a long stall: one retry, 40 ms, and if
 * the second read also finds nothing, that answer is taken as the truth.
 */
const CREDENTIAL_WARMUP_MS = 40;
/** Re-export the config schema so the Host can render settings. */
export { Config, DEFAULT_CONFIG, resolveConfig };
/** What the agent is told about this plugin. */
export const DEBATE_GUIDANCE = '本机已安装 dsh-ai-debate 插件（AI代吵架）：读取百度贴吧帖子与楼中楼，还原主人和对手的争论，' +
    '按选定人格起草接话，经主人确认后再发表。\n' +
    '工具：debate_bind_owner（绑定主人/AI 账号）、debate_set_personality（选人格）、' +
    'debate_analyze_thread（读整帖并分析）、debate_analyze_reply（锁定某条回复分析）、' +
    'debate_generate_reply（生成候选）、debate_publish_reply（确认后发表）、' +
    'debate_get_session（查会话）、debate_stop_session（停止）、debate_health_check（健康检查）。\n' +
    '典型流程：绑定 → 分析（返回 sessionId）→ 生成候选 → 把候选正文原样交给主人看 → ' +
    '主人同意后才调用 debate_publish_reply 并传 confirm=true。\n' +
    '注意：发表是真实写操作，必须由主人明确同意；贴吧的艾特通知读取不可用，请让主人提供帖子链接手动召唤。';
/** Resolve the state directory from config, creating it. */
export function resolveStoreDir(config) {
    const dir = config.storeDir || join(homedir(), '.dsh', 'ai-debate');
    mkdirSync(dir, { recursive: true });
    return dir;
}
/** Build the runtime synchronously; disk reads happen on first use. */
export function buildRuntime(resolve, log) {
    const config = resolve();
    const store = new DebateStore({
        dir: resolveStoreDir(config),
        sessionTtlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000,
    });
    return {
        adapter: makeAdapter(config),
        store,
        policy: policyFromConfig(config),
        config: resolve,
        llm: () => buildLlm(resolve()),
        log: (level, message) => {
            log[level](message);
        },
    };
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
];
/** A stable key for the adapter-relevant part of a config snapshot. */
function adapterKey(config) {
    return ADAPTER_FIELDS.map((field) => String(config[field] ?? '')).join('\u0000');
}
/**
 * Best-effort read of the Harness version, for the diagnostics panel.
 *
 * Probed rather than required: the version lives in different services across
 * releases, and a missing version is a blank line in the panel, not a reason to
 * fail a mount.
 */
function readDshVersion(ctx) {
    const probe = ctx;
    if (typeof probe.get !== 'function')
        return undefined;
    for (const key of ['desktopVersion', 'hostVersion', 'appInfo', 'version']) {
        try {
            const value = probe.get(key, false);
            if (typeof value === 'string' && value.length > 0)
                return value;
            if (typeof value === 'object' && value !== null) {
                const version = value.version;
                if (typeof version === 'string' && version.length > 0)
                    return version;
            }
        }
        catch {
            // A missing service is expected; keep probing.
        }
    }
    return undefined;
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
function applyOverlay(config, overlay) {
    const cookie = overlay.cookie || config.tiebaCookie;
    const llmApiKey = overlay.llmApiKey || config.llmApiKey;
    if (cookie === config.tiebaCookie && llmApiKey === config.llmApiKey)
        return config;
    return { ...config, tiebaCookie: cookie, llmApiKey };
}
/**
 * Mount the plugin.
 *
 * @param ctx the Host plugin context
 * @param config raw plugin config; volatile fields arrive as references
 * @returns the disposer that unmounts everything
 */
export function apply(ctx, config) {
    const log = loggerOf(ctx, 'dsh-ai-debate');
    const dshVersion = readDshVersion(ctx);
    /**
     * Credential values, mirrored so the synchronous config reader can see them.
     *
     * `ctx.credentials` is async and `resolveConfig` is not, so the two are bridged
     * by an overlay that is refreshed on mount and on every credential change.
     * Until the first refresh lands the overlay is empty, which means the legacy
     * config fields apply — the same behaviour v0.1.5 had, so a slow or missing
     * credential service degrades to the old path rather than to no credentials.
     *
     * `overlayStale` records that the mirror has not landed yet. It exists because
     * the one-shot load at mount is not enough: on a cold start the credential
     * store can answer `describe()` (it sees the record) while `resolve()` still
     * returns nothing, and the mount-time read then caches "no credentials" for
     * the rest of the process. That was v0.1.9's bug — after a restart the plugin
     * behaved as if no cookie had ever been saved until something wrote a secret
     * and triggered a re-read.
     */
    let overlay = EMPTY_OVERLAY;
    let overlayStale = true;
    const seam = findCredentialSeam(ctx);
    /** The resolved config with credential-store values folded in. */
    const effectiveConfig = () => applyOverlay(resolveConfig(config), overlay);
    // Rebuilt on every read so a live settings edit takes effect without a
    // remount — that is what `.volatile()` fields are for.
    let runtime = buildRuntime(effectiveConfig, log);
    let currentKey = adapterKey(effectiveConfig());
    let disposed = false;
    /**
     * The runtime for the *current* config.
     *
     * When the cookie or a request parameter changed, the adapter is rebuilt and
     * the previous one is dropped. Sessions are not touched: they describe what was
     * read, and their stored targets are re-verified before any publish anyway.
     */
    const currentRuntime = () => {
        if (disposed)
            throw new Error('插件已卸载，不能继续调用');
        const next = effectiveConfig();
        const key = adapterKey(next);
        if (key !== currentKey) {
            log.info('配置或凭据中的贴吧请求参数已变化，正在重建平台适配器');
            runtime = buildRuntime(effectiveConfig, log);
            currentKey = key;
        }
        return runtime;
    };
    /**
     * Re-read the credential store and install the result.
     *
     * Public through the routes so a save made in the browser takes effect on the
     * very next tool call, without a page reload or a plugin remount.
     *
     * On a cold start the service is already reachable but its document is not
     * parsed yet, so this first read legitimately returns "nothing configured" —
     * and the very next `describe()` call, microseconds later inside the same
     * response, answers `configured: true`. That mismatch is what made v0.1.9's
     * settings page show "已配置" next to a length of 0. Waiting briefly and
     * reading once more closes the window: `loadInitial()` is a single file read,
     * not an unbounded wait, so one short retry is enough and stays honest — if
     * the store is genuinely empty, the second read simply agrees with the first.
     */
    const refreshSecrets = async (options) => {
        if (disposed)
            return;
        let loaded = await loadOverlay(seam);
        if (options?.retryIfEmpty === true && loaded.empty && loaded.error === undefined) {
            // Only the route path asks for this: a human opened a page, so a 40 ms
            // pause is invisible and worth it. Tool calls keep the non-blocking path.
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, CREDENTIAL_WARMUP_MS);
                if (typeof timer === 'object' && timer !== null && 'unref' in timer)
                    timer.unref();
            });
            if (disposed)
                return;
            loaded = await loadOverlay(seam);
        }
        overlay = loaded.overlay;
        // Untrustworthy when the load failed outright, when the store admits to
        // holding a value whose body did not come back, or when nothing resolved at
        // all. The last case is the v0.1.9 cold-start bug: `ctx.credentials` is
        // exposed before its document is parsed, so the plugin's first load sees a
        // genuinely empty Map — indistinguishable from "no credentials saved" by
        // inspection — and v0.1.9 froze that empty mirror for the whole process.
        overlayStale =
            seam !== undefined &&
                (loaded.error !== undefined || (loaded.unresolved?.length ?? 0) > 0 || loaded.empty);
        // A load that finally brought something back clears the retry budget, so a
        // later cold start still gets its own bounded attempts.
        if (!overlayStale)
            staleAttempts = 0;
        // Re-key eagerly: the adapter holds a cookie jar, so a rotated cookie must
        // invalidate it now rather than on whichever call happens to read next.
        currentRuntime();
        if (loaded.error !== undefined)
            log.warn(`读取凭据失败：${loaded.error}`);
    };
    /**
     * Re-read once per consumer call while the mirror is still untrustworthy.
     *
     * Bounded on purpose: a deployment with genuinely no credentials must not hit
     * the store on every tool call forever. After the first successful non-empty
     * load, or after `MAX_STALE_RETRIES` attempts, the mirror is taken as truth
     * and only credential-change events refresh it again.
     */
    let staleAttempts = 0;
    const MAX_STALE_RETRIES = 5;
    const ensureSecretsFresh = async () => {
        if (!overlayStale || seam === undefined || disposed)
            return;
        if (staleAttempts >= MAX_STALE_RETRIES)
            return;
        staleAttempts += 1;
        await refreshSecrets();
    };
    // Refuse to do anything when the plugin is switched off.
    const assertEnabled = (action) => {
        const value = effectiveConfig();
        if (!value.enabled) {
            throw new Error(`插件当前是关闭状态（enabled=false），不能${action}。` +
                '请在插件设置里打开后再试；关闭状态下不会读取帖子、不会调用模型、也不会发表。');
        }
    };
    const runtimeView = {
        get adapter() {
            return currentRuntime().adapter;
        },
        get store() {
            return currentRuntime().store;
        },
        get policy() {
            return policyFromConfig(effectiveConfig());
        },
        config: () => {
            // A cold start can leave the mirror empty even though the store has a
            // value (v0.1.9 bug). Kick a bounded re-read; the CURRENT call still sees
            // the old mirror, but it no longer poisons every later call, and the
            // routes refresh synchronously before answering.
            void ensureSecretsFresh().catch(() => undefined);
            assertEnabled('执行操作');
            return effectiveConfig();
        },
        llm: () => buildLlm(effectiveConfig()),
        log: (level, message) => {
            log[level](message);
        },
    };
    const tools = buildTools(runtimeView, ctx);
    const disposers = [];
    const register = (label, execute) => {
        if (typeof ctx.effect === 'function') {
            disposers.push(ctx.effect(execute, label));
            return;
        }
        const dispose = execute();
        if (typeof dispose === 'function')
            disposers.push(dispose);
    };
    register('dsh-ai-debate: tools', () => {
        const offs = tools.map((tool) => ctx.tools.register(tool));
        return () => {
            for (const off of offs)
                off();
        };
    });
    register('dsh-ai-debate: announcement', () => {
        const value = effectiveConfig();
        if (!value.enabled || !value.announceToAgent)
            return;
        return ctx.systemPrompt.section({
            name: 'plugin:dsh-ai-debate',
            order: SECTION_ORDER,
            text: DEBATE_GUIDANCE,
        });
    });
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
    const authorizer = (request) => {
        const connection = ctx.get?.('connection', false);
        if (connection === undefined || connection === null)
            return 403;
        if (typeof connection.requestRejection !== 'function')
            return 403;
        const rejection = connection.requestRejection({ headers: request.headers });
        return rejection === undefined ? 'ok' : rejection;
    };
    /**
     * Stop every live session and abort every publish still in flight.
     *
     * The plugin has no scheduler, so "pause all automatic tasks" has no queue to
     * switch off. What it does have is real work in progress, and this stops it:
     * terminal sessions already have their outcome recorded and are left exactly
     * as they are; a reply that already reached the platform stays recorded as
     * published, because cancelling is not an undo.
     */
    const stopAllActive = async () => {
        await runtime.store.ready();
        const stopped = [];
        const refused = [];
        let alreadyPublished = 0;
        let abortedInFlight = 0;
        for (const session of runtime.store.snapshot().sessions) {
            // A reply that already reached the platform is reported, never hidden and
            // never "withdrawn": cancelling stops future work, it is not an undo.
            if (session.publishedPostIds.length > 0)
                alreadyPublished += 1;
            if (TERMINAL_STATES.includes(session.state))
                continue;
            // Count what is actually in flight *before* aborting it. Reporting the
            // number of stopped sessions here would overstate the abort: a session
            // that had not started sending has nothing to abort.
            const inFlight = inFlightPublishCount(session.id);
            abortedInFlight += inFlight;
            // Signal first, so a publish that is still validating stops before it
            // becomes a network request.
            cancelInFlight(session.id);
            try {
                await stopSession(runtime, session.id, '主人在设置页点了「立即暂停」');
                stopped.push(session.id);
            }
            catch (error) {
                refused.push({
                    sessionId: session.id,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return { stopped, refused, abortedInFlight, alreadyPublished };
    };
    const settingsRouteDeps = {
        authorize: authorizer,
        // The page must not be told "unconfigured" because the mirror loaded too
        // early. This is the visible half of the v0.1.9 bug: after a restart the
        // badge said the cookie was missing while the store had it all along.
        //
        // A route read is a deliberate, human-paced action, so it re-reads
        // unconditionally instead of going through the bounded `ensureSecretsFresh`
        // retry budget: the budget exists to stop tool calls from hammering the
        // store forever, and must never be the reason an open settings page shows
        // stale state. Reads are cheap (an in-memory Map when the store is loaded),
        // and the empty-result retry covers the cold-start window.
        refreshSecrets: async () => {
            await refreshSecrets({ retryIfEmpty: true });
        },
        config: () => effectiveConfig(),
        credentials: () => seam,
        overlay: () => overlay,
        settings: () => {
            const candidate = ctx.get?.('settings', false);
            if (candidate === undefined || candidate === null)
                return undefined;
            const service = candidate;
            if (typeof service.update !== 'function' || typeof service.mutate !== 'function')
                return undefined;
            return {
                writable: service.writable !== false,
                update: (namespace, patch) => service.update(namespace, patch),
                mutate: (namespace, ops) => service.mutate(namespace, ops),
            };
        },
        namespace: () => name,
        testModel: async () => {
            try {
                return await testModel(runtimeView, effectiveConfig());
            }
            catch (error) {
                return {
                    ok: false,
                    baseUrl: effectiveConfig().llmBaseUrl,
                    model: effectiveConfig().llmModel,
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        },
        checkLogin: async () => {
            try {
                return await checkLogin(runtimeView);
            }
            catch (error) {
                return {
                    ok: false,
                    authenticated: false,
                    message: error instanceof Error ? error.message : String(error),
                    cookieNames: [],
                };
            }
        },
        previewPersonas: () => previewPersonas(effectiveConfig()),
        stopAllActive,
        diagnostics: async () => {
            const report = await collectDiagnostics(runtimeView, effectiveConfig());
            return { ...report, pluginVersion: PLUGIN_VERSION, ...(dshVersion === undefined ? {} : { dshVersion }) };
        },
    };
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
    const ctxInjectable = ctx;
    if (typeof ctxInjectable.inject === 'function') {
        register('dsh-ai-debate: settings routes', () => {
            let disposeScope;
            ctxInjectable.inject(['webServer'], (scope) => {
                const server = scope.get?.('webServer');
                if (server === undefined || server === null || typeof server.register !== 'function') {
                    log.debug('webServer 已注入但没有 register 方法，配置页路由未注册（工具不受影响）');
                    return;
                }
                const routes = makeSettingsRoutes(settingsRouteDeps);
                const offs = routes.map((route) => server.register(route));
                // The injected scope's own effect owns the route lifetime: routes go away
                // with the service, and a service restart registers them again.
                const disposeRoutes = () => {
                    for (const off of offs)
                        off();
                };
                disposeScope =
                    typeof scope.effect === 'function'
                        ? scope.effect(() => disposeRoutes, 'dsh-ai-debate: settings routes')
                        : disposeRoutes;
            });
            return () => {
                disposeScope?.();
                disposeScope = undefined;
            };
        });
    }
    else {
        // A host without the injectable-context contract: fall back to the one-shot
        // probe, so the routes still register when the service is already up.
        register('dsh-ai-debate: settings routes', () => {
            const webServer = ctx.get?.('webServer', false);
            if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
                log.debug('本部署没有 webServer 服务，配置页路由没有注册（工具不受影响）');
                return;
            }
            const routes = makeSettingsRoutes(settingsRouteDeps);
            const offs = routes.map((route) => webServer.register(route));
            return () => {
                for (const off of offs)
                    off();
            };
        });
    }
    // ---- credential subscription ---------------------------------------------
    //
    // Rotating a secret must reach the next request without a reload, and the
    // adapter holds a cookie jar, so the refresh also re-keys the runtime. The
    // subscription is optional: a deployment without credentials simply never
    // fires one, and the config fallbacks stay in force.
    if (seam !== undefined) {
        const ctxWithEvents = ctx;
        if (typeof ctxWithEvents.on === 'function') {
            register('dsh-ai-debate: credential updates', () => {
                const offs = SECRET_REFS.map((ref) => ctxWithEvents.on('credentials/reference-updated', (updated) => {
                    if (updated !== undefined && updated !== ref)
                        return;
                    void refreshSecrets().catch((error) => {
                        log.warn(`凭据更新后重建失败：${error instanceof Error ? error.message : String(error)}`);
                    });
                }));
                return () => {
                    for (const off of offs)
                        off();
                };
            });
        }
        // The first read is fire-and-forget: mount must stay synchronous, and the
        // config fallbacks already make the plugin usable until it lands.
        void refreshSecrets().catch((error) => {
            log.warn(`首次读取凭据失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }
    return () => {
        if (disposed)
            return;
        disposed = true;
        for (const dispose of disposers.splice(0).reverse()) {
            try {
                dispose();
            }
            catch (error) {
                log.warn(`卸载 ${name} 时出错：${error.message}`);
            }
        }
        runtime = undefined;
    };
}
//# sourceMappingURL=index.js.map