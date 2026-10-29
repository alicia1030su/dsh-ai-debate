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
/**
 * Why the read rows say what they say (v0.2.11).
 *
 * Two separate facts, and the task book asks for them to stay separate:
 *
 * 1. **The CLI adapter exists.** `cli.ts` can detect the binary, discover commands,
 *    parse JSON, classify failures, scrub credentials and enforce a timeout. That is
 *    code, and it has tests.
 * 2. **No read has ever run against the live platform.** This machine has no
 *    `weibo-cli`, no developer qualification and no OAuth login. So none of the read
 *    rows may say `supported`.
 *
 * `unverified` is exactly the state that means "implemented, never confirmed against a
 * real account" — which is the truth for the read path as of this version, and it is a
 * deliberate change from v0.2.10's blanket `permission_required`: the permission story
 * is now concrete (a CLI login plus a service entitlement), not a hypothetical.
 */
const READ_REASON = '微博只读接入走官方 weibo-cli。本机构建尚未安装 CLI、也没有开发者认证与 OAuth 登录，' +
    '所以这条读取路径的代码已经存在但从未对真实接口执行过——状态是「已实现、未验证」，不是「可用」。';
/** Why nothing can be written: no write scope, and the AI-content labelling rule. */
const WRITE_REASON = '微博的写能力需要评论写入授权，且平台要求对 AI 生成内容做显式标识；' +
    '本版明确不开放微博真实发表。';
function row(state, reason, extra = {}) {
    return { state, reason, ...extra };
}
/**
 * The capability matrix.
 *
 * ## The four distinct states now in use
 *
 * - `unverified` — code exists (a CLI adapter plus projection), never run against the
 *   platform. The honest label for every read row.
 * - `permission_required` — nothing can be done from code alone: a developer
 *   qualification and a service entitlement are required first.
 * - `unavailable` — the platform genuinely does not expose it to third parties.
 * - `degraded` — would work, but returns less than the platform has.
 *
 * Nothing is `supported`. That word has one meaning in this project — exercised against
 * the real platform — and no Weibo call has been.
 */
function describeCapabilities() {
    const capabilities = {
        'thread.read': row('unverified', `${READ_REASON}读取单条微博正文是第一步。`, {
            requiredPermissions: ['weibo-cli OAuth 登录', '开发者认证 + 服务开通（体验或积分包）'],
            limits: ['体验服务按接口限次（读取类通常 5 次/接口），正式服务按积分计费'],
        }),
        'comment.list': row('unverified', `${READ_REASON}评论列表读取同样只到代码层。`, {
            requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
            limits: ['体验服务读取类通常 5 次/接口'],
        }),
        'comment.paginate': row('unverified', `${READ_REASON}分页逻辑按官方 CLI 的 page/cursor 语义实现。`, {
            requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
            limits: ['官方说明：关系类分页不是快照，total_number 不等于去重后可见条数；必须按 idstr 去重'],
        }),
        'comment.nested': row('unverified', `${READ_REASON}评论下的回复读取依赖同一条命令的回复参数。`, {
            requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
        }),
        'comment.locate': row('unverified', `${READ_REASON}按 id 定位单条评论依赖读取命令的筛选参数。`, {
            requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
        }),
        'identity.verify': row('unverified', '确认登录账号走 weibo-cli 的账号命令；本机未登录，故未验证。', {
            requiredPermissions: ['weibo-cli OAuth 登录'],
        }),
        'event.mentions': row('unavailable', '微博的艾特通知不对外开放给第三方读取；请让主人手动提供微博链接。'),
        'comment.publish': row('permission_required', `${WRITE_REASON}评论发表本版不开放。`, {
            requiredPermissions: ['评论写入授权', 'AI 生成内容标识'],
            limits: ['未经授权时不会尝试任何发送'],
        }),
        'comment.reply': row('permission_required', `${WRITE_REASON}回复评论本版同样不开放。`, {
            requiredPermissions: ['评论写入授权', 'AI 生成内容标识'],
        }),
        'publish.verify': row('unavailable', `${WRITE_REASON}没有写入能力，回读验证无从谈起。`),
        'media.read': row('unavailable', '本构建不解析图片与视频内容，只保留它们的地址。'),
        'user.profile': row('unverified', `${READ_REASON}作者资料读取走同一条 CLI 链路。`, {
            requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
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