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
/** 顺序即页面顺序。 */
export declare const READINESS_ORDER: readonly ReadinessCheckId[];
/**
 * 授权链的因果顺序——与 `READINESS_ORDER` **不同**，这一点是 v0.2.30 用真实
 * CLI 状态测出来才发现的。
 *
 * ## 为什么不能拿展示顺序当因果顺序
 *
 * 2026-11 在本机用 `@weibo-ai/weibo-cli@0.9.8` 实测（登录已完成、认证与开通未完成）：
 *
 * ```
 * ✓ 注册或登录: 一个天真的矿哥
 * × 完成开发者认证
 * × 开通服务
 *
 * commands list --available → { total: 75, available_count: 0, commands: [] }
 * ```
 *
 * 页面展示顺序是「安装/版本/命令清单/登录/认证/开通/额度/最近读取」——命令清单排在
 * 登录前面，因为它和「能不能读」最直接相关。但按那个顺序取第一个阻断项，得到的
 * 结论是「命令清单不可用」。
 *
 * 而命令清单为空是**结果**：没有开发者认证与服务，账号本来就没有可用命令。
 * 让用户先去查命令清单，等于让他排查一个不是原因的现象。
 *
 * 因果顺序是另一条链：
 *
 * ```
 * 装上 → 版本对 → 登录 → 开发者认证 → 开通服务 → 才有命令 → 才能读
 * ```
 *
 * `blocking` 沿这条链取第一个阻断项，用户就会得到「去完成扫脸认证」这个
 * 真正能解开死结的下一步。
 */
export declare const CAUSAL_ORDER: readonly ReadinessCheckId[];
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
    /**
     * 这次快照是什么时候取的（ISO）。
     *
     * ## 为什么诊断必须带时间（v0.2.31 §六）
     *
     * 授权状态是会变的：令牌会过期、服务会到期、额度会用完。一个不带时间的
     * 「已登录」看起来像永久事实，而它只是某一刻的观测——v0.2.30 的 README
     * 就是这么把一次成功登录写成了静态结论，十二小时后就与事实不符。
     *
     * 有了这个字段，页面就能说「3 小时前检查的」，而不是「已登录」。
     */
    readonly checkedAt: string;
    /**
     * 这份快照多久之后不该再当作现状（毫秒）。
     *
     * 取 10 分钟：比任何一次人工排查的节奏都短，又不会让页面每次重绘都重新探测
     * （探测要跑 2~3 个 CLI 子进程）。超过之后页面必须标注「这是旧结果」，
     * 而不是继续把它画成绿的。
     */
    readonly staleAfterMs: number;
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
    /**
     * 本机登录凭据的存在性（v0.2.31 §六）。
     *
     * 与 `doctorSteps` 的分工：`doctor` 只说「登录这一项过了没有」，而这一项说
     * 「这台机器上到底有没有一条登录记录」。两者都缺时才说得准那种失败：
     * 有记录但过不了 = 令牌失效；没记录 = 从没登录过。
     */
    readonly credential?: {
        readonly state: 'absent' | 'recorded' | 'unknown';
        readonly username?: string;
        readonly recordedAt?: string;
        readonly storage?: string;
        readonly reason?: string;
        /** 本进程看到的凭据环境（v0.2.34）。 */
        readonly env?: 'production' | 'development';
        /** 本进程实际查找的配置目录（路径本身不含秘密）。 */
        readonly configDir?: string;
        /** 当前环境没有记录、另一套有：这就是「登录状态消失」的共同形状。 */
        readonly otherEnv?: {
            readonly env: 'production' | 'development';
            readonly recordedAt?: string;
            readonly username?: string;
        };
        /** 刷新锁的存在性。新鲜（stale=false）说明另一个进程正在刷新。 */
        readonly refreshLock?: {
            readonly present: boolean;
            readonly ageMs?: number;
            readonly stale?: boolean;
        };
    };
    /**
     * 授权主机的可达性（v0.2.33 §六）。
     *
     * 只在「有登录记录但拿不到令牌」时才有意义：它把「要么网络、要么令牌」这句
     * 两难的话收敛成一条确定的结论。`undefined` 表示本次没有探测——措辞必须
     * 退回两种可能，不能假装知道。
     */
    readonly network?: {
        readonly state: 'reachable';
        readonly status: number;
    } | {
        readonly state: 'unreachable';
        readonly reason: string;
    } | {
        readonly state: 'unknown';
        readonly reason: string;
    };
    /**
     * 现在的时间（ISO），用于给快照打时间戳。
     *
     * 从外面传进来而不是在这里 `new Date()`：这个函数必须是纯的，否则同一份
     * 输入两次调用得到不同结果，测试没法断言「同样的状态得到同样的快照」。
     */
    readonly now?: string;
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
 * 一份快照多久之后不该再当作现状。
 *
 * 10 分钟：比任何一次人工排查的节奏都短，又不会让页面每次重绘都重新探测
 * （探测要跑 2~3 个 CLI 子进程，每个几百毫秒）。
 */
export declare const READINESS_TTL_MS: number;
/**
 * 快照是否已经过期。
 *
 * 页面必须用它决定标不标「这是旧结果」。不标的话，一次十分钟前说「已就绪」的
 * 探测会在令牌过期之后继续显示成绿的——而那正是 v0.2.30 文档犯的同一个错，
 * 只是从 README 搬到了界面上。
 */
export declare function readinessIsStale(snapshot: ReadinessSnapshot, now?: number): boolean;
/**
 * 把快照压成一行中文，给日志和不带面板的地方用。
 *
 * 刻意不返回「已就绪 / 未就绪」两个值：那句话会被人复制到别处，
 * 而它丢掉的信息正是这个模块存在的理由。
 */
export declare function describeReadiness(snapshot: ReadinessSnapshot): string;
//# sourceMappingURL=readiness.d.ts.map