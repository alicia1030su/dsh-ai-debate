/**
 * The platform contract: what a platform must declare and provide.
 *
 * This module is the boundary the v0.2.0 architecture is built around. Nothing
 * here may mention a concrete platform — Tieba, Weibo, Zhihu and the test fakes
 * are all just implementations of these interfaces.
 *
 * Two ideas carry most of the weight:
 *
 * 1. **Capabilities are states, not booleans.** The v0.1.x model answered
 *    `publish: true`, which conflates "the code exists", "it worked against a
 *    logged-out page" and "a real account published successfully". Those are
 *    very different claims, and collapsing them is how a plugin ends up
 *    telling someone a platform is supported when it never was.
 *
 * 2. **A provider is not an adapter.** The provider is the cheap, stateless
 *    description of a platform (can I handle this URL? what do I support?); the
 *    adapter is the stateful object that owns a cookie jar and a cache. Keeping
 *    them apart is what lets the registry answer "which platform is this link?"
 *    without constructing anything or touching the network.
 */
/** Every capability name, in a stable order for display. */
export const CAPABILITY_NAMES = [
    'thread.read',
    'comment.list',
    'comment.paginate',
    'comment.nested',
    'comment.locate',
    'identity.verify',
    'event.mentions',
    'comment.publish',
    'comment.reply',
    'publish.verify',
    'media.read',
    'user.profile',
];
/** Look one capability up, defaulting to `unavailable` rather than guessing. */
export function stateOf(matrix, name) {
    return (matrix.capabilities[name] ?? {
        state: 'unavailable',
        reason: `${matrix.platform} 没有声明 ${name} 能力`,
    });
}
/** True only for `supported`; `unverified` does not count as usable proof. */
export function isProven(matrix, name) {
    return stateOf(matrix, name).state === 'supported';
}
/** Compact marker for a capability, for health/diagnostics output. */
export function markOf(state) {
    switch (state) {
        case 'supported':
            return '✅';
        case 'degraded':
            return '⚠️';
        case 'unverified':
            return '❓';
        case 'permission_required':
            return '🔑';
        case 'unavailable':
            return '❌';
    }
}
// ---------------------------------------------------------------------------
// Capability errors
// ---------------------------------------------------------------------------
/**
 * Raised when a capability is missing entirely.
 *
 * Deliberately not a `PlatformError`: this is a property of the integration, not
 * of a request, and retrying will never help. Callers that treat every failure
 * as retryable would otherwise hammer a platform that cannot answer.
 */
export class UnsupportedCapabilityError extends Error {
    platform;
    capability;
    constructor(platform, capability, reason) {
        super(reason ?? `${platform} 不支持 ${capability}`);
        this.name = 'UnsupportedCapabilityError';
        this.platform = platform;
        this.capability = capability;
    }
}
/** Raised when the platform can do it but this account has not been granted it. */
export class PermissionRequiredError extends Error {
    platform;
    capability;
    requiredPermissions;
    constructor(platform, capability, requiredPermissions, reason) {
        super(reason ?? `${platform} 的 ${capability} 需要授权`);
        this.name = 'PermissionRequiredError';
        this.platform = platform;
        this.capability = capability;
        this.requiredPermissions = requiredPermissions;
    }
}
/**
 * Translate a capability declaration into the error a caller should see.
 *
 * One place, so every platform refuses in the same shape instead of each
 * adapter inventing its own message — and so nothing can accidentally return a
 * pretend-success for a capability it does not have.
 */
export function capabilityFailure(platform, capability, declaration) {
    if (declaration.state === 'permission_required') {
        return new PermissionRequiredError(platform, capability, declaration.requiredPermissions ?? [], `${platform} 的「${capability}」需要授权：${declaration.reason}`);
    }
    return new UnsupportedCapabilityError(platform, capability, `${platform} 的「${capability}」不可用（${declaration.state}）：${declaration.reason}`);
}
/** Map one legacy flag to a declaration, using its note as the reason. */
function fromFlag(platform, name, enabled, note) {
    if (!enabled) {
        return { state: 'unavailable', reason: note ?? `${platform} 未声明 ${name}` };
    }
    // A legacy `true` carries no evidence. The honest state for it is "the code
    // exists and nobody disproved it", which is `unverified`, not `supported`.
    // An adapter that has really been proven overrides this by supplying its own
    // matrix.
    return { state: 'unverified', reason: note ?? `${platform} 声明支持 ${name}，但没有验证记录` };
}
/**
 * Derive a matrix from the old booleans.
 *
 * Every `true` becomes `unverified`, never `supported`: the old model could not
 * distinguish the two, so upgrading the claim here would invent evidence. An
 * adapter that wants `supported` must say so itself.
 */
export function matrixFromLegacy(platform, flags, declaredAt = new Date().toISOString()) {
    const note = (key) => flags.notes?.[key];
    const capabilities = {
        'thread.read': fromFlag(platform, 'thread.read', flags.thread, note('thread')),
        'comment.list': fromFlag(platform, 'comment.list', flags.replies, note('replies')),
        'comment.paginate': fromFlag(platform, 'comment.paginate', flags.replies, note('replies')),
        'comment.nested': fromFlag(platform, 'comment.nested', flags.nestedReplies, note('nestedReplies')),
        'comment.locate': fromFlag(platform, 'comment.locate', flags.replies, note('replies')),
        'identity.verify': fromFlag(platform, 'identity.verify', flags.authCheck, note('authCheck')),
        'event.mentions': fromFlag(platform, 'event.mentions', flags.mentions, note('mentions')),
        'comment.publish': fromFlag(platform, 'comment.publish', flags.publish, note('publish')),
        'comment.reply': fromFlag(platform, 'comment.reply', flags.publish, note('publish')),
        'publish.verify': fromFlag(platform, 'publish.verify', flags.publish, note('publish')),
        'media.read': { state: 'unavailable', reason: `${platform} 未提供图片内容读取` },
        'user.profile': fromFlag(platform, 'user.profile', flags.userProfile, note('userProfile')),
    };
    return {
        platform,
        declaredAt,
        capabilities,
        notes: ['该矩阵由 v0.1.x 的布尔能力转换而来；true 一律记为 unverified，不代表已验证。'],
    };
}
/** Normalize an unknown error into a platform error code, for uniform reporting. */
export function errorCodeOf(error) {
    const code = error?.code;
    const known = [
        'network',
        'timeout',
        'dns',
        'rate_limited',
        'forbidden',
        'captcha',
        'not_found',
        'auth_required',
        'permission_denied',
        'malformed_response',
        'unknown',
    ];
    return typeof code === 'string' && known.includes(code)
        ? code
        : 'unknown';
}
//# sourceMappingURL=contracts.js.map