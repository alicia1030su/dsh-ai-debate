/**
 * 离线工作流的完整链路（v0.2.30 §二）。
 *
 * ## 十一步，每一步都要能被页面单独说清
 *
 * ```
 * 导入 → 预览 → 确认 → 分析 → 选中 → 人格 → 生成 → 编辑 → 安全评估 → 人工确认 → 复制
 * ```
 *
 * 任务书要求这条链路「可独立解释」。落到实处是：每一步失败都有一个不属于
 * 「未知错误」的原因，且原因说的是**下一步能做什么**，而不是「操作失败」。
 *
 * ## 这里没有第二个辩论引擎
 *
 * 分析用 `analyzeDispute`，生成用 `generateReply`，评估用 `guardOutput`，
 * 压缩用 `compressContext`，简报用 `buildBrief` + `validateBrief`——与真实平台
 * 走的是**同一批函数**。本文件做的是把它按离线场景的顺序串起来，并在每一个
 * 需要写库的地方落库。任何一行「自己判断谁在跟谁吵」的代码都意味着出现了
 * 第二个引擎，那是任务书明确禁止的。
 *
 * ## 终点是剪贴板
 *
 * `copyReply` 返回纯文本，不调用任何发布路径。这不是「暂时不支持发表」的委婉说法：
 * `runPublish` 对导入会话有显式拒绝，`platform: 'manual'` 在注册表里不存在，
 * 两道门都在。
 */
import type { CollectedThread } from '../collector.js';
import type { Dispute } from '../analyzer.js';
import { type PersonaConfig, type PersonaStyle } from '../persona.js';
import type { ResolvedConfig } from '../config.js';
import type { LlmClient } from '../llm.js';
import type { DebateStore, StoredManualImport, StoredSession } from '../store.js';
import type { CopyableReply } from './session.js';
import type { CorrectionAudit } from './corrections.js';
import type { ImportStructure } from './preview.js';
import { MANUAL_CAPABILITIES, MANUAL_IMPORT } from './source.js';
/**
 * 工作流的十一步。
 *
 * 用字符串联合而不是枚举：它要出现在页面的 `data-step`、日志和错误消息里，
 * 数字会让这三处都变得难以阅读。
 */
export type ManualStep = 'import' | 'preview' | 'confirm' | 'analyze' | 'select' | 'persona' | 'generate' | 'edit' | 'assess' | 'approve' | 'copy';
/** 每一步的中文名，供页面与错误消息共用一份。 */
export declare const STEP_TITLES: Readonly<Record<ManualStep, string>>;
/** 一步的结果。失败时 `reason` 必须说清「下一步能做什么」。 */
export interface StepResult<T> {
    readonly ok: boolean;
    readonly step: ManualStep;
    readonly value?: T;
    readonly reason?: string;
    /** 用户能做的事，按顺序。失败时通常非空。 */
    readonly next?: readonly string[];
}
/**
 * 四种人格，供页面选择。
 *
 * 直接从 `PERSONAS` 生成，不另抄一份：抄一份意味着将来加了第五种人格，
 * 离线流程看不到它，而且没有任何测试会发现。
 */
export interface PersonaOption {
    readonly id: PersonaStyle;
    readonly name: string;
    readonly summary: string;
    readonly approach: string;
}
export declare function personaOptions(): readonly PersonaOption[];
/** 校验一个人格 id，返回可写进会话的配置。 */
export declare function personaOf(style: string | undefined, config: ResolvedConfig, overrides?: {
    readonly intensity?: number;
    readonly maxLength?: number;
}): PersonaConfig;
export interface ManualAnalyzeInput {
    readonly imported: StoredManualImport;
    /** 主人是谁（导入内容里的某个作者名）。不填时用原帖作者。 */
    readonly ownerName?: string;
    /** 要回复哪一条。不填时用最后一条发言。 */
    readonly targetPostId?: string;
    readonly persona: PersonaConfig;
    readonly config: ResolvedConfig;
    readonly now?: () => number;
}
export interface ManualAnalyzeOutput {
    readonly collected: CollectedThread;
    readonly dispute: Dispute;
    readonly targetPostId: string;
    readonly session: StoredSession;
    /** 参与者的展示列表，与真实分析输出的形状一致。 */
    readonly participants: readonly {
        readonly name: string;
        readonly postCount: number;
        readonly isOwner: boolean;
        readonly isOpponent: boolean;
    }[];
    /** 注入检测的结果，按发言逐条。与 `runAnalysis` 的做法一致。 */
    readonly securityNotes: readonly string[];
}
/**
 * 分析一份导入的讨论，并落库成会话。
 *
 * ## 为什么会话要写两次
 *
 * 第一次写入是「会话已创建」，第二次补上分析结果（`ownerKey`、`disputeFloorPostId`、
 * 参与者）。分开是因为分析可能抛错：抛错时用户应该看到一个「导入了但没分析成功」
 * 的会话，而不是「什么都没有」——前者可以重试，后者得从头再来一遍。
 *
 * 但它们必须在同一个会话 id 上。所以第一次写入就定下 id，第二次按 id 更新。
 */
