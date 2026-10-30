/**
 * The credential seam: where Cookie and API key actually live.
 *
 * Why not the config schema: a Cordis patch is plain YAML on disk, and the
 * profile file is the one thing users paste into issues, screenshot and sync.
 * A `.role('secret')` field keeps the value out of the *wire*, but it is still
 * in the patch. The Host's own credential store (`ctx.credentials`) is the
 * place designed for exactly this: values never enter a config document, never
 * enter the browser, and can be rotated without editing YAML.
 *
 * Two facts shape this module:
 *
 * 1. `ctx.credentials` is **async**, while `resolveConfig` is sync and the
 *    adapter is built synchronously at mount. So the credential values are
 *    mirrored into a small in-memory overlay that `resolveConfig` reads
 *    synchronously, and the overlay is refreshed on mount and on every
 *    `credentials/reference-updated` event.
 * 2. A deployment may have **no** credential service at all (headless CLI, a
 *    stripped composition). Then the overlay stays empty, the legacy config
 *    fields keep working, and nothing throws — a plugin that refuses to mount
 *    because an optional service is missing is worse than one without the
 *    feature.
 *
 * Backward compatibility: v0.1.5 users have `tiebaCookie` / `llmApiKey` in
 * their patch. Those still resolve. But once a value is stored in the
 * credential store it wins, and the plugin reports the config copy as
 * superseded rather than silently ignoring it.
 */
/**
 * Credential reference names. POSIX-identifier shaped, as the seam requires.
 *
 * The platform-scoped one is *derived* from the platform id rather than written
 * out, so the namespace rule (`DSH_AI_DEBATE_<PLATFORM>_<WHAT>`) is a fact about
 * the code rather than a convention in a comment. `COOKIE_REF` keeps its literal
 * for backward compatibility with profiles that already have that exact name
 * stored; the derivation is asserted to agree with it in the tests.
 */
export const COOKIE_REF = 'DSH_AI_DEBATE_TIEBA_COOKIE';
export const LLM_KEY_REF = 'DSH_AI_DEBATE_LLM_API_KEY';
/**
 * References this plugin owns that belong to **no platform**.
 *
 * Namespacing was only ever applied to platform secrets, so a plugin-level key
 * like the model API key sits in the same `DSH_AI_DEBATE_*` space. That is a real
 * escalation path: a platform whose id is `llm` derives the stem `LLM`, and
 * `DSH_AI_DEBATE_LLM_API_KEY` then looks exactly like *its* `api_key`. The
 * namespace check would hand the model key to that adapter.
 *
 * A closed set rather than a naming rule, deliberately: a rule would need to
 * predict every future plugin-level key, while a table only has to list the ones
 * that exist. Adding a platform ref here would be a bug; adding a plugin key is
 * one line.
 */
export const RESERVED_PLUGIN_REFS = Object.freeze([COOKIE_REF, LLM_KEY_REF]);
/**
 * Credential derivation, re-exported from the module that actually owns the rule.
 *
 * v0.2.1 had this logic written out twice — once here and once in
 * `platforms/adapter-manager.ts` — and the two drifted: fixing the collision in
 * one place left the other still lossy, so `import { credentialRefFor } from
 * 'secrets'` bypassed the fix entirely. One definition, re-exported, is the only
 * way that cannot happen again.
 */
export { credentialRefFor, refBelongsToPlatform } from './platforms/credentials.js';
/** Every reference this plugin owns, in display order. */
export const SECRET_REFS = [COOKIE_REF, LLM_KEY_REF];
/** Human-facing label and hint for each reference. */
export const SECRET_LABELS = {
    [COOKIE_REF]: {
        label: '贴吧登录 Cookie',
        hint: '从已登录的浏览器复制整行 Cookie。只存在本机凭据库，不进配置、不进日志、不进模型上下文。',
        configField: 'tiebaCookie',
    },
    [LLM_KEY_REF]: {
        label: '模型 API Key',
        hint: 'OpenAI 兼容接口的密钥。留空表示保持已保存的值；清除后回退到配置里的旧值（若有）。',
        configField: 'llmApiKey',
    },
};
/** An empty overlay: no stored values, config fallbacks apply. */
export const EMPTY_OVERLAY = { cookie: '', llmApiKey: '', stored: new Set() };
/** Read the overlay value for a reference. */
export function overlayValue(overlay, ref) {
    return ref === COOKIE_REF ? overlay.cookie : overlay.llmApiKey;
}
/** Replace one reference in an overlay, returning a new overlay. */
export function withOverlayValue(overlay, ref, value) {
    const stored = new Set(overlay.stored);
    if (value === '')
        stored.delete(ref);
    else
        stored.add(ref);
    return {
        cookie: ref === COOKIE_REF ? value : overlay.cookie,
        llmApiKey: ref === LLM_KEY_REF ? value : overlay.llmApiKey,
        stored,
    };
}
/**
 * A masked tail for recognition only.
 *
 * Four characters is enough for a person to tell "the key I pasted yesterday"
 * from "a stale one", and short enough that leaking it to a screenshot or a
 * support thread is not a credential disclosure. Values shorter than eight
 * characters return no tail at all — masking four of six characters is not a
 * mask.
 */
export function maskedTail(value) {
    if (value.length < 8)
        return undefined;
    return `…${value.slice(-4)}`;
}
/** Whether a resolved value counts as configured (blank is absent, seam-wide). */
function present(value) {
    return typeof value === 'string' && value.length > 0;
}
/**
 * Refresh the overlay from the credential store.
 *
 * @param seam the credential service, or undefined when the deployment has none
 * @returns the overlay to install, and per-reference diagnostics for the UI
 */
