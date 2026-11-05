/**
 * 微博 CLI 的授权就绪诊断：八个独立状态（v0.2.30 §三）。
 *
 * ## 为什么必须是八个，而不是一个布尔
 *
 * 「微博能不能读」这个问题的答案有八种不同的「不能」，而它们对应八个完全不同的
 * 下一步动作：
 *
 * | 状态 | 用户要做什么 |
 * | --- | --- |
 * | 没装 CLI | `npm install -g @weibo-ai/weibo-cli` |
 * | 版本太低 | 升级 CLI |
 * | 命令清单读不到 | 检查 CLI 是否正常、网络是否可达 |
 * | 没登录 | `weibo-cli auth login` |
 * | 没做开发者认证 | 在微博控制台扫码完成认证 |
 * | 没开通服务 | 领取体验服务或购买积分包 |
 * | 额度用完 | 充值或等额度重置 |
 * | 最近一次读取失败 | 看具体错误（可能是临时故障） |
 *
 * 把这些压成一个 `canRead: false`，用户就只能一个个试。而更糟的是反过来的那种
 * 压缩：把「没装」和「已就绪」压成两个值，中间六种全被当成「可以试试」——
 * 于是每次读取都失败在同一个地方，而面板一直是绿的。
 *
 * ## 与 `diagnostics.ts` 的分工
 *
 * `diagnostics.ts` 是**一次读取过程中**的诊断记录（读到了什么、错在哪一步），
 * 它回答「刚才那次读取发生了什么」。本模块回答的是**现在的授权链条走到哪一步**，
 * 是一个可以在没有任何读取发生时就给出的快照。
 *
 * 两者都需要，因为它们服务不同的时刻：前者用于事后排查，后者用于事前决策。
 *
 * ## 一个刻意的「读不到」
 *
 * 额度和「最近一次读取」在纯本地探测里读不到：
 *
 * - 额度要通过 `me` / 计费类命令查，而本版只调用读命令的允许列表里没有它，
 *   也不应该为了显示一个数字去碰账号管理。
 * - 最近一次读取是**本进程内**的记录，重启之后没有。
 *
 * 这两个都报 `unknown`，理由写清楚。`unknown` 不是 `unavailable`：
 * 前者是「本进程没查」，后者是「查了也不会有」。
 */
import type { WeiboCliStatus } from './cli.js';
/**
 * 一项就绪检查的状态。
 *
 * 刻意只有四种：能 / 不能 / 不知道 / 不适用。多一种就会有人在面板里为它写
 * 一段解释文字，而解释文字正是这个模块要消灭的东西。
 */
export type ReadinessState = 
/** 这一项通过了。 */
'ready'
/** 这一项没通过，`next` 里是下一步。 */
 | 'blocked'
/** 本进程没有证据，既不能说通过也不能说不通过。 */
 | 'unknown'
/** 这一项对这个平台不适用（目前没有用到，但保留以免将来用 `unknown` 冒充）。 */
 | 'not_applicable';
