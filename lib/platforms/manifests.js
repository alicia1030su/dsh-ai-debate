/**
 * Future platform manifests.
 *
 * A manifest is **not** an adapter. It is the honest, written-down description of
 * what a platform could support, what would be needed to support it, and where
 * the current state of the research is. v0.2.0 ships manifests only — no Weibo,
 * Zhihu, Xiaohongshu or Douyin code, and therefore no claim in the settings page
 * or the README that any of them works.
 *
 * Two rules this file follows, because breaking either is how a project starts
 * lying about platform support:
 *
 * 1. **No invented API.** Every row below says `unavailable` or
 *    `permission_required`, never `supported`. There is no `getComments()`
 *    sketch, no guessed endpoint and no placeholder response shape.
 * 2. **No guessed capability.** "The platform has comments, therefore we can read
 *    them" is a claim about permissions and quotas, not about the existence of a
 *    comments section. The `requiredPermissions` fields name what would have to
 *    be granted before any code is worth writing.
 *
 * The manifests are deliberately data, not code: the settings page renders them,
 * the tests check them, and turning one into a real adapter means adding a
 * `provider.ts` next to it — never editing the agent core.
 */
/** Declare "not implemented yet, and here is why" in one line. */
function pending(reason, required = []) {
    return required.length > 0
        ? { state: 'permission_required', reason, requiredPermissions: [...required] }
        : { state: 'unavailable', reason };
}
/** Build a full matrix where every row is explicitly not-yet-implemented. */
function notImplemented(platform, rows) {
    const defaults = (name) => rows[name] ?? pending(`${platform} 适配器尚未实现`);
    const all = [
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
    const capabilities = Object.fromEntries(all.map((name) => [name, defaults(name)]));
    return {
        platform,
        declaredAt: new Date().toISOString(),
        capabilities,
        notes: ['本平台只有 manifest，没有适配器；任何能力都不是 supported。'],
    };
}
/**
 * Weibo.
 *
 * The trajectory here is the clearest of the four: an official open platform with
 * OAuth, but with developer qualification, quota and an AI-content labelling
 * requirement that all have to be satisfied before a single reply may be posted.
 */
export const weiboManifest = {
    id: 'weibo',
    displayName: '微博',
    shape: 'microblog',
    urlShapes: ['https://weibo.com/<uid>/<mid>', 'https://m.weibo.cn/detail/<mid>'],
    conversationShape: '正文 → 一级评论 → 评论回复。转发与引用是**独立的边**，不能当成父子回复：' +
        '一条转发既属于新的时间线，也指向原微博，硬塞进 reply 树会让争论关系被错误还原。',
    authModel: 'OAuth 2.0 授权码；访问令牌按 scope 授予，读与写是不同权限。',
    research: 'documented',
    capabilities: notImplemented('weibo', {
        'thread.read': pending('需要开放平台读取权限与开发者资格', ['statuses:read']),
        'comment.list': pending('需要评论读取权限', ['comments:read']),
        'comment.publish': pending('需要写权限；且发布 AI 生成内容需遵守平台的 AI 内容标识要求', [
            'comments:write',
            'AI 内容标识',
        ]),
        'identity.verify': pending('需要用户信息授权', ['user:read']),
        'event.mentions': pending('需要艾特通知读取权限', ['mentions:read']),
    }),
    prerequisites: [
        '注册开放平台应用并取得开发者资格',
        '拿到 comments:read 与 comments:write 的 scope 授权',
        '确认配额能满足一次完整楼层读取（分页会放大请求数）',
        '确认 AI 生成内容的标识方式，并把它做进发布路径',
    ],
    constraints: [
        '**没有真实权限前不得宣称微博可用**：本版本只到 manifest 与数据映射。',
        '配额按应用计，分页读取很容易触顶，必须先设计好退避与降级。',
        '转发/引用关系必须单独建模，不能复用 replies_to。',
    ],
};
/**
 * Zhihu.
 *
 * The read path is the plausible one: questions, answers and articles are public.
 * Comment creation is the part that is not obviously available to a third party,
 * so a candidate that the owner copies out by hand is the honest fallback — never
 * a fake "published" result.
 */
export const zhihuManifest = {
    id: 'zhihu',
    displayName: '知乎',
    shape: 'qa',
    urlShapes: ['https://www.zhihu.com/question/<qid>', 'https://zhuanlan.zhihu.com/p/<pid>'],
    conversationShape: '问题 → 回答或文章 → 评论 → 评论回复。问题本身不是发言者，"答主"才是，' +
        '所以 `author` 属于回答节点而不是问题节点。',
    authModel: '官方开放平台的授权方式；未获授权时只能读取公开内容。',
    research: 'documented',
    capabilities: notImplemented('zhihu', {
        'thread.read': pending('问题与回答可公开读取；适配器尚未实现'),
        'comment.list': pending('评论读取需要开放平台能力或页面解析，尚未实现'),
        'comment.publish': pending('评论发表权限不明确；未获授权时只能生成候选让主人手动发布', ['创作者的评论发表权限']),
        'media.read': pending('图片内容读取未实现'),
    }),
    prerequisites: [
        '确认开放平台当前是否提供评论读取与发表能力',
        '若不提供，明确降级为「只读 + 手动发布」，并在界面上说清楚',
        '把问题/回答/文章三种节点投影到统一的 ConversationNode（模型已就绪，见 src/conversation.ts）',
    ],
    constraints: [
        '无合法发表能力时，允许生成供手动发布的候选，**不能模拟接口成功**。',
        '问题的作者不是争论参与者；把问题作者当答主会让对手识别直接错位。',
    ],
};
/**
 * Xiaohongshu.
 *
 * Manifest only. The comment API situation is not clearly documented for third
 * parties, and inventing one would be worse than shipping nothing.
 */
export const xiaohongshuManifest = {
    id: 'xiaohongshu',
    displayName: '小红书',
    shape: 'note',
    urlShapes: ['https://www.xiaohongshu.com/explore/<noteId>'],
    conversationShape: '笔记 → 评论 → 子评论。层级浅，通常两级足够。',
    authModel: '未确认；公开文档不足以支撑实现。',
    research: 'survey',
    capabilities: notImplemented('xiaohongshu', {}),
    prerequisites: [
        '确认官方是否提供评论读写的开放能力',
        '确认开发者资格与配额',
        '在权限明确前**不写任何评论 API 代码**',
    ],
    constraints: ['目前只有 manifest 与数据映射设想，不声明任何能力。'],
};
/** Douyin. Manifest only, same reasoning as Xiaohongshu. */
export const douyinManifest = {
    id: 'douyin',
    displayName: '抖音',
    shape: 'video',
    urlShapes: ['https://www.douyin.com/video/<awemeId>'],
    conversationShape: '视频 → 评论 → 评论回复。视频本身没有"正文"，描述字段很短。',
    authModel: '未确认；开放平台主要面向企业开发者。',
    research: 'survey',
    capabilities: notImplemented('douyin', {}),
    prerequisites: [
        '确认开放平台对个人开发者的准入',
        '确认评论读写权限与配额',
        '在权限明确前不写任何评论 API 代码',
    ],
    constraints: ['只有 manifest；不声明任何能力，也不猜测接口形状。'],
};
/** Every future platform, in display order. */
export const PLATFORM_MANIFESTS = [
    weiboManifest,
    zhihuManifest,
    xiaohongshuManifest,
    douyinManifest,
];
/** Look one manifest up by id. */
export function manifestOf(id) {
    return PLATFORM_MANIFESTS.find((entry) => entry.id === id);
}
//# sourceMappingURL=manifests.js.map