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
/**
 * 阶段的固定顺序。
 *
 * 不是枚举而是常量数组：报表按这个顺序排版，读者才能对比两次运行，
 * 而不是在两次不同的输出里找同一行。
 */
export const PHASE_ORDER = [
    'locate', // 定位可执行文件与版本
    'catalog', // 读可用命令清单
    'probe', // 登录态与服务状态（doctor）
    'inspect', // 读命令 schema 并判定可驱动性
    'read', // 平台真实读取
    'parse', // JSON 解析
    'project', // 投影成 Thread / Floor
    'persist', // 结果保存
    'render', // 交给 GUI 显示
];
/** 建一个记账器。 */
export function createReadTrace(readMetrics, now = Date.now) {
    const startedAt = now();
    const startedWall = new Date(startedAt).toISOString();
    /**
     * ## 记的是**这一次**的子进程数，不是进程启动以来的总数
     *
     * 底层的计数器是进程级累加的，而这份账要回答的是「刚才这次读取启动了几个子进程」。
     * 直接读累加值会让第二次读取报出「24 次」——那是两次之和，而这个数字要用来
     * 判断「一次读取的结构是不是合理」。
     *
     * 所以创建时记一个基线，快照时取差值。差值为负（计数器被重置过）时回落到 0，
     * 因为负数在这个语境里没有意义。
     */
    const baseline = readMetrics();
    /** 同一阶段可能被调用多次（例如分页里每页一次 read），累加而不是覆盖。 */
    const totals = new Map();
    const add = (name, ms, detail) => {
        const existing = totals.get(name);
        if (existing === undefined) {
            totals.set(name, { ms, ...(detail === undefined ? {} : { detail }) });
            return;
        }
        existing.ms += ms;
        // 同一个阶段跑了几次，就把次数说清楚：`read 3 次` 比一个总和更能解释问题。
        existing.detail = detail ?? existing.detail;
    };
    return {
        run: async (name, work, detail) => {
            const begin = now();
            try {
                return await work();
            }
            finally {
                add(name, now() - begin, detail);
            }
        },
        mark: (name, ms, detail) => add(name, ms, detail),
        snapshot: () => {
            const phases = [];
            for (const name of PHASE_ORDER) {
                const entry = totals.get(name);
                if (entry === undefined)
                    continue;
                phases.push({ name, ms: Math.round(entry.ms), ...(entry.detail === undefined ? {} : { detail: entry.detail }) });
            }
            // 不在固定集合里的阶段也要带出去，否则新加的阶段会静默消失。
            for (const [name, entry] of totals) {
                if (PHASE_ORDER.includes(name))
                    continue;
                phases.push({ name, ms: Math.round(entry.ms), ...(entry.detail === undefined ? {} : { detail: entry.detail }) });
            }
            const endedAt = now();
            const current = readMetrics();
            return {
                startedAt: startedWall,
                checkedAt: new Date(endedAt).toISOString(),
                totalMs: Math.round(endedAt - startedAt),
                phases,
                cliInvocations: Math.max(0, current.invocations - baseline.invocations),
                cliMs: Math.max(0, Math.round(current.totalMs - baseline.totalMs)),
            };
        },
    };
}
//# sourceMappingURL=trace.js.map