export async function loadOverlay(seam) {
    if (seam === undefined) {
        return {
            overlay: EMPTY_OVERLAY,
            statuses: SECRET_REFS.map((ref) => ({
                ref,
                configured: false,
                writable: false,
                configSuperseded: false,
                fromConfigFallback: true,
                length: 0,
            })),
            error: '本部署没有凭据服务（ctx.credentials），密钥只能放在配置里。',
            empty: true,
        };
    }
    const results = await Promise.all(SECRET_REFS.map(async (ref) => {
        try {
            const [info, hit] = await Promise.all([seam.describe(ref), seam.resolve(ref)]);
            return { ref, info, hit };
        }
        catch (error) {
            return { ref, error: error instanceof Error ? error.message : String(error) };
        }
    }));
    let overlay = EMPTY_OVERLAY;
    const failures = [];
    const unresolved = [];
    let resolvedCount = 0;
    for (const row of results) {
        if ('error' in row) {
            failures.push(`${SECRET_LABELS[row.ref].label}：${row.error}`);
            continue;
        }
        const value = present(row.hit?.value) ? row.hit.value : '';
        if (value !== '')
            resolvedCount += 1;
        // describe() says there is a value, resolve() did not hand one back: the
        // store is not readable yet, which is precisely the cold-start race.
        if (value === '' && row.info.configured)
            unresolved.push(row.ref);
        overlay = withOverlayValue(overlay, row.ref, value);
    }
    return {
        overlay,
        statuses: [],
        ...(failures.length > 0 ? { error: failures.join('；') } : {}),
        // A reference the store admits to having but whose value did not resolve is
        // a partial load, not an empty store. The host half uses this to decide
        // whether the mirror is trustworthy; without it, one swallowed ref would
        // look exactly like "never configured".
        ...(unresolved.length > 0 ? { unresolved } : {}),
        // Nothing resolved at all is ambiguous: the store may genuinely be empty,
        // or the credential service may still be finishing its own `loadInitial()`
        // — it is exposed before its document is parsed, so the very first load
        // sees an empty Map with `configured: false` and no error (the v0.1.9
        // cold-start bug). The caller cannot tell those apart, so it is simply
        // told "nothing came back" and keeps a bounded retry alive instead of
        // freezing an empty mirror for the rest of the process.
        empty: resolvedCount === 0,
    };
}
/**
 * Describe every reference for the settings page.
 *
 * @param seam the credential service, or undefined
 * @param overlay the overlay currently in force (for the config-fallback check)
 * @param configValue reads the legacy config field for one reference
 */
export async function describeSecrets(seam, overlay, configValue) {
    return Promise.all(SECRET_REFS.map(async (ref) => {
        const legacy = configValue(ref).trim();
        const stored = overlayValue(overlay, ref);
        const base = {
            ref,
            configSuperseded: stored.length > 0 && legacy.length > 0,
            fromConfigFallback: stored.length === 0 && legacy.length > 0,
        };
        if (seam === undefined) {
            return {
                ...base,
                configured: legacy.length > 0,
                ...(legacy.length > 0 ? { source: 'config' } : {}),
                writable: false,
                length: legacy.length,
                ...(maskedTail(legacy) === undefined ? {} : { tail: maskedTail(legacy) }),
            };
        }
        try {
            const info = await seam.describe(ref);
            const effective = stored.length > 0 ? stored : legacy;
            return {
                ...base,
                configured: info.configured || legacy.length > 0,
                source: info.configured ? (info.source ?? 'store') : legacy.length > 0 ? 'config' : undefined,
                writable: info.writable !== false,
                length: effective.length,
                ...(maskedTail(effective) === undefined ? {} : { tail: maskedTail(effective) }),
            };
        }
        catch (error) {
            return {
                ...base,
                configured: legacy.length > 0,
                ...(legacy.length > 0 ? { source: 'config' } : {}),
                writable: false,
                length: legacy.length,
                ...(maskedTail(legacy) === undefined ? {} : { tail: maskedTail(legacy) }),
            };
        }
    }));
}
/**
 * Store one secret.
 *
 * @param seam the credential service (required — a caller without one must not
 *   pretend the value was saved)
 * @param ref which reference
 * @param value the non-empty secret
 * @throws when the seam is absent or rejects the write
 */
export async function storeSecret(seam, ref, value) {
    if (seam === undefined) {
        throw new Error('本部署没有凭据服务，无法安全保存密钥。请改用配置文件（不推荐）。');
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        throw new Error('空的密钥不会被保存。要清除已保存的值，请使用「清除凭据」。');
    }
    await seam.set(ref, trimmed);
}
/**
 * Remove one stored secret.
 *
 * @param seam the credential service
 * @param ref which reference
 * @returns whether the deployment could clear it
 */
export async function clearSecret(seam, ref) {
    if (seam === undefined) {
        return { cleared: false, note: '本部署没有凭据服务，没有可清除的已存值。' };
    }
    try {
        await seam.unset(ref);
        return { cleared: true };
    }
    catch (error) {
        return { cleared: false, note: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Locate the credential service on a Host context.
 *
 * A loose `get` on purpose: a strict one misses in early-activating or headless
 * mounts, and `credentials` is not in this plugin's `inject` list, so it is
 * genuinely optional.
 */
export function findCredentialSeam(ctx) {
    if (typeof ctx.get !== 'function')
        return undefined;
    let candidate;
    try {
        candidate = ctx.get('credentials', false);
    }
    catch {
        return undefined;
    }
    if (candidate === undefined || candidate === null)
        return undefined;
    const seam = candidate;
    if (typeof seam.describe !== 'function' ||
        typeof seam.resolve !== 'function' ||
        typeof seam.set !== 'function' ||
        typeof seam.unset !== 'function') {
        return undefined;
    }
    return candidate;
}
//# sourceMappingURL=secrets.js.map