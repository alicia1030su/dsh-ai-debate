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
/** 顺序即页面顺序。 */
export const READINESS_ORDER = [
    'installed',
    'version',
    'commands',
    'login',
    'certification',
    'activation',
    'quota',
    'last_read',
];
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
export const CAUSAL_ORDER = [
    'installed',
    'version',
    'login',
    'certification',
    'activation',
    'commands',
];
/** CLI 的六个状态到「装在不在 / 通了没通」的映射，保持与 `cli.ts` 一致。 */
export function isInstallFailure(status) {
    return status === 'cli_missing';
}
/**
 * 从 `doctor` 的三步里认出某一项。
 *
 * 用词而不是位置：CLI 的步骤顺序将来可能变，而「哪一行说了什么」不会。
 * 三组关键词分别对应登录、开发者认证、服务开通——这是 `doctor` 输出里唯一
 * 稳定的东西。
 */
function doctorStep(steps, pattern) {
    return steps?.find((step) => pattern.test(step.label));
}
const LOGIN_PATTERN = /注册|登录|login|sign\s*in/i;
const CERT_PATTERN = /开发者认证|认证|certif/i;
const ACTIVATION_PATTERN = /开通服务|开通|服务|subscri|plan/i;
/** 版本号是否可用。只检查「有没有解析出一个像版本的东西」。 */
function versionLooksUsable(version) {
    if (version === undefined)
        return false;
    return /\d+\.\d+/.test(version);
}
/**
 * 把 `doctor` 的登录结论与本机凭据记录合成一条更精确的检查（v0.2.31 §六）。
 *
 * ## 三种失败，三种措辞
 *
 * | 情形 | 依据 | 说明 |
 * | --- | --- | --- |
 * | 没登录过 | doctor 不通过 + 没有凭据记录 | 「这台机器上没有登录记录」 |
 * | 登录过但失效 | doctor 不通过 + 有凭据记录 | 「登录记录在，但 CLI 拿不到可用令牌」 |
 * | 读不到结论 | doctor 没跑 / 凭据文件读不出来 | 「无法确认」，不做任何推断 |
 *
 * ## 为什么「有记录但失效」不直接写「令牌过期」
 *
 * CLI 的 `resolveToken()` 在刷新令牌的 HTTP 请求失败时**返回 null**，它把所有
 * 异常都 `catch` 掉了。所以「网络断了」和「令牌过期」在 CLI 输出上完全一样。
 *
 * 把两者说成一个，会让主人在断网时跑去重新登录——而登录同样会失败，于是他
 * 会得出「插件坏了」的结论。所以措辞里两件事都写，并给出能区分它们的动作：
 * **先确认网络，再重新登录**。
 */