export declare function analyzeImport(store: DebateStore, input: ManualAnalyzeInput): Promise<StepResult<ManualAnalyzeOutput>>;
export interface ManualSelectInput {
    readonly sessionId: string;
    /** 换成这个作者当主人。 */
    readonly ownerName?: string;
    /** 换成这一条当回复目标。 */
    readonly targetPostId?: string;
    readonly persona: PersonaConfig;
    readonly config: ResolvedConfig;
    readonly now?: () => number;
}
/**
 * 重新分析：换主人或换目标。
 *
 * ## 为什么要重新分析而不是改两个字段
 *
 * 主人变了，`ownerKey`、`ownerIdentityEvidence`、争论对象、`floorPostId` 全都变；
 * 目标变了，对手和争论链也变。只改字段会让会话内部自相矛盾——而发表路径
 * 正是靠这些字段判断「这段话是给谁写的」。
 *
 * 所以这里重跑分析器，然后把结果整体覆盖到同一个会话 id 上。候选**全部作废**：
 * 它们是对着旧的主人和旧的对手写的。
 */
export declare function reselectImport(store: DebateStore, input: ManualSelectInput): Promise<StepResult<ManualAnalyzeOutput>>;
export interface ManualReviseInput {
    readonly sessionId: string;
    /** 修正清单。会经过 `sanitizeCorrections`，非法字段被丢弃。 */
    readonly corrections: unknown;
    readonly persona: PersonaConfig;
    readonly config: ResolvedConfig;
    readonly now?: () => number;
}
export interface ManualReviseOutput {
    readonly session: StoredSession;
    readonly structure: ImportStructure;
    readonly audit: readonly CorrectionAudit[];
    /** 因修正而作废的候选数。 */
    readonly discardedCandidates: number;
}
/**
 * 对已建好的会话应用一批修正。
 *
 * ## 与 `reselectImport` 的分工
 *
 * `reselectImport` 改的是「谁在说话、回给谁」（主人与目标），内容不变；
 * 这里是内容本身被纠正了（作者认错、回复目标错了、原帖标错了）。
 *
 * 两者都必须重跑分析，而且都必须**清空候选**——原因一样：已有候选是对着
 * 旧的那份讨论写的，而它的安全评估引用的是旧正文里的证据。留下它们，
 * 「这段文字通过了安全评估」这句话就会指向一份已经不存在的讨论。
 *
 * ## 为什么不能靠改 `imported` 就完事
 *
 * `imported` 只存原始解析结果 + 修正清单。会话上的 `comments`、`ownerKey`、
 * `disputeFloorPostId`、`triggerPostId` 全是分析产物，必须一起重算，
 * 否则「会话显示的作者」与「分析用的作者」会分叉。
 */
export declare function reviseImport(store: DebateStore, input: ManualReviseInput): Promise<StepResult<ManualReviseOutput>>;
export interface ManualGenerateInput {
    readonly sessionId: string;
    /** 要回复哪一条。不填时用会话记下的那一条。 */
    readonly targetPostId?: string;
    readonly persona?: Partial<PersonaConfig>;
    readonly ownerInstruction?: string;
    readonly config: ResolvedConfig;
    readonly llm: () => LlmClient;
    readonly signal?: AbortSignal;
    readonly progress?: (message: string) => void;
}
export interface ManualGenerateOutput {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly text: string;
    readonly version: number;
    readonly violations: readonly string[];
    readonly notes: readonly string[];
    readonly securityDecision: 'allow' | 'review' | 'block';
    readonly securityReasons: readonly string[];
    readonly needsInput: boolean;
    readonly needsInputReason?: string;
}
/**
 * 为导入的会话生成候选。
 *
 * ## 与 `runGeneration` 的关系
 *
 * 它是**同一套步骤的不同入口**，因为 `runGeneration` 有三处真实平台专用的逻辑：
 * 读适配器（离线没有）、读配置里的主人绑定（离线不用）、发表目标校验用适配器
 * （离线用本地解析器）。除此之外的每一步——重投影、`analyzeDispute`、
 * `compressContext`、`buildBrief` + `validateBrief`、`generateReply`、
 * `guardOutput`、候选版本分配——都在这里原样重现。
 *
 * 之所以不把 `runGeneration` 参数化，是因为那会让真实发表路径上多出三个
 * 「如果这是离线会话」的分支，而那条路径的每一项检查都是防发错人的。
 * 复制一份步骤、共用全部函数，比让真实路径长出分支安全。
 */