/** 八项检查各自的标识。用字符串而不是序号：它要出现在页面的 `data-check` 里。 */
export type ReadinessCheckId = 'installed' | 'version' | 'commands' | 'login' | 'certification' | 'activation' | 'quota' | 'last_read';
/** 顺序即页面顺序，也是「下一步该做什么」的优先级。 */
export declare const READINESS_ORDER: readonly ReadinessCheckId[];
/** 一项检查的展示形态。 */
export interface ReadinessCheck {
    readonly id: ReadinessCheckId;
    readonly title: string;
    readonly state: ReadinessState;
    /** 一句话说清现在是什么情况。必须是事实，不是「可能」。 */
    readonly detail: string;
    /** 用户能做的事，按顺序。`blocked` 时通常非空。 */
    readonly next: readonly string[];
}
/** 八项检查的整体快照。 */
export interface ReadinessSnapshot {
    readonly checks: readonly ReadinessCheck[];
    /**
     * 最早一个阻断项。
     *
     * 单独给出来，是因为「先修哪一个」有确定的答案：授权链是有顺序的，
     * 没登录的时候去查额度是浪费时间。页面用它来决定把哪一行画成当前项。
     */
    readonly blocking?: ReadinessCheckId;
    /**
     * 现在能不能发起一次真实读取。
     *
     * 这是八项推导出来的**结论**，不是第八项的替代品。判据只有一条：
     * 前六项全部 `ready`（额度与最近读取不阻断发起）。
     */
    readonly canRead: boolean;
    /**
     * 为什么不能读，一句话。`canRead` 为真时缺席。
     *
     * 与 `blocking` 的分工：后者说「哪一项」，这句说「那一项现在是怎样」。
     */
    readonly summary?: string;
}
/** 探测的原始输入，与本模块解耦，便于用固定数据测八项判断。 */
export interface ReadinessProbe {
    /** CLI 是否被找到。 */
    readonly cliInstalled: boolean;
    /** `version` 的输出，第一行。 */
    readonly cliVersion?: string;
    /** `commands list --available` 是否成功，以及失败原因。 */
    readonly commands?: {
        readonly ok: true;
        readonly count: number;
    } | {
        readonly ok: false;
        readonly reason: string;
    };
    /**
     * `doctor` 报告里三步的完成情况。
     *
     * 三项分别对应「注册或登录」「完成开发者认证」「开通服务」——这正是 CLI 自己
     * 打印的三行。把它们分开是这一版的关键：v0.2.29 之前这三项被压进一个
     * `serviceActive` 布尔，于是「没登录」和「没开通服务」在面板上长得一样。
     */
    readonly doctorSteps?: readonly {
        readonly label: string;
        readonly ok: boolean;
    }[];
    /** `doctor` 的整体退出码与输出，用于「解析不出步骤」时的兜底措辞。 */
    readonly doctorRaw?: {
        readonly code: number;
        readonly output: string;
    };
    /**
     * 只知道退出码、不关心输出时的简写。
     *
     * 与 `doctorRaw` 重复，但被调用方需要：provider 手上只有退出码时也要能把
     * 「exit 1 但没有步骤行」这句话说准，否则措辞会退回到「本次没有运行 doctor」——
     * 那是一句不成立的话，它跑了。
     */
    readonly doctorExitCode?: number;
    /** 额度。本进程通常给 `unknown`。 */
    readonly quota?: {
        readonly known: true;
        readonly detail: string;
    } | {
        readonly known: false;
        readonly reason: string;
    };
    /** 本进程内最近一次真实读取。 */
    readonly lastRead?: {
        readonly ok: boolean;
        readonly at: string;
        readonly stage: string;
        readonly message: string;
    };
    /** 最近一次错误，用于给「读取失败」那一项提供细节。 */
    readonly lastError?: {
        readonly at: string;
        readonly state: string;
        readonly message: string;
    };
}
/** CLI 的六个状态到「装在不在 / 通了没通」的映射，保持与 `cli.ts` 一致。 */
export declare function isInstallFailure(status: WeiboCliStatus): boolean;
/**
 * 组装八项检查。
 *
 * ## 顺序是有意义的
 *
 * 每一项的 `state` 只看它自己，但 `blocking` 取第一个 `blocked`。
 * 这样「已安装但没登录」会指出 `login`，而不是把 `certification` 也标红——
 * 后者在没登录的时候根本无从判断，标红它是在制造噪音。
 *
 * ## 没有证据时说「不知道」，不说「未完成」
 *
 * CLI 没装的时候，`doctor` 一次都没跑过。这时把登录状态报成 `blocked`
 * 是一个关于账号的断言，而我们没有任何证据——用户会去找一个不存在的登录问题。
 */
export declare function buildReadiness(probe: ReadinessProbe): ReadinessSnapshot;
/**
 * 把快照压成一行中文，给日志和不带面板的地方用。
 *
 * 刻意不返回「已就绪 / 未就绪」两个值：那句话会被人复制到别处，
 * 而它丢掉的信息正是这个模块存在的理由。
 */
export declare function describeReadiness(snapshot: ReadinessSnapshot): string;
//# sourceMappingURL=readiness.d.ts.map