function loginCheck(probe, step, fallback) {
    if (!probe.cliInstalled)
        return fallback;
    if (step?.ok === true) {
        return {
            id: 'login',
            title: 'OAuth 登录',
            state: 'ready',
            detail: probe.credential?.state === 'recorded' && probe.credential.username !== undefined
                ? `doctor：${step.label} ✓（账号 ${probe.credential.username}）`
                : `doctor：${step.label} ✓`,
            next: [],
        };
    }
    // doctor 没给出这一项：不猜。沿用上游的「没有证据」措辞。
    if (step === undefined)
        return fallback;
    const credential = probe.credential;
    if (credential === undefined)
        return fallback;
    if (credential.state === 'absent') {
        return {
            id: 'login',
            title: 'OAuth 登录',
            state: 'blocked',
            detail: '这台机器上没有登录记录：从来没有完成过 OAuth 登录。',
            next: [
                '运行 weibo-cli auth login（桌面环境会打开浏览器）',
                '完成后重新运行 doctor 确认这一行为 ✓',
            ],
        };
    }
    if (credential.state === 'recorded') {
        const who = credential.username === undefined ? '' : `（账号 ${credential.username}）`;
        const when = credential.recordedAt === undefined ? '' : `，记录于 ${credential.recordedAt.slice(0, 16).replace('T', ' ')}`;
        return {
            id: 'login',
            title: 'OAuth 登录',
            state: 'blocked',
            detail: `本机有登录记录${who}${when}，但 CLI 现在拿不到可用令牌。` +
                '这有两种可能：令牌已被平台判定失效（过期或被撤销），或者当前网络连不上授权服务——' +
                'CLI 对这两种情况给出的是同一个回答。',
            next: [
                '先确认网络能访问 open.weibo.com（断网时重新登录也会失败）',
                '再运行 weibo-cli auth login 重新授权',
                '完成后重新运行 doctor 确认这一行为 ✓',
            ],
        };
    }
    return {
        id: 'login',
        title: 'OAuth 登录',
        state: 'unknown',
        detail: `无法确认登录状态：${credential.reason ?? '凭据记录读不出来'}。`,
        next: ['运行 weibo-cli doctor 看它自己怎么说', '必要时运行 weibo-cli auth login 重新授权'],
    };
}
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
export function buildReadiness(probe) {
    const checks = [];
    const push = (check) => {
        checks.push(check);
    };
    // 1. 安装
    push(probe.cliInstalled
        ? {
            id: 'installed',
            title: 'CLI 已安装',
            state: 'ready',
            detail: '本机找到了 weibo-cli 命令。',
            next: [],
        }
        : {
            id: 'installed',
            title: 'CLI 未安装',
            state: 'blocked',
            detail: '本机没有 weibo-cli 这个命令，后面七项都无法检查。',
            next: ['安装：npm install -g @weibo-ai/weibo-cli（需要 Node.js 18 或更高）'],
        });
    // 2. 版本
    if (!probe.cliInstalled) {
        push({
            id: 'version',
            title: 'CLI 版本',
            state: 'unknown',
            detail: 'CLI 未安装，版本无从确认。',
            next: [],
        });
    }
    else if (versionLooksUsable(probe.cliVersion)) {
        push({
            id: 'version',
            title: 'CLI 版本',
            state: 'ready',
            detail: `版本 ${probe.cliVersion}。`,
            next: [],
        });
    }
    else {
        push({
            id: 'version',
            title: 'CLI 版本',
            state: 'blocked',
            detail: probe.cliVersion === undefined
                ? 'CLI 在，但 version 命令没有输出可识别的版本号。'
                : `version 的输出不是可识别的版本号：${probe.cliVersion}`,
            next: ['运行 weibo-cli version 看它实际输出什么', '如果报错，重新安装 CLI'],
        });
    }
    // 3. 命令能力
    if (!probe.cliInstalled) {
        push({
            id: 'commands',
            title: '命令清单',
            state: 'unknown',
            detail: 'CLI 未安装，命令清单无从读取。',
            next: [],
        });
    }
    else if (probe.commands === undefined) {
        push({
            id: 'commands',
            title: '命令清单',
            state: 'unknown',
            detail: '本次没有读取命令清单。',
            next: [],
        });
    }
    else if (probe.commands.ok) {
        push({
            id: 'commands',
            title: '命令清单',
            state: probe.commands.count > 0 ? 'ready' : 'blocked',
            detail: probe.commands.count > 0
                ? `本账号可用命令 ${probe.commands.count} 条。`
                : '命令清单读到了，但一条可用命令都没有。',
            next: probe.commands.count > 0 ? [] : ['确认开发者认证与服务开通已完成', '运行 weibo-cli commands list --available 查看'],
        });
    }
    else {
        push({
            id: 'commands',
            title: '命令清单',
            state: 'blocked',
            detail: `读不到命令清单：${probe.commands.reason}`,
            next: ['运行 weibo-cli commands list --available 手动确认', '确认 CLI 与网络的连接正常'],
        });
    }
    // 4/5/6. 登录、认证、开通——来自 doctor 的三行
    const login = doctorStep(probe.doctorSteps, LOGIN_PATTERN);
    const cert = doctorStep(probe.doctorSteps, CERT_PATTERN);
    const activation = doctorStep(probe.doctorSteps, ACTIVATION_PATTERN);
    /** doctor 没跑（或没解析出步骤）时的共用措辞。 */
    const noDoctorEvidence = () => {
        // ## 「跑了但解析不出」与「没跑」必须分开说
        //
        // 两者都是「没有证据」，但对用户意味着不同的事：前者是 CLI 的输出变了
        // （需要看它实际打印了什么），后者是这一步根本没执行（需要去执行它）。
        // 把前者说成「本次没有运行 doctor」，是一句不成立的话——它跑了。
        const exitCode = probe.doctorRaw?.code ?? probe.doctorExitCode;
        return {
            state: 'unknown',
            detail: exitCode === undefined
                ? '本次没有运行 doctor，这一项无从确认。'
                : `doctor 跑过了，但输出里没有可识别的步骤行（退出码 ${exitCode}）。`,
            next: exitCode === undefined
                ? ['运行 weibo-cli doctor，按它的三行输出逐项确认']
                : ['运行 weibo-cli doctor 看它实际打印了什么', '如果输出格式变了，请把这段输出反馈给插件作者'],
        };
    };
    const fromDoctor = (id, title, step, whenBlocked) => {
        if (!probe.cliInstalled) {
            return { id, title, state: 'unknown', detail: 'CLI 未安装，这一项无法检查。', next: [] };
        }
        if (step === undefined) {
            const fallback = noDoctorEvidence();
            return { id, title, state: fallback.state, detail: fallback.detail, next: fallback.next };
        }
        return step.ok
            ? { id, title, state: 'ready', detail: `doctor：${step.label} ✓`, next: [] }
            : {
                id,
                title,
                state: 'blocked',
                detail: `doctor：${step.label} 未完成`,
                next: whenBlocked,
            };
    };
    /**
     * 4. 登录——这一项要比 `doctor` 多知道一件事
     *
     * ## `doctor` 的 `× 注册或登录` 覆盖了两种完全不同的处境
     *
     * 1. 这台机器**从来没登录过** → 下一步：去登录；
     * 2. 登录过，但令牌**已被平台判定失效** → 下一步：还是去登录，但原因不同。
     *
     * 第 2 种是 v0.2.30 发布当天真实发生的：README 写「已登录」，12 小时后
     * 平台回 `401 invalid_grant`，而 `doctor` 的第一行又变回了 `×`。文档把一个
     * 会过期的状态写成了永久事实，只因为当时没有办法区分这两件事。
     *
     * `probe.credential` 给了区分它们的依据：CLI 只在磁盘上留一个指向系统保管库的
     * **引用**（账号名、创建时间），不读它就没有第二种信息。本模块只读那个引用，
     * 从不读保管库本身。
     */
    push(loginCheck(probe, login, fromDoctor('login', 'OAuth 登录', login, [
        '运行 weibo-cli auth login（桌面环境会打开浏览器）',
        '完成后重新运行 doctor 确认这一行为 ✓',
    ])));
    push(fromDoctor('certification', '开发者认证', cert, [
        '在微博开放平台控制台用微博客户端扫码完成开发者认证',
        '认证通过后重新运行 doctor',
    ]));
    push(fromDoctor('activation', '服务开通', activation, [
        '在控制台「我的服务」领取体验服务（7 天），或购买积分包',
        '开通后重新运行 doctor',
    ]));
    // 7. 额度
    if (probe.quota !== undefined && probe.quota.known) {
        push({
            id: 'quota',
            title: '额度',
            state: 'ready',
            detail: probe.quota.detail,
            next: [],
        });
    }
    else {
        push({
            id: 'quota',
            title: '额度',
            state: 'unknown',
            detail: probe.quota !== undefined && !probe.quota.known
                ? probe.quota.reason
                : '本进程没有查询额度。额度只能通过计费类命令读取，本版不替主人做账号管理。',
            next: ['如需确认额度，请自行运行 weibo-cli 的账号/额度相关命令'],
        });
    }
    // 8. 最近一次读取
    if (probe.lastRead === undefined) {
        push({
            id: 'last_read',
            title: '最近一次读取',
            state: 'unknown',
            detail: '本进程内还没有执行过真实读取（不代表失败，也不代表成功）。',
            next: [],
        });
    }
    else if (probe.lastRead.ok) {
        push({
            id: 'last_read',
            title: '最近一次读取',
            state: 'ready',
            detail: `成功 · ${probe.lastRead.stage} · ${probe.lastRead.at}`,
            next: [],
        });
    }
    else {
        push({
            id: 'last_read',
            title: '最近一次读取',
            state: 'blocked',
            detail: `失败 · ${probe.lastRead.stage} · ${probe.lastRead.message}`,
            next: [
                probe.lastError === undefined
                    ? '重新读取一次，看错误是否稳定复现'
                    : `最近错误：${probe.lastError.message}`,
            ],
        });
    }
    /**
     * 第一个阻断项，**按因果链**取，不按展示顺序。
     *
     * 详见 {@link CAUSAL_ORDER}：展示顺序把「命令清单」排在认证之前，因为它与
     * 「能不能读」最直接相关；但命令清单为空只是认证与服务缺失的**结果**。
     * 按展示顺序取，真实环境下得到的下一步是「去查命令清单」，而正确的下一步是
     * 「去完成扫脸认证」。
     */
    const blockedIds = new Set(checks.filter((check) => check.state === 'blocked').map((check) => check.id));
    const blockingId = CAUSAL_ORDER.find((id) => blockedIds.has(id));
    const blockingCheck = blockingId === undefined ? undefined : checks.find((check) => check.id === blockingId);
    const canRead = checks
        .filter((check) => check.id !== 'quota' && check.id !== 'last_read')
        .every((check) => check.state === 'ready');
    return {
        checks,
        ...(blockingCheck === undefined ? {} : { blocking: blockingCheck.id }),
        canRead,
        ...(canRead || blockingCheck === undefined
            ? {}
            : { summary: `${blockingCheck.title}：${blockingCheck.detail}` }),
        checkedAt: probe.now ?? new Date().toISOString(),
        staleAfterMs: READINESS_TTL_MS,
    };
}
/**
 * 一份快照多久之后不该再当作现状。
 *
 * 10 分钟：比任何一次人工排查的节奏都短，又不会让页面每次重绘都重新探测
 * （探测要跑 2~3 个 CLI 子进程，每个几百毫秒）。
 */
