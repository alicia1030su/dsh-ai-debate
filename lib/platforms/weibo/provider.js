/**
 * The Weibo provider: link routing, capability declaration, adapter construction.
 *
 * ## What this integration deliberately does NOT claim
 *
 * The Weibo Open Platform needs a registered application, developer qualification
 * and an explicit scope grant. This build has none of them, and no request against
 * the live API has ever been made from here. So:
 *
 * - every network-touching capability is `permission_required` or `unavailable`,
 *   never `supported` and never `unverified`;
 * - there is **no OAuth client here**, because inventing endpoint paths and scope
 *   strings would look like working code and be wrong in a way nobody could see
 *   until a user granted a permission that does not exist;
 * - the adapter throws a named, actionable error on every read method rather than
 *   returning empty data, because "no comments" and "not implemented" must not look
 *   the same to the analysis pipeline.
 *
 * ## What it DOES provide, and why that is worth shipping
 *
 * Link routing and id normalisation are the parts that can be verified offline and
 * are the most expensive to get wrong: a base62 display id compared against a
 * numeric mid points the whole pipeline at a different post, silently. Registering
 * Weibo *read-only* means a pasted Weibo link resolves to the right platform and the
 * settings page shows the honest status instead of treating it as an unknown link
 * that "fell back to Tieba" — the v0.2.0 bug.
 *
 * `projectWeiboThread` (see `./conversation.ts`) is also complete and tested, so the
 * day an authorised reader exists, the data model needs no new design.
 */
import { parseWeiboUrl, weiboCanHandleUrl } from './url.js';
const PLATFORM = 'weibo';
/** Why every row is what it is. One place, so the page and the docs cannot drift. */
const AUTH_REASON = '微博开放平台需要注册应用、开发者资质与显式 scope 授权；本构建没有这些凭据，也从未对线上接口发过请求。';
function row(state, reason, extra = {}) {
    return { state, reason, ...extra };
}
/**
 * The capability matrix.
 *
 * Ordering of severity matters: nothing here is `supported`, because nothing here has
 * been exercised against the live platform. `unverified` is also deliberately absent —
 * that state means "code exists and would run, but no real account proved it", and
 * there is no code that would run.
 */
function describeCapabilities() {
    const capabilities = {
        'thread.read': row('permission_required', `${AUTH_REASON}读取正文需要 statuses:read 一类的读取授权。`, {
            requiredPermissions: ['微博开放平台的读取授权'],
        }),
        'comment.list': row('permission_required', `${AUTH_REASON}读取评论需要评论读取权限。`, {
            requiredPermissions: ['评论读取授权'],
        }),
        'comment.paginate': row('permission_required', `${AUTH_REASON}分页读取同样受读取权限与配额限制。`, {
            requiredPermissions: ['评论读取授权'],
            limits: ['微博接口配额按应用计算，分页会成倍放大请求数'],
        }),
        'comment.nested': row('permission_required', `${AUTH_REASON}读取评论回复需要评论读取权限。`, {
            requiredPermissions: ['评论读取授权'],
        }),
        'comment.locate': row('permission_required', `${AUTH_REASON}按 id 定位单条评论需要评论读取权限。`, {
            requiredPermissions: ['评论读取授权'],
        }),
        'identity.verify': row('permission_required', `${AUTH_REASON}确认登录账号需要用户信息授权。`, {
            requiredPermissions: ['用户信息读取授权'],
        }),
        'event.mentions': row('unavailable', '微博的艾特通知接口不对外开放给第三方应用读取；请让主人手动提供微博链接。'),
        'comment.publish': row('permission_required', `${AUTH_REASON}发表评论需要写权限，且平台对 AI 生成内容有标识要求。`, { requiredPermissions: ['评论写入授权', 'AI 生成内容标识'], limits: ['未经授权时不会尝试任何发送'] }),
        'comment.reply': row('permission_required', `${AUTH_REASON}回复评论需要写权限，且平台对 AI 生成内容有标识要求。`, { requiredPermissions: ['评论写入授权', 'AI 生成内容标识'] }),
        'publish.verify': row('unavailable', '没有写入能力，回读验证无从谈起。'),
        'media.read': row('unavailable', '本构建不解析图片与视频内容，只保留它们的地址。'),
        'user.profile': row('permission_required', `${AUTH_REASON}读取用户资料需要用户信息授权。`, {
            requiredPermissions: ['用户信息读取授权'],
        }),
    };
    return { platform: PLATFORM, declaredAt: new Date().toISOString(), capabilities };
}
/** The error every unimplemented read throws. Named so callers can branch on it. */
export class WeiboNotAuthorisedError extends Error {
    code = 'weibo_not_authorised';
    constructor(what) {
        super(`微博的「${what}」需要开放平台授权，本构建没有可用凭据，因此不会尝试请求。` +
            '这不是网络故障：授权到位之前，插件不会读取也不会发表任何微博内容。');
        this.name = 'WeiboNotAuthorisedError';
    }
}
function notAuthorised(what) {
    throw new WeiboNotAuthorisedError(what);
}
/**
 * The stateful adapter.
 *
 * Every method that would touch the network throws. That is the honest shape: an
 * adapter that returned `[]` would make "we could not read it" indistinguishable from
 * "there is nothing there", and the analyzer would happily conclude the opponent said
 * nothing.
 */
function createAdapter(context) {
    void context;
    const capabilities = {
        thread: false,
        replies: false,
        nestedReplies: false,
        userProfile: false,
        mentions: false,
        publish: false,
        authCheck: false,
    };
    return {
        id: PLATFORM,
        displayName: '微博',
        getCapabilities: () => capabilities,
        checkAuthentication: async () => notAuthorised('登录状态检查'),
        getThread: async () => notAuthorised('读取微博正文'),
        getReplies: async () => notAuthorised('读取微博评论'),
        getNestedReplies: async () => notAuthorised('读取评论回复'),
        getUserProfile: async () => notAuthorised('读取用户资料'),
        getMentions: async () => notAuthorised('读取艾特通知'),
        getReplyContext: async () => notAuthorised('定位单条评论'),
        publishReply: async () => notAuthorised('发表评论'),
        // Present so a caller can parse a Weibo link through the adapter itself, the same
        // way a bare single-platform deployment does. This is pure and offline.
        parseUrl: (input) => {
            const ref = parseWeiboUrl(input);
            return { platform: PLATFORM, threadId: ref.threadId, url: ref.url };
        },
    };
}
/** The provider the registry holds. */
export const weiboProvider = {
    id: PLATFORM,
    displayName: '微博',
    shape: 'microblog',
    canHandleUrl: weiboCanHandleUrl,
    parseUrl: (input) => {
        const ref = parseWeiboUrl(input);
        return { platform: PLATFORM, threadId: ref.threadId, url: ref.url };
    },
    describeCapabilities,
    createAdapter,
};
//# sourceMappingURL=provider.js.map