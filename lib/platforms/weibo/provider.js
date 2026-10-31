/**
 * The Weibo provider: link routing, capability declaration, adapter construction.
 *
 * ## What changed in v0.2.12
 *
 * v0.2.11 shipped a CLI layer (`cli.ts`) that nothing called, and an adapter whose every
 * read threw. Installing the CLI and logging in would have changed nothing, because there
 * was no code path from the probe to `getThread`.
 *
 * v0.2.12 wires them together: the adapter resolves a **read plan** by probing the CLI,
 * discovering the catalog, and validating each candidate command's required parameters
 * before deciding whether a read may run. The projection from Weibo's payloads to
 * `Thread`/`Floor`/`NestedReply` lives in `projection.ts` so it is testable without a CLI.
 *
 * ## What is still claimed and what is not
 *
 * - A read that has never run is **not** `supported`. It is `unverified` at best: the code
 *   exists, no real account proved it.
 * - A command is only used after `inspectCommand` confirms we can fill its required
 *   parameters. A name that matches a regex is a *candidate*, not a permission.
 * - `publishReply` always throws. There is no Weibo write path in this build; the platform
 *   requires an explicit AI-content label plus a write scope this plugin does not request.
 * - Nothing here buys credit, runs a face scan, or starts an OAuth flow. Those need a human.
 */
import { buildDiagnosticLines, createDiagnosticRecorder, diagnosisOfStatus, } from './diagnostics.js';
import { inspectCommand, listAvailableCommands, probeWeiboCli, runReadCommand, } from './cli.js';
import { projectCommentAsFloor, projectCommentAsNested, projectThread, unwrapComments, unwrapStatus, } from './projection.js';
import { buildInvocationPlan } from './invocation-plan.js';
import { createPlanCache } from './plan-cache.js';
import { matchReturnedStatus } from './target-match.js';
import { parseWeiboUrl, weiboCanHandleUrl } from './url.js';
const PLATFORM = 'weibo';
/**
 * Translate a classified CLI failure into a throw.
 *
 * Every status keeps its own identity: `cli_missing` tells the owner to install something,
 * `not_authenticated` to log in, `service_inactive` to activate the service, and
 * `quota_exhausted` to top up. Merging them would hide the only actionable information.
 */
function guardRead(status, message) {
    if (status === 'ok')
        return;
    throw new WeiboCliError(status, message);
}
/** Honour an abort signal between steps; the CLI call itself is not cancellable. */
function throwIfAborted(signal) {
    if (signal?.aborted === true) {
        const error = new Error('微博读取已被取消。');
        error.name = 'AbortError';
        throw error;
    }
}
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
/**
 * The evidence level in words a reader can act on.
 *
 * These strings are the difference between "it works" and "it looks like it might work", which is
 * the whole point of §三. `schema_only` is the most common state in this build and it must never
 * sound like success.
 */
export function describeEvidenceLevel(level) {
    switch (level) {
        case 'fully_verified':
            return '真实调用成功且父子关系已核对';
        case 'live_call':
            return '真实调用成功，但父子关系未核对';
        case 'schema_only':
            return '仅参数 schema 吻合，尚未在真实平台调用';
        case 'unavailable':
            return '平台 schema 明确不支持';
    }
}
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
 * A CLI-backed read failed, with the reason preserved.
 *
 * ## Why this is a separate error class from `WeiboNotAuthorisedError` (v0.2.12)
 *
 * v0.2.11 threw `weibo_not_authorised` for everything, including "the CLI is not
 * installed". Those two states need different actions from the owner — install a tool
 * versus obtain a grant — and collapsing them meant the actionable one was hidden behind
 * a message that said "go get authorisation" when no authorisation would help.
 *
 * The `code` is the CLI's own status, so a caller can branch without parsing prose.
 */
export class WeiboCliError extends Error {
    code;
    /** The next steps for the owner, when this failure has a known remedy. */
    steps;
    constructor(status, message, steps = []) {
        super(message);
        this.name = 'WeiboCliError';
        this.code = status;
        this.steps = steps;
    }
}
/** Thrown when the account is authorised but lacks the specific read command. */
export class WeiboCommandUnavailableError extends Error {
    code = 'command_unavailable';
    constructor(message) {
        super(message);
        this.name = 'WeiboCommandUnavailableError';
    }
}
/**
 * Page size requested when the comment command declares a `count` flag.
 *
 * 20 is the value the official manual documents for the read commands that cap it, so asking for
 * more would be rejected with `COUNT_EXCEEDS_MAX`. When the command has no `count` flag this is
 * never sent and the server's own default applies — which this code does not assume.
 */