export const READINESS_TTL_MS = 10 * 60 * 1000;
/**
 * 快照是否已经过期。
 *
 * 页面必须用它决定标不标「这是旧结果」。不标的话，一次十分钟前说「已就绪」的
 * 探测会在令牌过期之后继续显示成绿的——而那正是 v0.2.30 文档犯的同一个错，
 * 只是从 README 搬到了界面上。
 */
export function readinessIsStale(snapshot, now = Date.now()) {
    const checked = Date.parse(snapshot.checkedAt);
    if (!Number.isFinite(checked))
        return true;
    return now - checked > snapshot.staleAfterMs;
}
/**
 * 把快照压成一行中文，给日志和不带面板的地方用。
 *
 * 刻意不返回「已就绪 / 未就绪」两个值：那句话会被人复制到别处，
 * 而它丢掉的信息正是这个模块存在的理由。
 */
export function describeReadiness(snapshot) {
    const blocked = snapshot.checks.filter((check) => check.state === 'blocked');
    const unknown = snapshot.checks.filter((check) => check.state === 'unknown');
    if (snapshot.canRead) {
        return unknown.length === 0
            ? '八项全部通过：可以发起真实读取。'
            : `可以发起真实读取；${unknown.map((check) => check.title).join('、')} 尚无证据。`;
    }
    const head = blocked.map((check) => check.title).join('、');
    return `${head || '存在未通过项'}未通过：${snapshot.summary ?? '原因见各项详情'}`;
}
//# sourceMappingURL=readiness.js.map