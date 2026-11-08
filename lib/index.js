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
import { Config, DEFAULT_CONFIG, resolveConfig } from './config.js';
import { loggerOf } from './host.js';
import { DebateStore } from './store.js';
import { buildVerificationService } from './verification-service.js';
import { verificationViewOf } from './verification-view.js';
import { adapterVersionOfAdapter, effectiveCapability } from './capability-evidence.js';
import { approvalStillApplies, deriveWorkbenchState } from './workbench.js';
import { policyFromConfig, cancelInFlight, editCandidate, inFlightPublishCount, runAnalysis, runGeneration, runPublish, stopSession, } from './runtime.js';
import { buildTools } from './tools.js';
import { chooseModelSource } from './model-source.js';
import { hostLlmOf, probeHostLlm } from './host-llm.js';
import { EgressGuard, EgressLog, egressPolicyOf } from './net-audit.js';
import { join } from 'node:path';
import { resolveStoreDirStrict } from './store-dir.js';
import { MAX_STORED_COMMENTS } from './store.js';
import { PlatformRegistry } from './platforms/registry.js';
import { __setHttpEgressGate } from './platforms/http.js';
import { __setAuthHostEgressGate } from './platforms/weibo/network-state.js';
import { __setCliEgressVeto } from './platforms/weibo/cli.js';
import { tiebaProvider } from './platforms/tieba/provider.js';
import { weiboProvider } from './platforms/weibo/provider.js';
import { sourceOf } from './import/source.js';
import { parseImport, toCollectedThread } from './import/manual.js';
import { toStoredImport, MAX_IMPORTED_CHARS, collectedFromStored, correctedDiscussion } from './import/session.js';
import { applyCorrections, sanitizeCorrections } from './import/corrections.js';
import { describeCollected, describeImport, targetContextOf } from './import/preview.js';
import { comparePersonas } from './import/compare.js';
import { analyzeImport, approveImportedCandidate, copyReply, editImportedCandidate, generateForImport, personaOf, reselectImport, reviseImport, } from './import/workflow.js';
import { completedSteps, personaOptions, stepOf, MANUAL_STEP_ORDER, STEP_TITLES as MANUAL_STEP_TITLES, } from './import/workflow.js';
import { PLATFORM_MANIFESTS } from './platforms/manifests.js';
import { CAPABILITY_NAMES, markOf, stateOf } from './platforms/contracts.js';
import { AdapterManager } from './platforms/adapter-manager.js';
import { platformSettingsOf } from './runtime.js';
/**
 * The account this deployment would post as, per platform (v0.2.21 §三.9).
 *
 * Read through the same `bindingsOf()` the publish path uses to stamp a candidate's expected
 * account — if this resolved the id differently, the gate would compare evidence against one
 * account while the sender posted as another. `platformSettingsOf` is *not* the right source:
 * it is the adapter's settings bag, and for any platform other than tieba it carries no account
 * at all, which would have made every non-tieba capability permanently unverifiable.
 */
function configuredAccountOf(config, platform) {
    // `aiAccountFor` returns `{ platform, account: PlatformAccount }`, and the id lives on
    // `.account.accountId` — absent when only a display name was configured, in which case there
    // is no id to bind evidence to and returning '' is the honest answer.
    const bound = aiAccountFor(bindingsOf(config), platform)?.account?.accountId;
    if (typeof bound === 'string' && bound.trim() !== '')
        return bound.trim();
    // The tieba legacy field, kept because a v0.1.5 profile stores its AI account there and the
    // binding parser may not have picked it up.
    const settings = platformSettingsOf(config, platform);
    for (const key of ['aiAccountUserId', 'accountUserId', 'userId']) {
        const value = settings[key];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return undefined;
}
/**
 * The capability state the publish gate would compute, for display.
 *
 * Reads the same declaration and the same evidence the gate reads, through the same function.
 * It is deliberately a separate call rather than a cached field: the gate recomputes on every
 * publish, and a page showing a value computed at a different moment could differ from the
 * answer the publish gets.
 */
/**
 * Which capability a publish of this session would need.
 *
 * Mirrors `capabilityForSession` in `publisher.ts` — the function the publish path itself
 * uses — rather than assuming `comment.publish`. The two must agree or the page describes a
 * different gate from the one that will actually run: v0.2.26 shipped with this hard-wired to
 * `comment.publish` while the publish path read the candidate's snapshot, so a nested reply
 * was described as a new comment, its capability row said `unverified` for the wrong name,
 * and the verification the owner had just completed for `comment.reply` appeared not to count.
 */
function capabilityNameForSession(session, candidate) {
    // The candidate wins, because that is the value the publish path reads: a reply written
    // against a picked comment carries `nested` in its snapshot even when the session was
    // originally summoned by a floor post.
    const kind = candidate?.targetSnapshot?.targetKind ?? session?.targetKind ?? 'nested';
    return kind === 'nested' ? 'comment.reply' : 'comment.publish';
}
function capabilityFor(runtime, platform, name = 'comment.publish') {
    /**
     * ## 未注册的平台不是错误，是「没有这个平台」
     *
     * `capabilitiesOf` 对未注册的 id **抛错**（`PlatformNotRegisteredError`），而这里是
     * 给页面算一个展示用的能力快照。v0.2.30 人工导入的会话平台是 `manual` —— 它按设计
     * 就不在注册表里（没有发表路径）。于是一读工作台就抛，页面拿到的是
     * 「读取工作台状态失败：平台「manual」没有注册」，**整条离线流程在页面上根本
     * 显示不出来**：步骤、候选、复制按钮全部消失，只剩下这句看起来像故障的话。
     *
     * 这不是「注册表缺了一项」，是这个会话本来就没有可发表的平台。所以接住它，
     * 返回 `unavailable` 并说明原因。发表路径本身不依赖这个返回值：那条路
     * `adapterFor` 会抛，是另一道结构性闸门。
     */
    let matrix;
    let missingPlatform = false;
    try {
        matrix = runtime.platforms?.capabilitiesOf(platform);
    }
    catch {
        matrix = undefined;
        missingPlatform = true;
    }
    const declared = matrix === undefined ? 'unavailable' : stateOf(matrix, name).state;
    if (declared === 'unavailable' || declared === 'permission_required' || declared === 'supported') {
        return {
            declared,
            effective: declared,
            reason: matrix === undefined
                ? missingPlatform
                    ? `${platform} 不是一个已注册的平台，这个会话没有可发表的平台`
                    : `${platform} 没有声明任何能力`
                : stateOf(matrix, name).reason,
        };
    }
    const accountId = configuredAccountOf(runtime.config(), platform) ?? '';
    let adapterVersion = '';
    try {
        const adapter = runtime.platforms?.adapterFor(platform);
        adapterVersion = adapter === undefined ? '' : adapterVersionOfAdapter(adapter);
    }
    catch {
        adapterVersion = '';
    }
    if (adapterVersion === '') {
        return { declared, effective: declared, reason: `${platform} 的适配器当前不可用，无法确定代码版本` };
    }
    const records = runtime.store
        .getVerificationRecords()
        .filter((record) => record.outcome === 'succeeded')
        .map((record) => ({
        platform: record.platform,
        capability: record.capability,
        accountId: record.authorizedAccountId,
        adapterVersion: record.adapterVersion ?? '',
        verifiedAt: record.startedAt,
        method: 'live',
        readBackComplete: record.readBack !== undefined &&
            record.readBack.postFound &&
            record.readBack.authorMatched &&
            record.readBack.textMatched &&
            record.readBack.parentMatched,
    }));
    const decision = effectiveCapability(declared, { platform, capability: name, accountId, adapterVersion }, records);
    return { declared, effective: decision.effective, reason: decision.reason };
}
/**
 * The account the live session currently reports **for one platform**, or `undefined`.
 *
 * ## Why this must go through the platform's own adapter (v0.2.22 §七)
 *
 * v0.2.21 wrote this as `checkLogin(runtimeView)`, which asks `runtime.adapter` — the *default*
 * platform's adapter. With more than one platform registered, that meant every platform's
 * "live account" was in fact Tieba's answer. The consequences are the kind that look like
 * working software: a Weibo verification would be refused as `account_mismatch` against a Tieba
 * id, and — worse in the other direction — a capability gate would bind evidence to an account
 * the platform in question never reported.
 *
 * Asking the platform's own adapter is the only version that can be extended to a second
 * platform without inventing an identity, which is exactly what §七 asks for. No probe result is
 * ever reused across platforms: an unregistered adapter answers `undefined`, and `undefined` is
 * a refusal in `checkVerification`.
 *
 * ## What "unknown" covers
 *
 * Not registered, probe threw, not authenticated, and authenticated-without-an-id are four
 * different routes to the same answer. They are deliberately not distinguished here — the
 * caller (`checkVerification`) already refuses on `undefined`, and a per-route message would be
 * a second place deciding whether publishing may happen.
 */
async function liveAccountOf(runtime, platform, 
/**
 * A thread known to be readable, used as the login probe.
 *
 * Verification already knows which thread the owner authorised, and asking
 * `checkAuthentication()` with no argument left the probe list empty — the adapter then
 * had nothing to read and reported "cannot determine the logged-in account" on every
 * run, so no capability could ever be verified in a deployment where the adapter has no
 * default probe thread configured. Passing the authorised thread reuses a page the run
 * is about to touch anyway.
 */
probeThreadId) {
    let adapter;
    try {
        adapter = runtime.platforms?.adapterFor(platform);
    }
    catch {
        return undefined;
    }
    if (adapter === undefined)
        return undefined;
    try {
        const probe = probeThreadId === undefined || probeThreadId === ''
            ? await adapter.checkAuthentication()
            : await adapter.checkAuthentication(undefined, probeThreadId);
        if (probe.authenticated !== true)
            return undefined;
        if (typeof probe.userId === 'string' && probe.userId.trim() !== '')
            return probe.userId.trim();
    }
    catch {
        // A probe that throws means "unknown", which refuses the run — the safe direction.
    }
    return undefined;
}
/**
 * Decide how far a platform's read path has been proven, from its own declarations.
 *
 * ## Why `implemented` alone was not enough (v0.2.28)
 *
 * `implemented` is `supported || unverified`, which for Weibo is true on day one:
 * the adapter exists and every row honestly says "written, never run". The page then
 * painted 「已接入」 green next to Tieba, which has been run against the real site.
 * Two very different situations, one badge — and the one that needed the owner's
 * attention was the one that looked finished.
 *
 * The rules below read the capability matrix, which is the only place that knows:
 *
 * - any read row `supported` → `verified`;
 * - any read row `degraded` → `verified`, with the reason carried (it ran, partly);
 * - any read row `permission_required` → `needs_permission`;
 * - any read row `unverified` → `untested`;
 * - nothing readable at all → `unavailable`.
 *
 * `needs_login` is not derivable from a static declaration — it is a runtime fact the
 * probe reports — so it is not produced here. Saying so beats inventing a state the
 * host cannot actually observe.
 */
function readinessOf(matrix) {
    const READ_ROWS = [
        'thread.read',
        'comment.list',
        'comment.paginate',
        'comment.nested',
        'comment.locate',
    ];
    const rows = READ_ROWS.map((name) => ({ name, declaration: stateOf(matrix, name) }));
    const supported = rows.find((row) => row.declaration.state === 'supported');
    if (supported !== undefined) {
        return { readiness: 'verified', reason: `${supported.name}：${supported.declaration.reason}` };
    }
    const degraded = rows.find((row) => row.declaration.state === 'degraded');
    if (degraded !== undefined) {
        return {
            readiness: 'verified',
            reason: `${degraded.name} 能在真实平台跑通但有降级：${degraded.declaration.reason}`,
        };
    }
    const needsPermission = rows.find((row) => row.declaration.state === 'permission_required');
    if (needsPermission !== undefined) {
        return {
            readiness: 'needs_permission',
            reason: `${needsPermission.name} 需要授权：${needsPermission.declaration.reason}`,
        };
    }
    const untested = rows.find((row) => row.declaration.state === 'unverified');
    if (untested !== undefined) {
        return {
            readiness: 'untested',
            reason: `${untested.name} 已实现但从未在真实平台跑通：${untested.declaration.reason}`,
        };
    }
    return {
        readiness: 'unavailable',
        reason: rows[0]?.declaration.reason ?? '这个平台没有声明任何可用的读取能力。',
    };
}
/**
 * Flatten a capability matrix into the row shape the settings page renders.
 *
 * Iterating {@link CAPABILITY_NAMES} rather than the matrix's own keys means a
 * platform that forgot to declare a capability still shows a row — with the
 * honest `unavailable` state — instead of silently omitting it.
 */
function flattenCapabilities(matrix) {
    return CAPABILITY_NAMES.map((name) => {
        const declaration = stateOf(matrix, name);
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
        };
    });
}
import { collectDiagnostics, checkLogin, previewPersonas, testModel, PLUGIN_VERSION } from './diagnostics.js';
import { TERMINAL_STATES } from './store.js';
import { authorizationFromInput, makeSettingsRoutes, } from './settings-routes.js';
import { CredentialMirror } from './credential-mirror.js';
import { bindingOf, checkApproval, createApproval, hashText } from './security/approvals.js';
import { aiAccountFor } from './platforms/accounts.js';
import { bindingsOf } from './runtime.js';
import { checkExpectation, checkReassessment, isApprovable, approvableOf, readExpectation, } from './security/approve-guard.js';
import { countersOf } from './security/security-events.js';
import { COOKIE_REF, SECRET_REFS, findCredentialSeam } from './secrets.js';
/** Stable Loader identity; matches the row id in `cordis.patch.yml`. */
export const name = 'dsh-ai-debate';
/** Services required before the tools can mount. */
export const inject = ['tools', 'systemPrompt'];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 170;
/**
 * Turn a delay into an awaitable timer that cannot hold the process open.
 *
 * `credential-mirror.ts` takes its sleep as a dependency so tests can advance a
 * fake clock; the real one has to be unref'd, or a settings-page read could keep
 * a shutting-down Host alive for the length of the warm-up.
 */