const COMMENT_PAGE_SIZE = 20;
/**
 * Resolve which catalog entry drives which read, by validating each candidate.
 *
 * ## Why the candidate is inspected rather than accepted
 *
 * The task book forbids "name looks right → assume we have the permission". A catalog
 * entry is a *listing*: it can be present while the entitlement behind it is inactive, and
 * its required parameters may not be ones we can supply. So every candidate goes through
 * `inspectCommand`, and only a candidate whose required parameters we can actually fill
 * becomes a plan.
 */
async function resolveReadPlan() {
    const readiness = await probeWeiboCli();
    if (!readiness.canRead)
        return { readiness, selectionNotes: [] };
    const listed = await listAvailableCommands();
    if (listed.status !== 'ok' || listed.data === undefined) {
        return {
            readiness,
            selectionNotes: [],
            threadProblem: listed.message,
            commentProblem: listed.message,
        };
    }
    const plan = { readiness, selectionNotes: [] };
    // ## Candidate selection (v0.2.14 §五)
    //
    // The catalog's spelling is server-owned, so a regex picks *candidates* — never a winner.
    // Each candidate is then inspected in turn, and the first one whose verified schema can
    // actually drive the read wins. Two rules make this safe:
    //
    //   - **locked rows are skipped outright.** A locked entry means "listed, not entitled"; calling
    //     it would burn a request to learn what the listing already said.
    //   - **the number of inspections is capped.** Each `commands show` is a real invocation, so a
    //     pathological catalog must not turn into dozens of them.
    const MAX_INSPECTIONS = 4;
    const candidatesFor = (family) => {
        const rows = listed.data;
        const matches = family === 'thread'
            ? rows.filter((row) => /status|weibo|post/i.test(row.group) &&
                /show|get|read|detail|batch/i.test(row.action))
            : rows.filter((row) => /comment/i.test(row.group) && /list|show|get|read/i.test(row.action));
        // Unlocked first, then locked ones are dropped: never called, per §五.2.
        const unlocked = matches.filter((row) => row.access !== 'locked');
        const lockedCount = matches.length - unlocked.length;
        if (lockedCount > 0) {
            plan.selectionNotes.push(`${family === 'thread' ? '正文' : '评论'}候选里有 ${lockedCount} 条被标记为 locked，已排除（不探测未授权命令）。`);
        }
        return unlocked;
    };
    /** Inspect candidates until one yields a verified plan that can drive `kind`. */
    const choose = async (family, kind, capability) => {
        const candidates = candidatesFor(family);
        if (candidates.length === 0) {
            return {
                problem: family === 'thread'
                    ? '当前账号的可用命令里没有能读取微博正文的命令。'
                    : '当前账号的可用命令里没有能读取评论的命令。',
            };
        }
        const tried = [];
        for (const candidate of candidates.slice(0, MAX_INSPECTIONS)) {
            const schema = await inspectCommand({ group: candidate.group, action: candidate.action });
            if (schema.status !== 'ok' || schema.data === undefined) {
                tried.push(`${candidate.name}（无法读取 schema：${schema.message}）`);
                continue;
            }
            const invocation = buildInvocationPlan({
                group: candidate.group,
                action: candidate.action,
                name: candidate.name,
                schemaVerified: schema.data.evidence === 'parsed',
                parameters: schema.data.typedParameters,
                kind,
            });
            const claim = invocation.capabilities[capability];
            if (!claim.available) {
                tried.push(`${candidate.name}（${claim.reason}）`);
                continue;
            }
            // Record why this one won, so the diagnostic panel can explain the choice.
            plan.selectionNotes.push(candidates.length === 1
                ? `选用 ${candidate.name}：${claim.reason}`
                : `选用 ${candidate.name}（共 ${candidates.length} 个候选，前 ${tried.length} 个不适用）：${claim.reason}`);
            return { plan: invocation };
        }
        return {
            problem: tried.length === 0
                ? '目录里有候选命令，但没有任何一条通过校验。'
                : `检查了 ${tried.length} 个候选，都不适用：${tried.join('；')}`,
        };
    };
    const threadChoice = await choose('thread', 'thread', 'readThread');
    plan.threadPlan = threadChoice.plan;
    if (threadChoice.problem !== undefined)
        plan.threadProblem = threadChoice.problem;
    const commentChoice = await choose('comments', 'comments', 'readComments');
    plan.commentPlan = commentChoice.plan;
    if (commentChoice.problem !== undefined)
        plan.commentProblem = commentChoice.problem;
    return plan;
}
/**
 * The stateful adapter.
 *
 * ## What changed in v0.2.12
 *
 * v0.2.11 threw `WeiboNotAuthorisedError` from every method, unconditionally. The CLI layer
 * existed but was never called, so installing the CLI and logging in would have changed
 * nothing.
 *
 * Now the adapter resolves a **read plan** on first use: probe the CLI, discover the
 * catalog, validate the candidates' argument shapes, and only then decide whether
 * `getThread`/`getReplies` can run. Every failure keeps its own code so the owner can tell
 * "install it" from "log in" from "buy credit".
 *
 * ## What is still refused
 *
 * `publishReply` throws, always. There is no Weibo write path in this build: the platform
 * requires an explicit AI-content label and a write scope this plugin does not request.
 */
