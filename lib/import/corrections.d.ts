/**
 * 交互式关系纠错：用户的修正作为**一层独立数据**，不覆盖解析结果（v0.2.31 §四）。
 *
 * ## 为什么修正是独立的一层，而不是「解析器多几个开关」
 *
 * 一份导入的讨论有三层事实，三层的可信度完全不同：
 *
 * | 层 | 内容 | 谁说的 |
 * | --- | --- | --- |
 * | 原始事实 | 用户粘进来的原文，逐行保留 | 用户（他看到了什么） |
 * | 解析结果 | 谁是作者、谁在回谁、第几楼 | 插件（猜的） |
 * | 用户修正 | 「这一条其实是他说的」「这条不是回他」 | 用户（他知道实际情况） |
 *
 * 如果修正直接改写解析结果，三层就塌成一层：用户再也无法回答「插件到底看懂了多少」
 * 和「我改过哪些」，而这两个问题在出错时是唯一有用的线索。
 *
 * 所以本模块只做一件事：**给定解析结果 + 修正清单，算出修正后的视图**。
 * 原始解析结果始终留在 `StoredImport` 里，随时可以重新算出「没改之前是什么样」。
 *
 * ## 一条硬规则：修正可以改「关系是什么」，不能改「谁说的」
 *
 * 用户指定「这条在回 local:2」，这个**指向**是明确的（不是从昵称猜的），所以它在
 * 界面上是 `stated` / 「确定」。但这不等于「平台证明过」——平台从未参与，这份
 * 内容来自剪贴板，修正清单还是一段可编辑的本地 JSON。
 *
 * 所以真正的分界线不在 `certainty`，在**依据**：
 *
 * - `certainty` 回答「这条关系是怎么定下来的」：明确的 id，还是按昵称推的。
 * - `basis` 回答「**谁**说它是这样」：平台返回的、你手工指定的、还是解析器认的。
 *
 * 两者混为一谈会出具体事故：`replies_to` 边带着「平台返回了被回复的 post id」
 * 进入图、转录和模型上下文，而它其实来自用户的一次点击。v0.2.31 之前正是如此
 * （硬编码在 `conversation-bridge.ts` 里），现在依据随边一起传下去。
 *
 * 反向的升级永远不做：昵称猜出来的关系不能变成 `stated`，`unconfirmed` 压过一切。
 * 那一条看 `manual.ts` 的 `resolutionOf` 与 `toCollectedThread`。
 */
import type { ImportedDiscussion, ImportIssue } from './manual.js';
/** 单条发言的修正。 */
export interface CommentCorrection {
    /** 发言 id（`local:1` 或用户自己给的 id）。 */
    readonly id: string;
    /** 改成这个作者名。 */
    readonly author?: string;
    /**
     * 同名不同人时，给它一个可区分的本地标签。
     *
     * 与 `author` 的区别是用途：`author` 是「名字认错了」，这个是「名字没错，
     * 但这里有两个人」。最终显示名会变成「甲（2）」，而修正记录里写明是拆分。
     */
    readonly localIdentity?: string;
    /**
     * 明确的回复目标。
     *
     * - `'root'`：在回原帖；
     * - `'none'`：解除回复关系（它确实没有在回谁）；
     * - 其他字符串：那条发言的 id。
     */
    readonly replyTo?: string;
    /** 用户明确标记「这条关系我确认不了」。保留关系，但标为不可确认。 */
    readonly unconfirmed?: boolean;
}
/** 一整份修正清单。 */
export interface ImportCorrections {
    /** 清单格式版本。将来改结构时用它判断旧数据。 */
    readonly version: 1;
    /** 修正时间。 */
    readonly revisedAt: string;
    readonly entries: readonly CommentCorrection[];
    /**
     * 把某一条评论提升为原帖。
     *
     * 支持这个动作是因为粘贴顺序不一定等于时间顺序：用户可能先粘了评论、
     * 后补原帖，或者原帖被 OCR 识别成了第二条。缺了它，用户唯一的办法是
     * 手工重排整段文本再导一次。
     */
    readonly rootFromCommentId?: string;
    /** 把当前原帖降为一条普通评论。与 `rootFromCommentId` 通常一起用。 */
    readonly demoteRoot?: boolean;
}
/** 一条修正做了什么，逐条可读。审计与预览共用。 */
export interface CorrectionAudit {
    readonly id: string;
    readonly field: 'author' | 'identity' | 'replyTo' | 'unconfirmed' | 'root';
    /** 修正前。`undefined` 表示之前没有这个字段。 */
    readonly before?: string;
    /** 修正后。 */
    readonly after: string;
    /** 一句话说明，直接显示给用户。 */
    readonly note: string;
}
/** 应用修正的结果。 */
export interface CorrectionResult {
    /** 修正后的讨论。原对象不变。 */
    readonly discussion: ImportedDiscussion;
    /** 逐条修正记录。 */
    readonly audit: readonly CorrectionAudit[];
    /**
     * 应用过程中发现的问题。
     *
     * 修正本身也可能错：指向一条不存在的发言、把原帖提升成自己的回复、
     * 两条修正互相矛盾。这些必须报出来，且**不能静默丢弃修正**——
     * 用户改了却什么也没发生，比改错更让人困惑。
     */
    readonly issues: readonly ImportIssue[];
    /** 修正是否真的改变了什么。全为空时调用方可以省掉一次落盘。 */
    readonly changed: boolean;
}
/**
 * 应用修正。
 *
 * ## 确定性
 *
 * 同样的 `(discussion, corrections)` 必须得到同样的结果，且不能依赖对象顺序。
 * 这一点有实际后果：会话落盘时只存原始解析结果 + 修正清单，每次读取重新应用。
 * 如果应用过程不确定，刷新前后的图会不一样，而目标校验会因此全部失败
 * （它比对的是正文哈希与作者）。
 */
export declare function applyCorrections(discussion: ImportedDiscussion, corrections: ImportCorrections | undefined): CorrectionResult;
/** 空修正清单。界面首次渲染时用它，避免到处判 `undefined`。 */
export declare function emptyCorrections(now: string): ImportCorrections;
/**
 * 修正清单里是否有内容。
 *
 * 落盘前用它决定要不要写这个字段：空清单写进去只是噪音，而且会让
 * 「这份导入被人改过」这句话在界面上无端出现。
 */
export declare function hasCorrections(corrections: ImportCorrections | undefined): boolean;
/**
 * 校验一份来路不明的修正清单（HTTP 入参会带一份）。
 *
 * ## 为什么在边界上校验，而不是相信调用方
 *
 * 修正清单会被写进会话文件，也会从页面的 POST 体里读回来。两者都可能被手改
 * ——本项目的惯例是：只要一个字段能影响分析结论，就在读入时校验它。
 * 这里不追求「修复」非法输入，只保证它不会变成一堆奇怪的字段进到下游。
 */
export declare function sanitizeCorrections(raw: unknown): ImportCorrections | undefined;
//# sourceMappingURL=corrections.d.ts.map