function sleepMs(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer)
            timer.unref();
    });
}
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
/**
 * Resolve the state directory from config, creating it.
 *
 * Delegates to {@link resolveStoreDirStrict}, which prefers an explicit `storeDir`,
 * then a host-provided directory, then `DSH_HOME`, then the historical default. The
 * v0.2.23 code used `homedir()` unconditionally, so an isolated `DSH_HOME` still wrote
 * into the real `~/.dsh` — the bug this indirection removes.
 *
 * `get` is the plugin context's service lookup, passed in so the host-probe can run
 * without this function depending on the whole context.
 */
export function resolveStoreDir(config, get) {
    return resolveStoreDirStrict({ configured: config.storeDir, get }).dir;
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
export function buildRuntime(resolve, log, registry, resolveSettings, options = {}) {
    const config = resolve();
    const store = options.store ??
        new DebateStore({
            dir: resolveStoreDir(config),
            sessionTtlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000,
        });
    const settingsFor = (platform) => (resolveSettings ?? ((value, id) => platformSettingsOf(value, id)))(resolve(), platform);
    const manager = new AdapterManager({
        registry,
        settingsFor,
        // Injected by the caller, which is where the credential mirror lives. A
        // platform-scoped resolver cannot be built here: this function is module-level
        // and has no access to the mounted plugin's credential state.
        ...(options.resolveCredential === undefined ? {} : { resolveCredential: options.resolveCredential }),
        log: (level, message) => {
            log[level](message);
        },
    });
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
    const defaultPlatform = () => {
        if (registry.get(tiebaProvider.id) !== undefined)
            return tiebaProvider.id;
        const ids = registry.listIds();
        if (ids.length === 0) {
            throw new Error('平台注册中心是空的：没有任何平台可以处理请求。');
        }
        return ids[0];
    };
    return {
        get adapter() {
            return manager.adapterFor(defaultPlatform());
        },
        store,
        policy: policyFromConfig(config),
        config: resolve,
        llm: () => chooseModelSource(resolve(), {
            host: options.hostLlm,
            egress: options.egress,
        }).client,
        ...(options.hostLlm === undefined ? {} : { hostLlm: options.hostLlm }),
        ...(options.egress === undefined ? {} : { egress: options.egress }),
        log: (level, message) => {
            log[level](message);
        },
        platforms: {
            resolveUrl: (url) => resolveThreadRefFromRegistry(registry, url),
            diagnostics: () => registry.diagnostics(),
            capabilitiesOf: (platform) => registry.getCapabilities(platform),
            adapterFor: (platform) => manager.adapterFor(platform),
            assertCapability: (platform, capability) => {
                // The static declaration, unchanged. Evidence never edits it — it can only *satisfy*
                // it, and only through the rules in `capability-evidence.ts`.
                const declared = stateOf(registry.getCapabilities(platform), capability).state;
                if (declared === 'supported') {
                    registry.assertCapability(platform, capability);
                    return;
                }
                // `unavailable` and `permission_required` are statements about the integration, not
                // about this deployment's history: a publish that once succeeded cannot conjure a
                // capability that does not exist, nor grant a permission nobody gave. Refuse without
                // even looking at records, so there is no path on which old evidence could lift them.
                if (declared === 'unavailable' || declared === 'permission_required') {
                    registry.assertCapability(platform, capability);
                    return;
                }
                // Everything below is the P0-3 join: live account + adapter build + persisted records.
                // A missing ingredient yields '' which matches no record — refusing is the safe
                // direction, and the failure message then says what the gate actually knew.
                const accountId = configuredAccountOf(resolve(), platform) ?? '';
                let adapterVersion = '';
                try {
                    adapterVersion = adapterVersionOfAdapter(manager.adapterFor(platform));
                }
                catch {
                    adapterVersion = '';
                }
                // No adapter build means no evidence can match, so refuse without consulting records:
                // an empty version would compare equal to records that also lack one, which is exactly
                // the "unknown build promoted to verified" mistake the version exists to prevent.
                if (adapterVersion === '') {
                    registry.assertCapability(platform, capability, {
                        effective: declared,
                        reason: `${platform} 的适配器当前不可用，无法确定这份代码的版本，因此验收记录不能算数`,
                    });
                    return;
                }
                const records = store
                    .getVerificationRecords()
                    .filter((record) => record.outcome === 'succeeded')
                    .map((record) => ({
                    platform: record.platform,
                    capability: record.capability,
                    accountId: record.authorizedAccountId,
                    adapterVersion: record.adapterVersion ?? '',
                    verifiedAt: record.startedAt,
                    method: 'live',
                    readBackComplete: record.readBack !== undefined &&
                        record.readBack.postFound &&
                        record.readBack.authorMatched &&
                        record.readBack.textMatched &&
                        record.readBack.parentMatched,
                }));
                const decision = effectiveCapability(declared, { platform, capability, accountId, adapterVersion }, records);
                registry.assertCapability(platform, capability, {
                    effective: decision.effective,
                    reason: decision.reason,
                });
            },
        },
    };
}
/**
 * Resolve a URL through the registry.
 *
 * Kept as a free function so `buildRuntime` can hand it to the runtime object
 * without the runtime holding a registry reference it could misuse.
 */
function resolveThreadRefFromRegistry(registry, url) {
    return registry.parseUrl(url);
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
/**
 * 正在进行的「四种人格比较」，按会话 id 索引。
 *
 * 放在模块级而不是闭包里：取消动作来自另一个请求，必须能拿到同一个 controller。
 * 用会话 id 作键是因为**同一会话同时只该有一批** —— 两次点击各跑四份，用户会
 * 收到八条候选并为此付八次钱。
 */
const compareRuns = new Map();
export function apply(ctx, config) {
    const log = loggerOf(ctx, 'dsh-ai-debate');
    const dshVersion = readDshVersion(ctx);
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
    /**
     * 宿主的模型服务（v0.2.36 §3.1）。
     *
     * 读一次就够：服务注册在宿主 ctx 上，插件生命周期内不会换。拿不到是正常状态
     * （旧宿主、或宿主禁用了 llm），此时模型来源退回「自己配置的接口」。
     */
    const hostLlm = hostLlmOf(ctx);
    /**
     * 出网守卫（v0.2.36 §4）。
     *
     * 审计落在插件自己的 store 目录旁 —— 不写进会话数据，也不写进宿主日志：
     * 验收脚本要能独立读它，且它不能污染产品状态。
     */
    const egressLog = new EgressLog(join(resolveStoreDirStrict({ configured: resolveConfig(config).storeDir, get: ctx.get }).dir, 'egress.jsonl'));
    /**
     * 守卫按**当前配置**现造，而不是挂载时造一个。
     *
     * `egressMode` 是可实时编辑的：用户在设置页把「手动导入」切成「离线」，下一次
     * 出网判断就该按新模式来。挂载时造的那一个会一直用旧模式，直到重挂插件 ——
     * 一个「改了没生效」的安全设置比没有这个设置更危险。
     */
    const egressOf = () => new EgressGuard(egressPolicyOf({
        mode: effectiveConfig().egressMode,
        llmBaseUrl: effectiveConfig().llmBaseUrl,
    }), egressLog);
    const seam = findCredentialSeam(ctx);
    const credentialMirror = new CredentialMirror({
        seam,
        sleep: (ms) => sleepMs(ms),
        // Re-key eagerly on every accepted state change: the adapter holds a cookie
        // jar, so a rotated cookie must invalidate it now rather than on whichever
        // call happens to read next.
        onSettled: () => {
            rekeyRuntime();
        },
    });
    /** The resolved config with credential-store values folded in. */
    const effectiveConfig = () => {
        const resolved = resolveConfig(config);
        // With no credential service the legacy config fields are the whole story;
        // teach the mirror that so `canPublish()` reasons about a real cookie rather
        // than about a store that does not exist.
        if (seam === undefined) {
            credentialMirror.adoptConfigFallback({
                cookie: resolved.tiebaCookie.trim(),
                llmApiKey: resolved.llmApiKey.trim(),
                stored: new Set(),
            });
        }
        return applyOverlay(resolved, credentialMirror.overlay);
    };
    // The platform registry, built once per mount.
    //
    // Two providers now (v0.2.7): Tieba, which can read and (unverified) publish, and
    // Weibo, which routes links and declares its limits but cannot touch the network
    // until an Open Platform scope is granted. Registering Weibo is what stops a pasted
    // Weibo link being treated as an unknown link that "falls back to Tieba" — the
    // v0.2.0 bug — without claiming any capability it does not have.
    const platforms = new PlatformRegistry();
    platforms.register(tiebaProvider);
    platforms.register(weiboProvider);
    /**
     * 把出网策略接到两个平台出口上（v0.2.36 §4）。
     *
     * 位置在注册中心之后、任何读取之前：策略必须在第一次平台调用之前就位，否则
     * 「第一枪」会按默认放行打出去。两个钩子读的都是 `effectiveConfig()`，所以
     * 设置页改模式立即生效，不需要重挂。
     */
    __setHttpEgressGate((url) => {
        egressOf().check(url, 'platform');
    });
    // 第三条出口：微博授权主机探针（v0.2.36）。真机验收里它绕过了守卫 8 次。
    __setAuthHostEgressGate((url) => {
        egressOf().check(url, 'platform');
    });
    __setCliEgressVeto((argv) => {
        try {
            // 标签只取前两个参数（子命令与动作），不含任何内容参数：审计日志不该把
            // 用户输入的正文抄进去。
            egressOf().assertSpawn('platform', argv.slice(0, 2).join('.'));
            return undefined;
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    });
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
    const describeSecurity = () => {
        const config = runtime.config();
        // The stored records are structurally a superset of `SecurityEvent` except
        // that their string fields are widened for forward compatibility with a newer
        // writer. Narrowing on read keeps the analysis honest: an event whose `kind`
        // this build does not recognise still displays, it simply counts as `none`.
        const events = runtime.store.getSecurityEvents().map((record) => ({
            id: record.id,
            at: record.at,
            kind: record.kind,
            severity: record.severity,
            summary: record.summary,
            ...(record.platform !== undefined ? { platform: record.platform } : {}),
            ...(record.threadId !== undefined ? { threadId: record.threadId } : {}),
            ...(record.postId !== undefined ? { postId: record.postId } : {}),
            ...(record.decision !== undefined
                ? { decision: record.decision }
                : {}),
            ...(record.excerpt !== undefined ? { excerpt: record.excerpt } : {}),
        }));
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
        };
    };
    const describePlatforms = () => {
        /**
         * Which platform is "in use".
         *
         * v0.2.28: this used to be `runtime.adapter.id`, which is the *default* adapter —
         * the one a single-platform deployment was built for. With two providers
         * registered it names Tieba forever, so a Weibo session never showed 「当前使用」
         * even when the owner was working in one.
         *
         * The honest answer is "the platform of the newest session", because that is what
         * the plugin is demonstrably talking to. When there is no session yet, the default
         * adapter is the only thing that can answer, and using it is not a claim about
         * anything having run.
         */
        const sessions = runtime.store.snapshot().sessions;
        const current = [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
        const activeId = current?.platform ?? runtime.adapter.id;
        const rows = [];
        for (const provider of platforms.list()) {
            const matrix = provider.describeCapabilities();
            // `implemented` is not "there is a provider object". It is "this platform can
            // actually read or write something", and it is derived from the capability
            // matrix rather than stated separately so the two cannot disagree.
            //
            // This became load-bearing in v0.2.7, when Weibo's provider was registered. It
            // routes links and declares its limits, but every network method throws because
            // no Open Platform scope exists here — so it is registered *and* not
            // implemented, and the page must say so. Before this, registering any provider
            // painted it green.
            const implemented = Object.values(matrix.capabilities).some((capability) => capability.state === 'supported' || capability.state === 'unverified');
            const { readiness, reason } = readinessOf(matrix);
            rows.push({
                id: provider.id,
                displayName: provider.displayName,
                shape: provider.shape,
                implemented,
                active: provider.id === activeId,
                readiness,
                readinessReason: reason,
                capabilities: flattenCapabilities(matrix),
            });
        }
        for (const manifest of PLATFORM_MANIFESTS) {
            // A manifest whose platform is also registered would be rendered twice; the
            // registered row wins because it carries the real capability matrix. The
            // research/prerequisite text is still worth showing for a registered-but-
            // unimplemented platform, so it is merged in below rather than dropped.
            if (platforms.get(manifest.id) !== undefined) {
                const existing = rows.find((row) => row.id === manifest.id);
                if (existing !== undefined && !existing.implemented) {
                    rows[rows.indexOf(existing)] = {
                        ...existing,
                        research: manifest.research,
                        prerequisites: manifest.prerequisites,
                        constraints: manifest.constraints,
                        authModel: manifest.authModel,
                        urlShapes: manifest.urlShapes,
                    };
                }
                continue;
            }
            rows.push({
                id: manifest.id,
                displayName: manifest.displayName,
                shape: manifest.shape,
                implemented: false,
                active: false,
                // A manifest describes a plan, so "nothing to do yet, and here is what would
                // have to happen" is the honest reading. The reason is the manifest's own
                // first prerequisite rather than a generic sentence.
                readiness: 'unavailable',
                readinessReason: manifest.prerequisites[0] ??
                    '这个平台还只是调研记录，没有适配器可以实现它的任何能力。',
                research: manifest.research,
                capabilities: flattenCapabilities(manifest.capabilities),
                prerequisites: manifest.prerequisites,
                constraints: manifest.constraints,
                authModel: manifest.authModel,
                urlShapes: manifest.urlShapes,
            });
        }
        return rows;
    };
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
    const resolvePlatformCredential = async (platform, ref) => {
        if (platform !== 'tieba')
            return undefined;
        if (ref !== COOKIE_REF)
            return undefined;
        // The mirror wins once it holds a value; the config field is the legacy path
        // and `effectiveConfig` has already folded it in.
        const fromMirror = credentialMirror.overlay.cookie;
        if (fromMirror.length > 0)
            return fromMirror;
        const fromConfig = effectiveConfig().tiebaCookie.trim();
        return fromConfig.length > 0 ? fromConfig : undefined;
    };
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
    let sharedStore;
    let sharedStoreDir;
    const storeFor = (config) => {
        const dir = resolveStoreDir(config);
        if (sharedStore === undefined || sharedStoreDir !== dir) {
            sharedStore = new DebateStore({
                dir,
                sessionTtlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000,
            });
            sharedStoreDir = dir;
        }
        return sharedStore;
    };
    // Rebuilt on every read so a live settings edit takes effect without a
    // remount — that is what `.volatile()` fields are for.
    let runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
        resolveCredential: resolvePlatformCredential,
        store: storeFor(effectiveConfig()),
        hostLlm,
        egress: egressOf(),
    });
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
            log.info('配置或凭据中的平台请求参数已变化，正在重建平台适配器');
            runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
                resolveCredential: resolvePlatformCredential,
                store: storeFor(next),
                hostLlm,
                egress: egressOf(),
            });
            currentKey = key;
        }
        return runtime;
    };
    /**
     * Rebuild the adapter if the effective config moved.
     *
     * Never throws after dispose: the mirror calls this from `onSettled`, and a
     * read that lands during unmount must not resurrect a runtime that has already
     * been dropped.
     */
    const rekeyRuntime = () => {
        if (disposed)
            return;
        effectiveConfig();
        const key = adapterKey(effectiveConfig());
        if (key === currentKey)
            return;
        log.info('配置或凭据中的平台请求参数已变化，正在重建平台适配器');
        runtime = buildRuntime(effectiveConfig, log, platforms, undefined, {
            resolveCredential: resolvePlatformCredential,
            store: storeFor(effectiveConfig()),
            hostLlm,
            egress: egressOf(),
        });
        currentKey = key;
    };
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
    const refreshSecrets = async () => {
        if (disposed)
            return;
        await credentialMirror.refresh();
        const state = credentialMirror.state;
        if (state.error !== undefined && state.phase !== 'timeout') {
            log.warn(`读取凭据失败：${state.error}`);
        }
    };
    /**
     * Re-read once per consumer call while the mirror is still unproven.
     *
     * The mirror bounds its own warm-up, so this only decides *whether* a consumer
     * should trigger a read at all: an unproven phase is worth one more attempt, a
     * terminal one is not.
     */
    const ensureSecretsFresh = async () => {
        if (disposed || seam === undefined)
            return;
        const phase = credentialMirror.state.phase;
        if (phase === 'ready' || phase === 'unavailable' || phase === 'empty')
            return;
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
            return currentRuntime().platforms;
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
        llm: () => chooseModelSource(effectiveConfig(), {
            host: hostLlm,
            egress: egressOf(),
        }).client,
        ...(hostLlm === undefined ? {} : { hostLlm }),
        credentialState: () => {
            const state = credentialMirror.state;
            return {
                phase: state.phase,
                canPublish: credentialMirror.canPublish(),
                ...(state.error === undefined ? {} : { error: state.error }),
            };
        },
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
    /**
     * 离线候选的目标描述，供复制前显示（v0.2.30）。
     *
     * 与 `copyReply` 的 `target` 同一份内容，但这里只用会话里存下的东西：页面刷新时
     * 也要显示「这段话是回给谁的」，而那不该为了显示一句话重新投影整份导入内容。
     */
    const findImportedTarget = (session, candidate) => {
        const postId = candidate.targetPostId;
        const matched = (session.comments ?? []).find((entry) => entry.postId === postId);
        const author = matched?.authorName ?? session.opponentName;
        return {
            ...(author === undefined ? {} : { author }),
            excerpt: matched?.text ?? '',
            postId,
        };
    };
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
    const createApprovalForSettings = async (input) => {
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
        const candidateId = typeof input.candidateId === 'string' ? input.candidateId.trim() : '';
        if (!sessionId || !candidateId) {
            return { status: 400, body: { error: '缺少 sessionId 或 candidateId' } };
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
        const readBack = readExpectation(input.expected, sessionId, candidateId);
        if (!readBack.ok) {
            return { status: readBack.status, body: { error: readBack.reason, code: readBack.code } };
        }
        const expected = readBack.expectation;
        // The account the publish path will use, resolved the same way. It does not
        // depend on stored state, so it can be resolved before the transaction.
        const config = effectiveConfig();
        const outcome = await runtimeView.store.transact((data) => {
            const session = data.sessions.find((row) => row.id === sessionId);
            if (session === undefined) {
                return { abort: { status: 404, body: { error: `找不到会话 ${sessionId}` } } };
            }
            const candidate = session.candidates.find((row) => row.replyId === candidateId);
            if (candidate === undefined) {
                return { abort: { status: 404, body: { error: `找不到候选 ${candidateId}` } } };
            }
            const approvable = isApprovable(approvableOf(candidate));
            if (!approvable.ok) {
                return { abort: { status: 409, body: { error: approvable.reason, code: approvable.code } } };
            }
            const reassessed = checkReassessment(approvableOf(candidate), expected.assessmentFingerprint);
            if (!reassessed.ok) {
                return { abort: { status: 409, body: { error: reassessed.reason, code: reassessed.code } } };
            }
            const account = aiAccountFor(bindingsOf(config), session.platform)?.account;
            const publishingAccount = (account?.accountId ?? account?.displayName ?? '').trim();
            if (publishingAccount === '') {
                return {
                    abort: {
                        status: 409,
                        body: {
                            error: '还没有为这个平台绑定 AI 发帖账号，无法创建批准：发布时无法确认用哪个账号发言。' +
                                '请在「贴吧账号」区域填写 AI 账号后重试。',
                            code: 'account_unbound',
                        },
                    },
                };
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
            });
            if (!compared.ok) {
                return { abort: { status: 409, body: { error: compared.reason, code: compared.code } } };
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
            });
            // One live approval per candidate: an earlier un-consumed one is superseded, so
            // the owner cannot accumulate records and later wonder which one authorises
            // what. Consumed records are history and stay.
            //
            // Read from `data`, not from `getApprovals()`: a record created by another
            // process a moment ago must be superseded too, and this is the fresh copy.
            const record = createApproval(binding, 'owner', () => Date.now());
            const approvals = (data.approvals ?? []).filter(
            // Keep consumed records (they are publish history) and drop every *live*
            // record for this candidate — including ones this transaction did not just
            // create, which is what keeps two concurrent approvals from both leaving an
            // authorising record behind.
            (row) => row.consumedAt !== undefined ||
                row.sessionId !== session.id ||
                row.candidateId !== candidate.replyId);
            approvals.push(record);
            // ## Mark the candidate too (v0.2.26)
            //
            // The approval record alone is not what the page and the gate read: `approved` on the
            // candidate is checked first by `approvalStillApplies` ("这条候选还没有被批准") and by
            // the workbench's step derivation. That flag used to be set only *after a successful
            // publish*, so approving changed nothing visible — the button stayed, the step stayed
            // at `approve`, and publishing was unreachable from the page. Approving is exactly the
            // moment the flag becomes true; publishing is what consumes the record.
            const sessions = data.sessions.map((entry) => entry.id === session.id
                ? {
                    ...entry,
                    candidates: entry.candidates.map((row) => row.replyId === candidate.replyId ? { ...row, approved: true } : row),
                    updatedAt: new Date().toISOString(),
                }
                : entry);
            return {
                commit: { ...data, approvals, sessions },
                value: {
                    status: 200,
                    body: {
                        approved: true,
                        approvalId: record.id,
                        expiresAt: new Date(Date.parse(record.grantedAt) + 30 * 60 * 1000).toISOString(),
                    },
                },
            };
        });
        return outcome.value;
    };
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
    const listPendingApprovals = async () => {
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
        await runtimeView.store.refreshFromDisk();
        const staleness = runtimeView.store.staleness;
        if (staleness !== undefined) {
            // A failed refresh must not render as an empty list. The owner would read "nothing
            // is waiting for approval" from a document that may be corrupt, missing, or held
            // by another writer — and then wonder why the agent says otherwise.
            return {
                ok: false,
                reason: staleness.reason,
                ...(staleness.code === undefined ? {} : { code: staleness.code }),
            };
        }
        const now = Date.now();
        const config = effectiveConfig();
        const approvals = runtimeView.store.getApprovals();
        const out = [];
        for (const session of runtimeView.store.snapshot().sessions) {
            // Only a session that can still publish needs a decision. A published, cancelled
            // or paused one is not waiting for approval — it is waiting for something else,
            // and listing it would send the owner to a button that cannot help.
            if (session.state !== 'READY' && session.state !== 'NEEDS_CONFIRMATION')
                continue;
            // Resolved once per session, exactly as the approve route will resolve it, so
            // the expectation the page echoes back is the account the publish will really
            // use. Two resolutions would let the two disagree.
            const account = aiAccountFor(bindingsOf(config), session.platform)?.account;
            const publishingAccount = (account?.accountId ?? account?.displayName ?? '').trim();
            for (const candidate of session.candidates) {
                const verdict = candidate.security?.decision;
                if (verdict !== 'allow' && verdict !== 'review')
                    continue;
                // The expectation is built from stored values only. If any of them is
                // missing the row is still listed (the owner should see the candidate) but
                // without an `expected` block, which makes the approve route refuse it for
                // being unsnapshotted rather than binding an approval to a guess.
                const fingerprint = candidate.security?.fingerprint;
                const expectation = fingerprint === undefined || publishingAccount === ''
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
                    };
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
                const authorising = expectation === undefined
                    ? undefined
                    : approvals.find((record) => record.sessionId === session.id &&
                        record.candidateId === candidate.replyId &&
                        checkApproval(record, expectation, () => now).ok);
                if (authorising !== undefined)
                    continue;
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
                    reason: expectation === undefined
                        ? '这条候选缺少批准所需的快照（安全评估指纹或 AI 发帖账号），无法批准。' +
                            '请在「贴吧账号」里补上 AI 账号，或重新生成一次候选。'
                        : verdict === 'review'
                            ? '安全闸门把它标记为「需要人工确认」：必须由你看过正文后批准，任何自动模式都不能替你做这个决定。'
                            : '当前是人工审核模式：通过自动检查的候选也需要你批准才能发表。',
                });
            }
        }
        // Newest first: the reply the owner just generated is the one they are looking at.
        return { ok: true, rows: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    };
    const settingsRouteDeps = { authorize: authorizer,
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
            await refreshSecrets();
        },
        config: () => effectiveConfig(),
        credentials: () => seam,
        overlay: () => credentialMirror.overlay,
        credentialState: () => {
            const state = credentialMirror.state;
            return {
                phase: state.phase,
                settled: state.settled,
                unresolved: state.unresolved,
                canPublish: credentialMirror.canPublish(),
                ...(state.error === undefined ? {} : { error: state.error }),
            };
        },
        acceptSecret: (ref, value) => credentialMirror.commit(ref, value),
        acceptSecretClear: (ref) => credentialMirror.commitClear(ref),
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
        probeHostLlm: async () => {
            try {
                return await probeHostLlm(hostLlm);
            }
            catch (error) {
                return {
                    available: false,
                    servicePresent: hostLlm !== undefined,
                    providers: [],
                    models: [],
                    reason: `探测宿主模型失败：${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
        probeEgress: async () => {
            try {
                return await egressOf().selfTest();
            }
            catch (error) {
                return { blocked: false, mode: 'open', host: '', reason: `自检本身失败：${error.message}` };
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
        approve: createApprovalForSettings,
        pendingApprovals: listPendingApprovals,
        /**
         * 离线讨论的七步（v0.2.30 §一/§二）。
         *
         * ## 全部走 `import/workflow.ts`，这里只做字段搬运
         *
         * 每一条都是 `workflow` 里那个函数的直接调用，包括 `personaOf` 的人格校验和
         * `resolveBudget` 的预算解析——那些规则与命令行调用共用一份。在这里补任何
         * 默认值或判断，就会出现「页面能生成的、工具清单生成不出来」这种两套行为。
         *
         * ## 没有一条能发表
         *
         * 这个对象里没有任何字段通向 `runPublish`。会话的平台是 `manual`，
         * `adapterFor` 会抛错，`runPublish` 另有显式拒绝——三道门都不在这里。
         */
        manualImport: {
            preview: async (input) => {
                const parsed = parseImport({
                    kind: input.kind,
                    content: input.content,
                    ...(input.title === undefined ? {} : { title: input.title }),
                    ...(input.url === undefined ? {} : { url: input.url }),
                    ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
                });
                const blocking = parsed.issues.find((issue) => issue.severity === 'error');
                if (parsed.discussion === undefined || blocking !== undefined) {
                    return {
                        ok: false,
                        reason: blocking?.message ?? '没有从这段内容里解析出任何发言。',
                        issues: parsed.issues.map((issue) => ({
                            severity: issue.severity,
                            code: issue.code,
                            message: issue.message,
                        })),
                    };
                }
                /**
                 * ## 预览必须把「确认之后会发生什么」说在前面
                 *
                 * 两件事在这里一致化，都是实测发现的：
                 *
                 * 1. **只有一条发言**。粘进来一段没有「作者：内容」格式的文字时，解析器会把
                 *    整段当成一条发言（冒号把前半句读成了作者名）。预览于是返回
                 *    `ok: true` 并显示一个莫名其妙的作者——而下一步「确认导入」必定拒绝
                 *    「这份导入内容里没有任何评论」。用户在预览阶段看不出这一点，
                 *    只能在下一步撞墙。预览就该说「这样确认不了」，并给出**同一条**理由。
                 *
                 * 2. **超长内容会被截断**。截断发生在落盘（`toStoredImport`）时，而预览
                 *    不经过那里，所以预览展示的是完整正文、`issues` 是空的，确认之后存下的
                 *    却是截断版本。用户以为确认的是自己看到的那一段。这里把将要发生的截断
                 *    提前算出来并标出来，预览与落盘用同一组常量。
                 */
                const comments = parsed.discussion.comments;
                if (comments.length === 0) {
                    return {
                        ok: false,
                        reason: '这份导入内容里没有任何评论，无法分析。' +
                            '请至少导入一条别人说的话——只有原帖时没有可回复的对象。',
                        issues: parsed.issues.map((issue) => ({
                            severity: issue.severity,
                            code: issue.code,
                            message: issue.message,
                        })),
                    };
                }
                /**
                 * 预览阶段应用修正（v0.2.31 §四）。
                 *
                 * 修正清单由页面持有并回传：预览 → 改 → 再预览 → 确认，四步共用同一份。
                 * 这样「确认的数据」与「预览的数据」是同一个函数的同一次计算，
                 * 而不是两次「应该一样」的计算。
                 */
                const corrections = sanitizeCorrections(input.corrections);
                const applied = applyCorrections(parsed.discussion, corrections);
                const discussion = applied.discussion;
                const overlong = discussion.comments.filter((comment) => comment.text.length > MAX_IMPORTED_CHARS);
                const overlongRoot = discussion.root.text.length > MAX_IMPORTED_CHARS;
                const previewIssues = [
                    ...parsed.issues.map((issue) => ({
                        severity: issue.severity,
                        code: issue.code,
                        message: issue.message,
                    })),
                    ...applied.issues.map((issue) => ({
                        severity: issue.severity,
                        code: issue.code,
                        message: issue.message,
                    })),
                    ...(overlong.length === 0 && !overlongRoot
                        ? []
                        : [
                            {
                                severity: 'warning',
                                code: 'will_truncate',
                                message: `有 ${overlong.length + (overlongRoot ? 1 : 0)} 条正文超过 ${MAX_IMPORTED_CHARS} 字，` +
                                    '确认之后会截断保存——分析用的是截断后的那一段。',
                            },
                        ]),
                ];
                const collected = toCollectedThread(discussion);
                const structure = describeCollected(discussion, collected);
                return {
                    ok: true,
                    issues: previewIssues,
                    discussion: {
                        title: discussion.title,
                        author: discussion.root.author,
                        text: discussion.root.text,
                        comments: discussion.comments.map((comment) => ({
                            id: comment.id,
                            author: comment.author,
                            text: comment.text,
                            ...(comment.replyTo === undefined ? {} : { replyTo: comment.replyTo }),
                        })),
                        // 导入内容里出现过的作者名，按首次出现排序。页面用它让用户选「哪个是你」。
                        participants: [
                            discussion.root.author,
                            ...discussion.comments.map((comment) => comment.author),
                        ].filter((name, index, all) => name.trim() !== '' && all.indexOf(name) === index),
                    },
                    structure,
                    audit: applied.audit,
                    ...(corrections === undefined ? {} : { corrections }),
                    // 解析阶段就算出来的结构问题，页面要在确认之前显示。
                    ...(collected.issues.length === 0 ? {} : { structuralIssues: collected.issues }),
                };
            },
            confirm: async (input) => {
                const parsed = parseImport({
                    kind: input.kind,
                    content: input.content,
                    ...(input.title === undefined ? {} : { title: input.title }),
                    ...(input.url === undefined ? {} : { url: input.url }),
                    ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
                });
                if (parsed.discussion === undefined) {
                    return {
                        ok: false,
                        reason: parsed.issues.find((issue) => issue.severity === 'error')?.message ?? '解析失败。',
                    };
                }
                /**
                 * 修正必须在**落盘之前**应用。
                 *
                 * 顺序反了会得到一份「存的是原文、分析的是修正后」的会话：界面显示修正生效，
                 * 刷新之后又变回原来的样子。`toStoredImport` 收的是应用之后的讨论，
                 * 修正清单随讨论一起落进 `StoredImport.corrections`。
                 */
                const corrections = sanitizeCorrections(input.corrections);
                const applied = applyCorrections(parsed.discussion, corrections);
                const config = effectiveConfig();
                const imported = toStoredImport(applied.discussion, new Date().toISOString());
                const analyzed = await analyzeImport(runtimeView.store, {
                    imported,
                    ...(input.ownerName === undefined ? {} : { ownerName: input.ownerName }),
                    ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
                    persona: personaOf(input.persona, config),
                    config,
                });
                if (!analyzed.ok || analyzed.value === undefined) {
                    return { ok: false, reason: analyzed.reason ?? '分析失败。', next: analyzed.next ?? [] };
                }
                return {
                    ok: true,
                    sessionId: analyzed.value.session.id,
                    participants: analyzed.value.participants,
                    securityNotes: analyzed.value.securityNotes,
                };
            },
            revise: async (input) => {
                const config = effectiveConfig();
                const result = await reviseImport(runtimeView.store, {
                    sessionId: input.sessionId,
                    corrections: input.corrections,
                    persona: personaOf(undefined, config),
                    config,
                });
                if (!result.ok || result.value === undefined) {
                    return { ok: false, reason: result.reason ?? '修正失败。', next: result.next ?? [] };
                }
                return {
                    ok: true,
                    structure: result.value.structure,
                    audit: result.value.audit,
                    discardedCandidates: result.value.discardedCandidates,
                };
            },
            context: async (input) => {
                const session = runtimeView.store.getSession(input.sessionId);
                if (session === undefined) {
                    return { ok: false, reason: `找不到会话 ${input.sessionId}`, context: undefined };
                }
                if (session.imported === undefined) {
                    return { ok: false, reason: '这条会话不是人工导入的，没有可展示的上下文。' };
                }
                const collected = collectedFromStored(session.imported);
                const context = targetContextOf(collected, input.postId, session.threadTitle);
                if (context === undefined) {
                    return {
                        ok: false,
                        reason: `「${input.postId}」不在这次导入的内容里。可能是内容被修正过，请刷新页面。`,
                    };
                }
                return { ok: true, context };
            },
            select: async (input) => {
                const config = effectiveConfig();
                const result = await reselectImport(runtimeView.store, {
                    sessionId: input.sessionId,
                    ...(input.ownerName === undefined ? {} : { ownerName: input.ownerName }),
                    ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
                    persona: personaOf(input.persona, config),
                    config,
                });
                return result.ok
                    ? { ok: true }
                    : { ok: false, reason: result.reason ?? '重新分析失败。', next: result.next ?? [] };
            },
            generate: async (input) => {
                const config = effectiveConfig();
                const result = await generateForImport(runtimeView.store, {
                    sessionId: input.sessionId,
                    ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
                    ...(input.persona === undefined
                        ? {}
                        : { persona: personaOf(input.persona, config) }),
                    ...(input.ownerInstruction === undefined
                        ? {}
                        : { ownerInstruction: input.ownerInstruction }),
                    config,
                    llm: runtimeView.llm,
                });
                if (!result.ok || result.value === undefined) {
                    return { ok: false, reason: result.reason ?? '生成失败。', next: result.next ?? [] };
                }
                return {
                    ok: true,
                    candidateId: result.value.candidateId,
                    text: result.value.text,
                    securityDecision: result.value.securityDecision,
                    securityReasons: result.value.securityReasons,
                };
            },
            /**
             * 四种人格比较（v0.2.37 §7）。
             *
             * 一次点、四种人格、串行调用。默认不触发 —— 页面必须由用户明确点「比较四种
             * 人格」才会到这里，因为那是四次真实计费调用。
             */
            compare: async (input) => {
                const config = effectiveConfig();
                const controller = new AbortController();
                // 记在会话上，取消动作能拿到同一个 controller。键是会话 id：同一会话同时
                // 只允许一批，避免两次点击各跑四份。
                compareRuns.set(input.sessionId, controller);
                try {
                    return await comparePersonas({
                        store: runtimeView.store,
                        sessionId: input.sessionId,
                        ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
                        ...(input.personas === undefined ? {} : { personas: input.personas }),
                        ...(input.ownerInstruction === undefined
                            ? {}
                            : { ownerInstruction: input.ownerInstruction }),
                        config,
                        llm: runtimeView.llm,
                        signal: controller.signal,
                    });
                }
                finally {
                    compareRuns.delete(input.sessionId);
                }
            },
            cancelCompare: async (input) => {
                const controller = compareRuns.get(input.sessionId);
                if (controller === undefined) {
                    return { ok: false, reason: '这个会话当前没有正在进行的比较。' };
                }
                controller.abort();
                return { ok: true };
            },
            edit: async (input) => {
                const result = await editImportedCandidate(runtimeView.store, {
                    sessionId: input.sessionId,
                    candidateId: input.candidateId,
                    text: input.text,
                    config: effectiveConfig(),
                });
                return result.ok
                    ? { ok: true, candidateVersion: result.value?.candidateVersion }
                    : { ok: false, reason: result.reason ?? '编辑失败。' };
            },
            approve: async (input) => {
                const result = await approveImportedCandidate(runtimeView.store, {
                    sessionId: input.sessionId,
                    candidateId: input.candidateId,
                    approvedText: input.approvedText,
                });
                return result.ok
                    ? { ok: true }
                    : { ok: false, reason: result.reason ?? '确认失败。', next: result.next ?? [] };
            },
            copy: async (input) => {
                const result = await copyReply(runtimeView.store, {
                    sessionId: input.sessionId,
                    candidateId: input.candidateId,
                    ...(input.visibleText === undefined ? {} : { visibleText: input.visibleText }),
                });
                if (!result.ok || result.value === undefined) {
                    return { ok: false, reason: result.reason ?? '无法复制。', next: result.next ?? [] };
                }
                return {
                    ok: true,
                    text: result.value.text,
                    target: result.value.target,
                    safe: result.value.safe,
                    blockers: result.value.blockers,
                    persona: result.value.persona,
                };
            },
        },
        /**
         * Live per-platform diagnostic (v0.2.13 §四).
         *
         * ## Why the adapter is asked rather than a static manifest
         *
         * A manifest describes what a platform *could* do. The task book requires the opposite: the
         * page must show the **actual** connection state, including that it is not connected. So
         * this walks the registered providers, asks each one that supports it for its live
         * diagnostic, and reports whatever it says — or an explicit error when it cannot say.
         *
         * ## Nothing here can leak a credential
         *
         * The adapter's diagnostic is built from probe results only (a status enum, a version
         * string, command names, a failure message). It never receives the OAuth session: the
         * official CLI owns that on disk and this plugin does not read it. The route is also behind
         * `guard`, so an unauthenticated caller cannot read it either.
         */
        platformDiagnostics: async (options) => {
            const blocks = [];
            for (const provider of platforms.list()) {
                // Only the Weibo adapter exposes `describeDiagnostics` today. Probing for the member
                // rather than switching on the id keeps this platform-neutral: the next adapter that
                // implements it starts showing up with no edit here.
                let adapter;
                try {
                    adapter = provider.createAdapter({ settings: platformSettingsOf(effectiveConfig(), provider.id) });
                }
                catch (error) {
                    blocks.push({
                        platform: provider.id,
                        displayName: provider.displayName,
                        error: `无法构造适配器：${error.message}`,
                    });
                    continue;
                }
                const probe = adapter;
                if (typeof probe.describeDiagnostics !== 'function')
                    continue;
                try {
                    const state = await probe.describeDiagnostics(options);
                    blocks.push({ platform: provider.id, displayName: provider.displayName, state });
                }
                catch (error) {
                    // An answer we could not get is still worth showing: silence would render as
                    // "nothing to check".
                    blocks.push({
                        platform: provider.id,
                        displayName: provider.displayName,
                        error: `诊断读取失败：${error.message}`,
                    });
                }
            }
            return blocks;
        },
        /**
         * The one-off publish verification (v0.2.21 §三).
         *
         * ## Why the service is rebuilt per request instead of held
         *
         * Every input it reads — the adapter, the live cookie jar, the record list — can change
         * between the page rendering and the owner pressing the button. Caching the service would
         * mean verifying against a snapshot of an account that has since been changed.
         *
         * ## Why the account id is read from configuration rather than guessed
         *
         * §三.9 binds evidence to an account. If this returned `undefined` the evidence would bind to
         * nothing and match any account; a wrong-but-present id is worse. So the lookup is explicit:
         * the platform's configured posting identity, and when that is absent the capability simply
         * cannot be verified — the view reports it as a blocker instead of offering the button.
         */
        verification: async ({ platform }) => {
            const service = buildVerificationService({
                adapterFor: (id) => runtimeView.platforms?.adapterFor(id) ?? (id === runtimeView.adapter.id ? runtimeView.adapter : undefined),
                declaredState: (id, capability) => {
                    const matrix = runtimeView.platforms?.capabilitiesOf(id);
                    // No matrix means "no declaration", which is `unavailable` — the honest reading, and
                    // one that cannot accidentally look like `supported`.
                    if (matrix === undefined)
                        return 'unavailable';
                    return stateOf(matrix, capability).state;
                },
                configuredAccountId: (id) => configuredAccountOf(effectiveConfig(), id),
                liveAccountId: async (id, threadId) => liveAccountOf(runtimeView, id, threadId),
                records: {
                    // Refresh before answering: another instance may have claimed or completed a record.
                    // The panel is where a human decides whether to spend an authorization, so it must
                    // not describe a document this instance loaded minutes ago.
                    all: () => runtimeView.store.getVerificationRecords(),
                    refresh: () => runtimeView.store.refreshVerificationRecords(),
                    put: (record) => runtimeView.store.putVerificationRecord(record),
                    // The atomic gate (P0-1): check-and-claim in one lock hold. Without it the runner
                    // would fall back to read-then-write, and two concurrent submits could both publish
                    // from the same authorization.
                    claim: (record) => runtimeView.store.claimVerificationRecord(record),
                },
                now: () => new Date().toISOString(),
            });
            // Read the session here rather than inside the view: the view is synchronous and pure, and
            // "read the live account" is exactly the I/O that must not hide behind a render.
            const live = await liveAccountOf(runtimeView, platform);
            return verificationViewOf(service, platform, { accountId: live });
        },
        /**
         * Run one attempt.
         *
         * The refusal path lives inside the runner, not here: this only forwards the owner's form.
         * Adding a check here would be a second place that decides whether publishing may happen, and
         * the two could disagree — which is how "the panel said yes and the sender said no" happens.
         */
        /**
         * The publish workbench's read model (v0.2.22 §一).
         *
         * ## Refresh-is-safe is structural
         *
         * This function performs no publish, no approval and no generation. Reloading the page can
         * therefore only re-derive the same answer from the same durable facts — the state machine
         * in `workbench.ts` computes the step rather than reading a stored one, so a reload cannot
         * rewind or replay anything.
         *
         * ## The publish outcome comes from the ledger, not the session
         *
         * `DedupeRecord.publishState` is the durable truth about whether a reply went out; the
         * session is a working cache with a TTL. Reading the session would make "already published"
         * quietly expire back to "not attempted" — which is the state that gets a reply re-sent.
         */
        /**
         * Collect and analyse a discussion from the workbench (v0.2.22 §二).
         *
         * The agent tool and this route call the same function; the difference is who supplied the
         * link. Collecting is read-only with respect to the platform and cannot publish, so reaching
         * it from the page does not add a new way to write.
         */
        analyzeThread: async (input) => {
            try {
                const output = await runAnalysis(runtimeView, {
                    url: input.url,
                    ...(input.postId === undefined ? {} : { postId: input.postId }),
                    ...(input.ownerInstruction === undefined ? {} : { ownerInstruction: input.ownerInstruction }),
                });
                return { ok: true, sessionId: output.sessionId };
            }
            catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        },
        /** Generate candidates for an existing session (v0.2.22 §三). */
        generateCandidates: async (input) => {
            try {
                const output = await runGeneration(runtimeView, {
                    sessionId: input.sessionId,
                    ...(input.style === undefined ? {} : { persona: { style: input.style } }),
                    ...(input.ownerInstruction === undefined ? {} : { ownerInstruction: input.ownerInstruction }),
                    // The owner's pick from the workbench. Omitting it keeps the pre-0.2.24
                    // behaviour of answering whoever summoned the session.
                    ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
                });
                // One call produces one candidate, deliberately: comparing two drafts means generating
                // twice, and each generation bumps the version — which retires any approval of the
                // previous draft. Reporting a count of 1 is the honest answer, not a placeholder.
                return {
                    ok: true,
                    candidates: 1,
                    ...(output.needsInput === true
                        ? { message: output.needsInputReason ?? '模型要求补充信息后才能起草' }
                        : {}),
                };
            }
            catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        },
        /** Publish one approved candidate through the normal pipeline (v0.2.22 §四). */
        publishApproved: async (input) => {
            const report = await runPublish(runtimeView, {
                sessionId: input.sessionId,
                candidateId: input.candidateId,
                approvedText: input.approvedText,
                humanApproved: true,
            });
            return {
                ok: report.ok,
                status: report.status,
                message: report.message,
                ...(report.postId === undefined ? {} : { postId: report.postId }),
            };
        },
        editCandidate: async (input) => editCandidate(runtimeView, input),
        workbench: async ({ sessionId }) => {
            /**
             * ## 先等 store 加载完再回答
             *
             * `DebateStore` 是懒加载的：`getSession` / `latestSession` 读的是内存缓存，
             * 而缓存在 `ready()` 之前是空文档。这条路由原先没有 await，于是
             * **进程起来之后第一次读工作台，永远读到「还没有会话」**——页面显示
             * 「粘贴讨论链接」，而磁盘上明明躺着刚导入的那一条。
             *
             * 更糟的是它看起来像时序玄学：先访问一次别的页（`/status` 之类会 await 的
             * 路由），再回来刷新就好了。第一遍白屏、第二遍正常，是最容易被当成缓存
             * 或者浏览器问题的形状。
             *
             * 这也解释了为什么实测时它只在「刷新页面后立刻看工作台」时出现：正常流程
             * 里确认导入那一步自己写过 store，缓存已经热了。
             */
            await runtimeView.store.ready();
            const session = sessionId === undefined
                ? runtimeView.store.latestSession()
                : runtimeView.store.getSession(sessionId);
            if (session === undefined) {
                // Nothing collected yet. `deriveWorkbenchState` already answers "paste a link" for this
                // case, so the page gets the same shape it gets for a live session.
                //
                // v0.2.25: it has to be the *same shape*, which means under `workbench`. This used to
                // spread the derived state at the top level while the session branch nested it, so the
                // client's `view.workbench` was undefined on a fresh install. The page then rendered
                // 「当前构建没有接上工作台」 — a false statement about the build — and, worse, skipped
                // the link field entirely, so a first-time owner had no way to start a read at all.
                return {
                    ok: true,
                    sessionId: undefined,
                    workbench: deriveWorkbenchState({ approvalApplies: false }),
                };
            }
            const platform = session.platform;
            const candidate = session.candidates[session.candidates.length - 1];
            // The approval the owner created, matched against the candidate as it is now. Both sides
            // come from the store, so "approved" cannot be true here while the ledger disagrees.
            //
            // `consumedAt` is respected through `approvalStillApplies`'s caller contract: a consumed
            // record still *binds* the same bytes, but the publish path treats it as spent. Keeping the
            // freshness answer about the bytes (and not about consumption) is deliberate — the page
            // shows "approved, already used" rather than silently flipping to "not approved", which
            // would invite the owner to approve the same text again.
            const approval = runtimeView.store
                .getApprovals()
                .filter((record) => record.sessionId === session.id)
                .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))[0];
            const freshness = candidate === undefined
                ? { applies: false, reason: '还没有候选' }
                : approvalStillApplies({
                    candidate,
                    ...(approval === undefined
                        ? {}
                        : {
                            approval: {
                                candidateId: approval.candidateId,
                                candidateVersion: approval.candidateVersion,
                                textHash: approval.textHash,
                                targetPostId: approval.targetPostId,
                            },
                        }),
                });
            // The ledger row for this session. Absent means no publish has been attempted; `pending`
            // means one was started and its outcome is unknown. Reading the session alone would make
            // "already published" expire back to "not attempted" when the session is pruned — which is
            // the state that gets a reply re-sent.
            const ledger = runtimeView.store
                .snapshot()
                .dedupe.find((record) => record.sessionId === session.id);
            const lastAttempt = ledger?.publishState === 'confirmed'
                ? { status: 'confirmed' }
                : ledger?.publishState === 'pending'
                    ? { status: 'uncertain' }
                    : ledger?.publishState === 'failed'
                        ? {
                            status: 'failed',
                            ...(session.error === undefined ? {} : { reason: session.error }),
                        }
                        : undefined;
            const derived = deriveWorkbenchState({
                session,
                approvalApplies: freshness.applies,
                capability: capabilityFor(runtimeView, platform, capabilityNameForSession(session, candidate)),
                ...(lastAttempt === undefined ? {} : { lastAttempt }),
                // The counts came from nowhere before v0.2.26: `floorCount` / `nestedCount` were
                // never passed by any production caller, so the page rendered 「楼层 0 条 ·
                // 楼中楼 0 条」 next to a six-row comment list. Worse than blank — it contradicted
                // the list right beside it, and a reader would reasonably conclude the read had
                // failed. They are taken from the same stored read quality that feeds the
                // completeness line, so the two can never disagree.
                ...(session.readQuality === undefined
                    ? {}
                    : { floorCount: session.readQuality.floorsRead, nestedCount: session.readQuality.nestedRead }),
                // v0.2.24: the read-quality facts recorded with this session, plus whether the
                // owner's own identity still needs re-checking before anything is sent.
                ...(session.readQuality === undefined
                    ? {}
                    : {
                        readQuality: {
                            floorsRead: session.readQuality.floorsRead,
                            ...(session.readQuality.floorsDeclared === undefined
                                ? {}
                                : { floorsDeclared: session.readQuality.floorsDeclared }),
                            nestedRead: session.readQuality.nestedRead,
                            ...(session.readQuality.nestedDeclared === undefined
                                ? {}
                                : { nestedDeclared: session.readQuality.nestedDeclared }),
                            truncated: session.readQuality.truncated,
                            reasons: session.readQuality.reasons,
                            observationOverflow: session.readQuality.observationOverflow,
                            ownerNeedsRecheck: session.ownerIdentityAssurance !== 'verified',
                        },
                    }),
                ...(session.comments === undefined
                    ? {}
                    : { commentsCapped: session.comments.length >= MAX_STORED_COMMENTS }),
            });
            // The approval snapshot the page must echo back (v0.2.22 §四).
            //
            // The approve route refuses a request whose `expected` is missing or stale, on purpose:
            // "approve whatever happens to be stored now" is the v0.2.7 hole. Building the snapshot
            // here — from the same store read that produced the view — is what lets the workbench
            // approve at all, and when any half of it is missing the page must not offer the button.
            const publishingAccount = (() => {
                const bound = aiAccountFor(bindingsOf(effectiveConfig()), platform)?.account;
                return (bound?.accountId ?? bound?.displayName ?? '').trim();
            })();
            const assessmentFingerprint = candidate?.security?.fingerprint ?? '';
            const approveBlocked = candidate === undefined
                ? '还没有候选'
                : publishingAccount === ''
                    ? '还没有为这个平台绑定 AI 发帖账号，无法创建批准：发布时无法确认用哪个账号发言。'
                    : assessmentFingerprint === ''
                        ? '这条候选没有安全评估快照，无法创建批准。请重新生成一次候选。'
                        : undefined;
            const approveExpectation = approveBlocked !== undefined || candidate === undefined
                ? null
                : {
                    sessionId: session.id,
                    candidateId: candidate.replyId,
                    candidateVersion: candidate.candidateVersion ?? 0,
                    platform,
                    targetPostId: candidate.targetPostId,
                    publishingAccount,
                    // `hashText`, not `candidate.textHash`.
                    //
                    // Two hashes exist and they are not interchangeable: the stored
                    // `textHash` is `contentHash` — whitespace-normalised and truncated to 32
                    // hex chars — while the approval record binds `hashText`, the full sha256
                    // of the exact bytes. Sending the stored one made `checkExpectation`
                    // compare 32 chars against 64 for every candidate, so it always reported
                    // 「正文内容」 drift and **no approval could ever be granted**. Nothing
                    // caught it because the tests that touch approval construct the
                    // expectation by hand; only a real page→approve round trip shows it.
                    textHash: hashText(candidate.text),
                    assessmentFingerprint,
                };
            /**
             * 来源标识与离线流程（v0.2.30 §二/§四）。
             *
             * ## 为什么来源由服务端判定
             *
             * 页面只有一个平台字符串，它无法区分「官方接口读的」与「我自己粘的」，
             * 而猜错的方向永远是「看起来更像官方」。服务端按 `session.imported`
             * 是否存在判断——那是决定性的事实。
             */
            const source = sourceOf({ platform, hasImport: session.imported !== undefined });
            /**
             * 离线流程的进度与可复制性。
             *
             * `copyAllowed` 只看存下来的评估与检查结果，不重新跑一遍：复制是这个流程的
             * 终点，它必须回答「这段文字当时通过了什么」，而不是「现在跑一遍会怎样」。
             */
            const manualFlow = session.imported === undefined
                ? undefined
                : (() => {
                    const latest = candidate;
                    const assessment = latest?.security;
                    const blockers = [];
                    if (latest === undefined) {
                        blockers.push('还没有生成候选回复。');
                    }
                    else if (assessment === undefined) {
                        blockers.push('这段正文没有安全评估记录，请重新生成一次。');
                    }
                    else if (assessment.decision === 'block') {
                        blockers.push(`安全评估判定为阻止：${assessment.reasons.join('；') || '未说明原因'}。`);
                    }
                    if (latest !== undefined && latest.violations.length > 0) {
                        blockers.push(`候选检查未通过：${latest.violations.join('；')}`);
                    }
                    if (latest !== undefined && !latest.approved) {
                        blockers.push('这条候选还没有人工确认，确认后才能复制。');
                    }
                    const target = latest === undefined ? undefined : findImportedTarget(session, latest);
                    const step = stepOf(session);
                    const done = new Set(completedSteps(session));
                    /**
                     * 结构快照（v0.2.31 §五）。
                     *
                     * ## 为什么在这里算，而不是让页面自己拉
                     *
                     * 页面需要「全部发言 + 关系 + 同位同名 + 依据」才能做好纠错界面。
                     * 让它自己调一个接口拿，意味着刷新时先显示会话、再显示结构，
                     * 而结构到位的这段时间里用户可能已经点了一个基于旧结构的按钮。
                     * 一次返回，页面就永远看到一份自洽的视图。
                     *
                     * 代价是每次读工作台都重算一次投影。6000 条的实测是 200ms——
                     * 只在用户手动刷新时发生，可以接受。
                     */
                    const structure = (() => {
                        try {
                            return describeImport(correctedDiscussion(session.imported).discussion);
                        }
                        catch {
                            // 结构算不出来时不要连带把整个工作台打挂：会话本身仍然可读。
                            return undefined;
                        }
                    })();
                    const audited = correctedDiscussion(session.imported);
                    return {
                        step,
                        stepTitle: MANUAL_STEP_TITLES[step],
                        steps: MANUAL_STEP_ORDER.map((id) => ({
                            id,
                            title: MANUAL_STEP_TITLES[id],
                            done: done.has(id),
                            current: id === step,
                        })),
                        personas: personaOptions(),
                        participants: session.participants ?? [],
                        ...(session.imported.importedAt === undefined
                            ? {}
                            : { importedAt: session.imported.importedAt }),
                        importSource: session.imported.source,
                        ...(structure === undefined ? {} : { structure }),
                        ...(audited.audit.length === 0 ? {} : { corrections: audited.audit }),
                        ...(audited.issues.length === 0 ? {} : { correctionIssues: audited.issues }),
                        ...(target === undefined ? {} : { copyTarget: target }),
                        copyAllowed: blockers.length === 0,
                        ...(blockers.length === 0 ? {} : { copyBlockers: blockers }),
                    };
                })();
            return {
                ok: true,
                sessionId: session.id,
                platform,
                threadUrl: session.threadUrl,
                threadTitle: session.threadTitle,
                workbench: derived,
                approveExpectation,
                ...(approveBlocked === undefined ? {} : { approveBlocked }),
                source,
                ...(manualFlow === undefined ? {} : { manualFlow }),
                candidates: session.candidates.map((entry) => ({
                    replyId: entry.replyId,
                    text: entry.text,
                    strategy: entry.strategy,
                    candidateVersion: entry.candidateVersion,
                    textHash: entry.textHash,
                    approved: entry.approved,
                    targetPostId: entry.targetPostId,
                    createdAt: entry.createdAt,
                    violations: entry.violations,
                    ...(entry.persona === undefined ? {} : { persona: entry.persona }),
                    ...(entry.elapsedMs === undefined ? {} : { elapsedMs: entry.elapsedMs }),
                    ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
                    ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
                    ...(entry.security === undefined
                        ? {}
                        : {
                            assessmentFingerprint: entry.security.fingerprint,
                            securityDecision: entry.security.decision,
                            securityReasons: entry.security.reasons,
                        }),
                })),
                blockers: [...derived.blockers, ...(freshness.applies ? [] : [freshness.reason])],
            };
        },
        /**
         * Run one verification attempt (§三).
         *
         * The refusal path lives inside the runner, not here: this only forwards the owner's form.
         * Adding a check here would be a second place that decides whether publishing may happen,
         * and the two could disagree.
         */
        runVerification: async (input) => {
            const service = buildVerificationService({
                adapterFor: (id) => runtimeView.platforms?.adapterFor(id) ?? (id === runtimeView.adapter.id ? runtimeView.adapter : undefined),
                declaredState: (id, capability) => {
                    const matrix = runtimeView.platforms?.capabilitiesOf(id);
                    // No matrix means "no declaration", which is `unavailable` — the honest reading, and
                    // one that cannot accidentally look like `supported`.
                    if (matrix === undefined)
                        return 'unavailable';
                    return stateOf(matrix, capability).state;
                },
                configuredAccountId: (id) => configuredAccountOf(effectiveConfig(), id),
                liveAccountId: async (id) => liveAccountOf(runtimeView, id),
                records: {
                    // Refresh before answering: another instance may have claimed or completed a record.
                    // The panel is where a human decides whether to spend an authorization, so it must
                    // not describe a document this instance loaded minutes ago.
                    all: () => runtimeView.store.getVerificationRecords(),
                    refresh: () => runtimeView.store.refreshVerificationRecords(),
                    put: (record) => runtimeView.store.putVerificationRecord(record),
                    // The atomic gate (P0-1): check-and-claim in one lock hold. Without it the runner
                    // would fall back to read-then-write, and two concurrent submits could both publish
                    // from the same authorization.
                    claim: (record) => runtimeView.store.claimVerificationRecord(record),
                },
                now: () => new Date().toISOString(),
            });
            const outcome = await service.verify(authorizationFromInput(input));
            if ('code' in outcome) {
                return { ok: false, upgraded: false, message: outcome.message, refusal: outcome.code };
            }
            return {
                ok: outcome.ok,
                upgraded: outcome.upgraded,
                message: outcome.message,
                ...(outcome.refusal !== undefined ? { refusal: outcome.refusal } : {}),
                ...(outcome.record?.publishedPostId !== undefined
                    ? { publishedPostId: outcome.record.publishedPostId }
                    : {}),
                ...(outcome.record?.readBack !== undefined ? { readBack: outcome.record.readBack } : {}),
            };
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
        // 卸载时摘掉出网钩子：留着会把「插件已经不在了」变成一个仍在生效的拒绝源。
        __setHttpEgressGate(undefined);
        __setCliEgressVeto(undefined);
        __setAuthHostEgressGate(undefined);
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