function createAdapter(context) {
    // `context` is not used yet on purpose: Weibo's read path needs no secret of its own,
    // because the official CLI owns its OAuth session on disk and this plugin never reads it.
    // Keeping the parameter documents that the adapter receives platform-scoped settings
    // without pretending to consume them.
    void context;
    // The plan is resolved lazily and shared across calls, with a **bounded** lifetime.
    //
    // v0.2.12 cached the first probe's promise forever, so a `cli_missing` reported before the
    // owner installed the CLI stayed cached until the DSH process restarted. The cache now has a
    // TTL for success, a short backoff for recoverable failures, a forced-refresh path, and a
    // generation guard so a slow outdated probe cannot overwrite a newer verdict.
    const diagnostics = createDiagnosticRecorder();
    const planCache = createPlanCache(async () => {
        const plan = await resolveReadPlan();
        return { plan, status: plan.readiness.status };
    });
    /**
     * Drop the cache without probing.
     *
     * Called when something outside the probe proves the plan stale. Kept as a named local so
     * the intent is recorded even though the only current caller is the handler below — the
     * alternative was exporting a mutator that any module could call.
     */
    const invalidatePlan = () => planCache.invalidate();
    // `invalidatePlan` is reachable through the adapter's optional member below; referencing it
    // here keeps the wiring explicit rather than reaching into `planCache` from outside.
    void invalidatePlan;
    /**
     * Capabilities reflect what was *measured*, not what was hoped.
     *
     * Before the first read the plan is unknown, so everything that depends on the CLI is
     * reported false with a note saying it has not been probed yet. `getCapabilities()` is
     * synchronous by contract, so it cannot wait for a probe — the first async call fills the
     * cache and later calls see the real answer.
     */
    let cached;
    const capabilities = () => {
        if (cached !== undefined)
            return cached;
        return {
            thread: false,
            replies: false,
            nestedReplies: false,
            userProfile: false,
            mentions: false,
            publish: false,
            authCheck: false,
            notes: {
                thread: '尚未探测微博 CLI 状态；第一次读取时会自动探测。',
                replies: '尚未探测微博 CLI 状态。',
                publish: '本版不开放微博真实发表（需要写入授权与 AI 生成内容标识）。',
                mentions: '微博的艾特通知不对外开放给第三方读取。',
            },
        };
    };
    /**
     * Refresh the cached capabilities from a resolved plan.
     *
     * Called after every plan resolution so `getCapabilities()` — which the settings page and
     * the registry's gate read — tells the truth once a probe has run.
     */
    const remember = (resolved) => {
        const ready = resolved.readiness.canRead;
        // ## Each capability is asked separately (v0.2.14 §四)
        //
        // v0.2.13 derived all three from "is there a comment command", so a command with no
        // parent-scoping parameter still produced `nestedReplies: true` while the read refused.
        // The plan answers each question from the verified schema, and its `unverified` state is
        // preserved: the page must show "we do not know", not a yes.
        const threadClaim = resolved.threadPlan?.capabilities.readThread;
        const commentClaim = resolved.commentPlan?.capabilities.readComments;
        const nestedClaim = resolved.commentPlan?.capabilities.readNested;
        cached = {
            thread: threadClaim?.available === true,
            replies: commentClaim?.available === true,
            // ## Claimed only after a real platform call (v0.2.15 §三)
            //
            // v0.2.14 used `nestedClaim.available`, which is true as soon as the *schema* looks right
            // — so a command declaring `cid` + `count` made the page say "子评论可读" while no read
            // had ever run. A parameter name is not a platform capability.
            //
            // The bar now is `fully_verified`: a real call succeeded **and** the returned parent/child
            // link was checked against the requested comment id. A bare successful call (`live_call`)
            // only proves the command runs, not that the replies hang off the right comment.
            nestedReplies: nestedClaim?.evidence.level === 'fully_verified',
            userProfile: false,
            mentions: false,
            publish: false,
            authCheck: ready,
            notes: {
                ...(resolved.threadProblem === undefined ? {} : { thread: resolved.threadProblem }),
                ...(resolved.commentProblem === undefined ? {} : { replies: resolved.commentProblem }),
                // The nested answer always carries a reason: "no" without one is indistinguishable
                // from "we did not look", and the page renders this text. The level is spelled out so
                // "schema only" can never be read as "it works".
                ...(nestedClaim === undefined
                    ? {}
                    : {
                        nestedReplies: `${nestedClaim.reason}（证据层次：${describeEvidenceLevel(nestedClaim.evidence.level)}）`,
                    }),
                ...(ready ? {} : { authCheck: resolved.readiness.message }),
                publish: '本版不开放微博真实发表（需要写入授权与 AI 生成内容标识）。',
                mentions: '微博的艾特通知不对外开放给第三方读取。',
            },
        };
    };
    /**
     * Resolve the plan **without throwing**, for callers that report state rather than read.
     *
     * `requirePlan` exists for reads: "cannot read" is an error there. A diagnostic is the
     * opposite — its entire job is to say *why* reads cannot run, so throwing would replace the
     * answer with an exception. Same cache, same probe, different contract.
     */
    const observePlan = async (force = false) => {
        const result = await planCache.get(force ? { force: true } : {});
        remember(result.plan);
        return result.plan;
    };
    /** Resolve the plan, cache the capabilities, and translate a refusal into a throw. */
    const requirePlan = async (force = false) => {
        const result = await planCache.get(force ? { force: true } : {});
        const resolved = result.plan;
        remember(resolved);
        if (!resolved.readiness.canRead) {
            throw new WeiboCliError(resolved.readiness.status, resolved.readiness.message, resolved.readiness.steps);
        }
        return resolved;
    };
    return {
        id: PLATFORM,
        displayName: '微博',
        getCapabilities: capabilities,
        /**
         * The Weibo-specific diagnostic (v0.2.12 §二, extended in v0.2.13 §四).
         *
         * Exposed as an optional member rather than part of `PlatformAdapter`: the generic
         * interface describes what every platform must do, and a diagnostic that only Weibo can
         * produce does not belong there. The settings page probes for it.
         *
         * ## `options.refresh` is the controlled re-probe
         *
         * The settings page's refresh button calls this with `refresh: true`. It runs **one**
         * probe, ignores any cached verdict, and does nothing else — no login, no purchase, no
         * account operation. Without this the page could only ever show whatever the first probe
         * of the process concluded, which is precisely the v0.2.12 defect.
         */
        describeDiagnostics: async (options = {}) => {
            const resolved = await observePlan(options.refresh === true);
            remember(resolved);
            // "Installed" is only true when the binary answered `version`; a missing binary has an
            // empty stderr, so the readiness status is the authority here.
            const cliInstalled = resolved.readiness.status !== 'cli_missing';
            const cliVersion = resolved.readiness.version;
            const oauthLoggedIn = resolved.readiness.status !== 'cli_missing' &&
                resolved.readiness.status !== 'not_authenticated';
            const serviceActive = resolved.readiness.canRead;
            const history = diagnostics.snapshot();
            const lines = buildDiagnosticLines({
                cliInstalled,
                ...(cliVersion === undefined ? {} : { cliVersion }),
                oauthLoggedIn,
                serviceActive,
                ...(resolved.threadPlan === undefined ? {} : { threadCommand: resolved.threadPlan.name }),
                ...(resolved.commentPlan === undefined ? {} : { commentCommand: resolved.commentPlan.name }),
                ...(resolved.threadProblem === undefined ? {} : { threadProblem: resolved.threadProblem }),
                ...(resolved.commentProblem === undefined ? {} : { commentProblem: resolved.commentProblem }),
                readinessState: diagnosisOfStatus(resolved.readiness.status),
                readinessMessage: resolved.readiness.message,
                readinessSteps: resolved.readiness.steps,
                selectionNotes: resolved.selectionNotes,
                ...(resolved.commentPlan === undefined
                    ? {}
                    : {
                        nestedCapability: {
                            available: resolved.commentPlan.capabilities.readNested.available,
                            state: resolved.commentPlan.capabilities.readNested.state,
                            reason: resolved.commentPlan.capabilities.readNested.reason,
                        },
                    }),
                ...history,
            });
            return {
                cliInstalled,
                ...(cliVersion === undefined ? {} : { cliVersion }),
                oauthLoggedIn,
                serviceActive,
                ...(resolved.threadPlan === undefined ? {} : { threadCommand: resolved.threadPlan.name }),
                ...(resolved.commentPlan === undefined ? {} : { commentCommand: resolved.commentPlan.name }),
                // ## Why quota is `not_implemented` rather than a number
                //
                // Reading the credit balance means calling a billing command (`me`, the credit
                // ledger). That is account management, not a read of the thread, and the task book
                // forbids automating account operations. Reporting `not_implemented` with the reason
                // is honest; showing a fake or stale number would not be.
                quota: {
                    state: 'not_implemented',
                    message: '本版不读取积分余额或套餐信息：那需要调用官方的账户/计费命令，属于账户管理操作，' +
                        '插件不代为执行。需要查看余额时请在控制台「我的信息」页或运行 weibo-cli me。',
                    steps: ['在微博控制台「我的信息」页查看积分余额', '或自行运行 weibo-cli me --output table'],
                },
                ...history,
                lines,
            };
        },
        checkAuthentication: async () => {
            // A read-only probe of the local CLI. It answers `false` with a reason rather than
            // throwing, because "am I logged in?" has a useful negative answer.
            const resolved = await observePlan(false);
            remember(resolved);
            return {
                authenticated: resolved.readiness.canRead,
                ...(resolved.readiness.canRead ? {} : { reason: resolved.readiness.message }),
            };
        },
        getThread: async (ref, signal) => {
            const resolved = await requirePlan();
            const plan = resolved.threadPlan;
            if (plan === undefined) {
                const message = resolved.threadProblem ?? '当前账号没有可用的微博正文读取命令。';
                diagnostics.recordError('permission_insufficient', message);
                throw new WeiboCommandUnavailableError(message);
            }
            throwIfAborted(signal);
            const invocation = plan.argsFor({ threadId: ref.threadId, page: 1 });
            const read = await runReadCommand(plan, invocation.args);
            if (read.status !== 'ok') {
                diagnostics.recordError(diagnosisOfStatus(read.status), read.message);
                guardRead(read.status, read.message);
            }
            // ## Identity is decided before shape is judged (v0.2.14 §二)
            //
            // The order matters. \`unwrapStatus\` answers "is there something projectable here" and
            // returns the first readable object — which for a batch answer is the first post, not the
            // target. Asking it first made a batch read fail as \`malformed_response\` whenever the
            // envelope was a list, and made a wrong-but-well-formed answer look perfectly fine.
            //
            // So the target is located by id first, and whatever *that* object contains is what gets
            // shape-checked. A payload that identifies the requested post is, by definition, the post;
            // a payload that does not is refused here rather than after projection.
            const match = matchReturnedStatus(read.data, ref.threadId);
            if (!match.ok) {
                const shown = match.observed.length === 0 ? '（没有可识别的 id）' : match.observed.join('、');
                const message = `平台返回的微博不是请求的那一条：请求 ${ref.threadId}，返回 ${shown}。` +
                    `${match.reason}这次读取没有被当成目标微博，分析也不会继续。`;
                diagnostics.recordError('target_mismatch', message);
                throw new WeiboCliError('target_mismatch', message);
            }
            // The matched object is the target; shape is checked here, where a failure means the
            // *right* post had an unreadable body rather than the wrong post being readable.
            const payload = unwrapStatus(match.status);
            if (payload === undefined) {
                const message = `${plan.name} 返回了目标微博（id ${ref.threadId}），但它的正文结构无法解析。`;
                diagnostics.recordError('failed', message);
                throw new WeiboCliError('malformed_response', message);
            }
            diagnostics.recordRead(true, 'thread', `${plan.name} 返回了正文`);
            return projectThread(payload, ref.threadId, ref.url);
        },
        getReplies: async (ref, page, signal) => {
            const resolved = await requirePlan();
            const plan = resolved.commentPlan;
            if (plan === undefined) {
                throw new WeiboCommandUnavailableError(resolved.commentProblem ?? '当前账号没有可用的微博评论读取命令。');
            }
            throwIfAborted(signal);
            // ## Pagination comes from the plan, never from a guess (v0.2.14 §三)
            //
            // Reproduced in v0.2.13 both ways:
            //   - command declares `id`+`count` → we sent `--page 2` (undeclared → CLI hard-errors);
            //   - command declares `id`+`page`  → we sent no `--page` at all, silently re-reading
            //     page 1 while the caller believed it had advanced.
            //
            // The plan sends `--page` iff the schema declares a page flag, and `--count` iff it
            // declares a count flag. Neither implies the other.
            const invocation = plan.argsFor({
                threadId: ref.threadId,
                page,
                pageSize: COMMENT_PAGE_SIZE,
            });
            // ## A page this command cannot express is not silently downgraded
            //
            // If the caller asked for page 2 and the command has no page flag, sending the page-1
            // request and reporting success would be the "read page 1 and claim it is everything"
            // failure the task book names. We fail instead, with a message the caller can act on.
            // ## A page the command cannot express degrades; it does not explode (§三.10 / §三.11)
            //
            // The first version of this fix threw, which looks safe and is not: a throw tells the
            // collector the *whole floor* is unreadable, so a floor whose first page is perfectly
            // readable would report zero comments. That is worse than the bug.
            //
            // The rule from the task book is "read what you can confirm, and say it is incomplete".
            // So: page 1 is read for real, and the result is flagged so nobody claims it walked the
            // conversation. If the caller asked for page > 1 we return an empty page with
            // `incomplete`, because repeating page 1 and calling it page 2 is the specific lie the
            // requirement forbids.
            if (invocation.pagingUnsupported) {
                const reason = invocation.omitted.find((entry) => entry.name === 'page')?.reason ??
                    `命令 ${plan.name} 无法表达页码。`;
                diagnostics.recordError('permission_insufficient', reason);
                return {
                    floors: [],
                    page,
                    // More may exist; we simply cannot ask. `hasMore: true` with `incomplete` makes the
                    // collector stop at its own cap and report a truncated range rather than a clean end.
                    hasMore: true,
                    incomplete: true,
                };
            }
            const read = await runReadCommand(plan, invocation.args);
            guardRead(read.status, read.message);
            const page1 = unwrapComments(read.data);
            const floors = [];
            for (const comment of page1.comments) {
                const floor = projectCommentAsFloor(comment);
                if (floor !== undefined)
                    floors.push(floor);
            }
            // ## An unparseable paging state is reported, not smoothed over (v0.2.12 audit)
            //
            // When the payload carries neither `has_more` nor a cursor, we do not know whether more
            // comments exist. `pagingState === 'unknown'` therefore produces no `declaredTotal` and
            // no claim of completeness — the collector will see `hasMore: true` and either keep
            // paging or stop at its own cap, which ends as `inconsistent_pagination` rather than a
            // false `confirmed_end`.
            return {
                floors,
                page,
                hasMore: page1.hasMore,
                ...(page1.declaredTotal === undefined ? {} : { declaredTotal: page1.declaredTotal }),
                ...(page1.pagingState === 'unknown'
                    ? {
                        incomplete: true,
                    }
                    : {}),
            };
        },
        getNestedReplies: async (ref, floor, page, signal) => {
            const resolved = await requirePlan();
            // `ref` is not sent: the official nested read is scoped by the parent comment id alone and
            // a comment id is globally unique. Adding the thread id would need a flag the catalog may
            // not declare, and an undeclared flag is a hard error in this CLI.
            void ref;
            const plan = resolved.commentPlan;
            if (plan === undefined) {
                throw new WeiboCommandUnavailableError(resolved.commentProblem ?? '当前账号没有可用的微博评论读取命令。');
            }
            // ## Nested reads require a *verified* parent flag (v0.2.14 §四)
            //
            // v0.2.13 advertised `nestedReplies: true` whenever a comment command existed, then
            // refused the read. The claim now comes from the same place as the refusal, so the two
            // cannot disagree: if `readNested` is not `available`, this method throws with the
            // plan's own reason and the capability table already said false.
            const nestedClaim = plan.capabilities.readNested;
            if (!nestedClaim.available) {
                diagnostics.recordError('permission_insufficient', nestedClaim.reason);
                throw new WeiboCommandUnavailableError(nestedClaim.reason);
            }
            throwIfAborted(signal);
            // ## Two different ids, and they must not be conflated (v0.2.14)
            //
            // The command is \`comments show/biz --id <微博id> --cid <评论id>\`: \`--id\` scopes the read to
            // one *post*, \`--cid\` to one *comment under it*. Passing the comment id as the post id (as
            // the first version of this rewrite did) asks the wrong question and gets top-level
            // comments back — which then get projected as replies, inventing a conversation tree.
            const invocation = plan.argsFor({
                threadId: ref.threadId,
                parentCommentId: floor.postId,
                page,
                pageSize: COMMENT_PAGE_SIZE,
            });
            if (invocation.pagingUnsupported) {
                const reason = invocation.omitted.find((entry) => entry.name === 'page')?.reason ??
                    `命令 ${plan.name} 无法表达页码。`;
                diagnostics.recordError('permission_insufficient', reason);
                throw new WeiboCommandUnavailableError(reason);
            }
            const read = await runReadCommand(plan, invocation.args);
            guardRead(read.status, read.message);
            const nestedPage = unwrapComments(read.data);
            const replies = [];
            for (const comment of nestedPage.comments) {
                const nested = projectCommentAsNested(comment, floor.postId);
                if (nested !== undefined)
                    replies.push(nested);
            }
            // ## `incomplete` means "this page is a degraded subset", NOT "there is another page"
            //
            // v0.2.11 set it whenever `hasMore` was true, which is just normal pagination. The
            // collector reads `incomplete` as *degradation*, so every multi-page floor was reported
            // as "楼中楼不完整" even after a clean full walk. It is now reserved for a payload whose
            // paging state could not be read at all.
            return {
                replies,
                page,
                hasMore: nestedPage.hasMore,
                ...(nestedPage.pagingState === 'unknown' ? { incomplete: true } : {}),
            };
        },
        getReplyContext: async (ref, postId) => {
            // A precise summons needs to locate one comment. Without that command the honest
            // answer is a refusal, not a context assembled from a page that may not contain it.
            void postId;
            void ref;
            throw new WeiboCommandUnavailableError('本版未接入按 id 定位单条微博评论的命令。');
        },
        /**
         * Reading another account's profile is not implemented (v0.2.14 §四).
         *
         * The catalog may list a `users` command, but nothing here has verified that its shape
         * returns a profile this plugin can use, and the task book is explicit that an unverified
         * capability must not be advertised. Refusing says exactly that; returning a partial
         * object would let a caller treat "we guessed some fields" as a profile.
         */
        getUserProfile: async (ref) => {
            void ref;
            throw new WeiboCommandUnavailableError('本版未接入微博用户资料读取：命令形状尚未核对，不声明可用。');
        },
        /**
         * Mentions are not readable through this CLI at all.
         *
         * The manual documents no 艾特 endpoint for third parties, so this is not "not yet" like the
         * profile above — there is nothing to implement.
         */
        getMentions: async () => {
            throw new WeiboCommandUnavailableError('微博的艾特通知不对第三方开放，本插件不读取。');
        },
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