/**
 * 一次微博读取的分阶段耗时（v0.2.33 §七）。
 *
 * ## 为什么需要它：40 秒不是一个可以讨论的数字
 *
 * v0.2.32 的真实验收记录里写着「直接跑 CLI 单页约 8～9 秒，插件 `getThread()` 约 40 秒」。
 * 40 秒这个数只能说明「慢」，说明不了**慢在哪**：可能是进程启动、可能是登录态探测、
 * 可能是命令目录读了两遍、也可能是网络。没有分段，任何优化都只能是猜。
 *
 * 更糟的是猜错的代价：如果瓶颈在「每页都重跑一次 `doctor`」，去优化 JSON 解析不会有任何
 * 效果，而优化者会以为「已经优化过了」。所以本模块先只做一件事——**把时间按阶段记账**。
 *
 * ## 记什么，不记什么
 *
 * 记：阶段名、毫秒数、CLI 子进程次数、子进程总耗时。
 * 不记：命令的完整参数、任何 token、任何响应正文。诊断面板会把这段结构原样显示，
 * 所以它必须天生可公开。
 *
 * ## 为什么子进程次数比耗时更重要
 *
 * 耗时随机器负载浮动，同一份代码在两台机器上可以差一倍；**子进程次数是结构性的**——
 * 一次读取启动了 9 个 `weibo-cli`，就是 9 次进程创建、9 次 PowerShell 凭据读取。
 * 它是可以直接对照代码审查的量，也是这次真正要降下来的量。
 */
/** 一个阶段的时间账。 */
export interface ReadTracePhase {
    /** 阶段名，固定集合在 {@link PHASE_ORDER} 里，避免自由文本让报表无法聚合。 */
    readonly name: string;
    /** 这个阶段花了多久。 */
    readonly ms: number;
    /** 补充说明，例如「3 个子进程」。不含任何敏感内容。 */
    readonly detail?: string;
}
/**
 * 阶段的固定顺序。
 *
 * 不是枚举而是常量数组：报表按这个顺序排版，读者才能对比两次运行，
 * 而不是在两次不同的输出里找同一行。
 */
export declare const PHASE_ORDER: readonly ["locate", "catalog", "probe", "inspect", "read", "parse", "project", "persist", "render"];
export type ReadTracePhaseName = (typeof PHASE_ORDER)[number];
/** 一次读取结束时的快照。 */
export interface ReadTraceSnapshot {
    /** 开始时刻（ISO）。诊断要能说「这是几分钟前的观测」。 */
    readonly startedAt: string;
    /** 取快照的时刻（ISO）。 */
    readonly checkedAt: string;
    /** 从开始到取快照的总毫秒数。 */
    readonly totalMs: number;
    /** 按 {@link PHASE_ORDER} 排好序的阶段账。没有跑过的阶段不出现。 */
    readonly phases: readonly ReadTracePhase[];
    /** 这次读取一共启动了多少个 CLI 子进程。 */
    readonly cliInvocations: number;
    /** 这些子进程总共占了多少毫秒（串行时约等于各阶段之和，并行时小于总时长）。 */
    readonly cliMs: number;
}
/** 一次读取的记账器。 */
export interface ReadTrace {
    /**
     * 包住一段异步工作，记下它的耗时。
     *
     * 失败也要记账：一次超时的 `doctor` 正是最需要被看见的那一段。所以用 `finally`
     * 而不是只在成功路径上写入。
     */
    readonly run: <T>(name: ReadTracePhaseName, work: () => Promise<T>, detail?: string) => Promise<T>;
    /** 不开子阶段，只写一条已知耗时（用于已经自己量过的段落）。 */
    readonly mark: (name: ReadTracePhaseName, ms: number, detail?: string) => void;
    /** 生成快照。可以多次调用，每次都反映当时为止的账。 */
    readonly snapshot: () => ReadTraceSnapshot;
}
/**
 * CLI 子进程的计数器接口。
 *
 * 由 `cli.ts` 提供，测试可以传入自己的实现。用参数注入而不是让本模块去 import `cli.ts`，
 * 是为了让 `trace.ts` 保持零依赖——它要被诊断面板引用，而诊断面板不该因此把整个 CLI
 * 层拖进客户端包。
 */
export interface CliMetrics {
    readonly invocations: number;
    readonly totalMs: number;
}
/** 建一个记账器。 */
export declare function createReadTrace(readMetrics: () => CliMetrics, now?: () => number): ReadTrace;
//# sourceMappingURL=trace.d.ts.map