export declare function generateForImport(store: DebateStore, input: ManualGenerateInput): Promise<StepResult<ManualGenerateOutput>>;
export interface ManualCopyInput {
    readonly sessionId: string;
    readonly candidateId: string;
    /** 用户看到的正文。必须与存下的一致，否则说明页面上的不是将要复制的东西。 */
    readonly visibleText?: string;
}
/**
 * 复制之前的那一步。
 *
 * ## 为什么这也要走一次服务端
 *
 * 因为「复制」是这个流程的终点，而终点必须能回答三个问题：
 * 复制的是哪一份正文、它是回给谁的、它当时通过了什么评估。
 * 让页面自己从 state 里拼这三个答案，等于让页面去猜——而页面拿到的候选正文
 * 可能已经被编辑过（编辑会 bump 版本，但页面上的旧 state 不会自己刷新）。
 *
 * 所以复制前问一次服务端，由它给出**存下来的那一份**。正文与 `visibleText`
 * 不一致时拒绝：那不是同一段文字，复制出去会和用户看到的不同。
 */
export declare function copyReply(store: DebateStore, input: ManualCopyInput): Promise<StepResult<CopyableReply>>;
export interface ManualEditInput {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly text: string;
    readonly config: ResolvedConfig;
}
/**
 * 编辑正文并重新评估。
 *
 * ## 为什么必须重新评估
 *
 * 评估记录绑定的是「这一版正文 + 这个目标」。改了正文却留着旧记录，
 * 就等于让复制环节声称「这段文字通过了评估」——通过的是另一段文字。
 *
 * `runtime.ts` 的 `editCandidate` 已经因为同样的理由在 v0.2.26 补上了重评估；
 * 这里做同一件事，理由相同。差别只有一处：主人身份只有昵称。
 */
export declare function editImportedCandidate(store: DebateStore, input: ManualEditInput): Promise<StepResult<{
    readonly candidateVersion: number;
    readonly textHash: string;
}>>;
export interface ManualApproveInput {
    readonly sessionId: string;
    readonly candidateId: string;
    /** 用户点确认时看到的那一版正文。与存下的不一致时拒绝。 */
    readonly approvedText: string;
}
/**
 * 人工确认。
 *
 * ## 这里的「确认」确认的是什么
 *
 * 不是「可以发表」——离线流程不发表。它确认的是：**这段正文就是我读过的、
 * 我要复制的那一段**。绑定的是正文的哈希与候选版本，与真实流程的批准记录同一语义。
 *
 * 记录写在会话的候选上，不新建批准台账：批准台账的用途是「一次授权一次发表」，
 * 而离线流程没有发表，往那里写会让台账声称一次并不存在的授权。
 */
export declare function approveImportedCandidate(store: DebateStore, input: ManualApproveInput): Promise<StepResult<{
    readonly approvedAt: string;
}>>;
/** 页面上要显示的能力表（人工导入固定那一份）。 */
export declare function manualCapabilityRows(): typeof MANUAL_CAPABILITIES;
/** 页面上要显示的来源标识（人工导入固定那一份）。 */
export declare function manualSource(): typeof MANUAL_IMPORT;
/**
 * 会话当前处在哪一步。
 *
 * 从存下来的事实推导，不存一个 `step` 字段：存字段意味着它可以和候选、批准、
 * 编辑记录三者不一致，而页面会把那个陈旧的 step 当成事实渲染。
 * 这与 `workbench.ts` 的 `deriveWorkbenchState` 是同一条理由。
 */
export declare function stepOf(session: StoredSession | undefined): ManualStep;
/** 十一步的固定顺序，页面按它画进度。 */
export declare const MANUAL_STEP_ORDER: readonly ManualStep[];
/** 十一步里，前六步在会话存在之前就完成了；提供它们的完成标记。 */
export declare function completedSteps(session: StoredSession | undefined): readonly ManualStep[];
//# sourceMappingURL=workflow.d.ts.map