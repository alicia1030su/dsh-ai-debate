/**
 * 把「出错了」翻译成「下一步做什么」（v0.2.39 §4.2）。
 *
 * ## 为什么错误提示要单独成一个模块
 *
 * 一个普通用户遇到的第一件事，往往不是「功能不会用」，而是某一步失败了。而失败信息
 * 在这个项目里以前有三种来源各说各话：`LlmError.code`、导入解析器的中文句子、以及
 * 各种 `throw new Error(...)` 的自由文本。于是同一个「没配模型」可能显示成
 * 「宿主有提供方，但没有可用模型」「调用失败」「LLM unavailable」三句不同的话，而
 * 三句都没有告诉用户点哪里。
 *
 * 这里把**能行动的错误**收成一张表：每种错误有一个稳定的 id、一句人话、以及按顺序
 * 排列的下一步。判据是「用户能照做」，不是「技术上准确」—— 技术上准确的错误码对用户
 * 没有用。
 *
 * ## 这个模块不做什么
 *
 * 它不做诊断。诊断（到底是 401 还是 DNS 失败）在 `llm.ts` 与 `host-llm.ts` 里，
 * 那些地方才看得到 HTTP 状态与错误消息。这里只做**翻译**：拿到已经判定的错误种类，
 * 给出该说的话。把诊断也放进来，就等于让一个纯函数去猜网络状态。
 */
/** 用户会遇到的、需要一句不同的话的错误种类。 */
export type GuideId = 
/** 宿主没有提供 llm 服务。 */
'no_host_model'
/** 宿主有服务，但没有可用模型（没登录 / 没配密钥）。 */
 | 'host_model_unavailable'
/** 自己配置的接口地址不对（协议、路径、端口）。 */
 | 'bad_base_url'
/** 密钥无效或过期。 */
 | 'auth_failed'
/** 接口说的话不是本插件认识的协议。 */
 | 'protocol_mismatch'
/** 导入文本不符合格式。 */
 | 'import_format'
/** 讨论里没有可用评论。 */
 | 'no_comments'
/** 材料不足以支撑一条回复。 */
 | 'insufficient_evidence'
/** 网络不可达。 */
 | 'network'
/** 模型超时。 */
 | 'timeout'
/** 剪贴板权限被拒。 */
 | 'clipboard_blocked'
/** 配额或频率限制。 */
 | 'quota';
/** 一条错误的可执行说明。 */
export interface Guide {
    readonly id: GuideId;
    /** 一句话说清发生了什么。不写错误码，不写堆栈。 */
    readonly title: string;
    /** 按顺序的下一步。第一条应当是最可能有效的。 */
    readonly next: readonly string[];
    /**
     * 是不是用户这边可以自己解决的。
     *
     * `false` 表示「先别试了，等一会儿或找维护者」—— 把可重试与不可重试分开，能省掉
     * 用户反复点按钮的那几分钟。
     */
    readonly retryable: boolean;
}
/** 取一条说明。未知 id 也能安全调用 —— 返回一条通用的，而不是抛错。 */
export declare function guideOf(id: GuideId): Guide;
/**
 * 把 `LlmError.code` 翻成 `GuideId`。
 *
 * 认不出来的码返回 `undefined`，由调用方决定说什么 —— 编一个「未知错误」的说明，
 * 等于假装我们知道原因。
 */
export declare function guideIdOfLlmCode(code: string): GuideId | undefined;
/** 全部 id。用于测试遍历，避免新增一条却忘了加断言。 */
export declare const GUIDE_IDS: readonly GuideId[];
/**
 * 从任意一个抛出来的错误里认出该给哪条说明。
 *
 * ## 为什么按结构认，不按消息文本认
 *
 * 消息文本是给人读的中文，会随着措辞改动而变；靠 `message.includes('没有可用模型')`
 * 判断，等于把文案变成协议。这里只认两样稳定的东西：
 *
 * - `LlmError.code`（一个封闭的枚举）
 * - 错误对象上显式的 `guide` 字段（调用方已经知道是哪一类时自己标）
 *
 * 都认不出来就返回 `undefined`，让调用方原样显示错误 —— 比编一句「未知错误」好。
 */
export declare function guideForError(error: unknown): Guide | undefined;
//# sourceMappingURL=guide.d.ts.map