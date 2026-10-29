/**
 * Weibo official CLI: read-only adapter layer.
 *
 * ## What this file is, and is not
 *
 * It wraps the **official** `weibo-cli` (`@weibo-ai/weibo-cli`) so the plugin can ask
 * "read this post and its comments" without encoding any HTTP knowledge of Weibo's
 * APIs. Everything it knows about the CLI comes from the official manual at
 * <https://open.weibo.com/cli/quickstart> and from `weibo-cli commands list/show` — the
 * two sources the manual itself tells you to use for discovery.
 *
 * It is **not** a stand-in for authorisation. The CLI requires a developer
 * qualification (face scan in the Weibo client), an activated service (free 7-day trial
 * or a paid credit pack), and an OAuth login binding this machine to an account. None of
 * that is something code can supply, and this module never pretends otherwise: every
 * read path answers `cli_missing` / `not_authenticated` / `service_inactive` /
 * `quota_exhausted` as distinct, actionable states rather than an empty list.
 *
 * ## Command injection
 *
 * Every invocation goes through `execFile` with an **argument array** — never a shell
 * string. A mid, a URL, a screen name or a comment body can contain anything; the only
 * values this module ever interpolates are ids it has already validated as
 * `[0-9A-Za-z]`, and even those go in as separate argv entries. There is no `shell: true`
 * anywhere, and no string concatenation into a command line.
 *
 * ## Token handling
 *
 * The CLI keeps its own OAuth session on disk; this module never reads it. It does not
 * pass tokens on the command line, does not print them, and scrubs anything that looks
 * like a bearer token or an OAuth code out of error output before it reaches an error
 * message that could end up in a log or in the model's context.
 */
import { execFile } from 'node:child_process';
/** The binary name; resolved through PATH exactly as the manual documents it. */
const BINARY = 'weibo-cli';
/** How long one CLI invocation may take before it is killed. */
const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * Anything that looks like a credential, removed from text we might show.
 *
 * The CLI's own manual warns against putting tokens in logs; the same rule applies to
 * its stderr, which can echo request headers on failure. Scrubbing here means a future
 * caller cannot accidentally forward one.
 */
export function scrubCredentials(text) {
    return text
        // Bearer tokens and bare OAuth access/refresh tokens.
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
        .replace(/\b(access_token|refresh_token|token|code|client_secret)=([^&\s"']+)/gi, '$1=<redacted>')
        // Anything shaped like a long opaque secret (Weibo tokens are long base64ish).
        .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>');
}
const DEFAULT_INVOCATION = { file: BINARY, prefixArgs: [] };
let invocation = DEFAULT_INVOCATION;
/**
 * Point the CLI layer at a stand-in executable. **Tests only.**
 *
 * Call with `undefined` to restore the hardcoded `weibo-cli`. Deliberately not exported
 * from the package index, so a plugin consumer cannot reach it through configuration.
 */
export function __setCliInvocation(next) {
    invocation = next ?? DEFAULT_INVOCATION;
}
/**
 * Run one CLI command and capture stdout/stderr.
 *
 * Uses `execFile`, which takes an argument array and spawns the binary directly — the
 * documented way to invoke a tool without a shell. `shell` is never enabled, so no
 * character in any argument can be reinterpreted as syntax.
 */
async function runCli(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        execFile(invocation.file, [...invocation.prefixArgs, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            // ## Why the raw `error.code` is kept (v0.2.11)
            //
            // `execFile` reports a missing binary as `error.code === 'ENOENT'` with an
            // **empty stderr** — there is no process to write one. Collapsing everything to
            // a number turned "not installed" into a generic failure, and the owner then got
            // "调用失败" instead of "去装一下". The string code is the only place that
            // distinction survives.
            const rawCode = error?.code;
            const numeric = typeof rawCode === 'number' ? rawCode : error === null ? 0 : 1;
            resolve({
                code: numeric,
                stdout: typeof stdout === 'string' ? stdout : '',
                stderr: typeof stderr === 'string' ? stderr : '',
                ...(typeof rawCode === 'string' ? { errorCode: rawCode } : {}),
            });
        });
    });
}
/**
 * Classify a failed invocation by what its stderr says.
 *
 * The CLI's own vocabulary, per the manual: it "prompts the specific reason" when the
 * balance is short, the service is not activated, or qualification is missing. We match
 * on those words rather than on exit codes, because the manual does not promise distinct
 * codes and guessing one would be worse than matching text.
 */
function classifyFailure(stderr, stdout, errorCode) {
    const text = scrubCredentials(`${stderr}\n${stdout}`).toLowerCase();
    // A missing binary has an empty stderr — the `error.code` is the only evidence.
    if (errorCode === 'ENOENT' || /enoent|command not found|不是内部或外部命令/.test(text)) {
        return {
            status: 'cli_missing',
            message: '没有找到 weibo-cli 可执行文件。请先安装：npm install -g @weibo-ai/weibo-cli',
        };
    }
    if (/not logged in|未登录|no auth|oauth|授权码|login required|unauthori[sz]ed/.test(text)) {
        return { status: 'not_authenticated', message: 'weibo-cli 尚未登录：请运行 weibo-cli auth login。' };
    }
    if (/认证|qualification|developer|未开通|not activated|service inactive|no service/.test(text)) {
        return {
            status: 'service_inactive',
            message: '开发者认证或服务未开通：需要在控制台完成扫脸认证并领取体验服务或购买积分包。',
        };
    }
    if (/quota|额度|余额|balance|insufficient|credit|超出|exceeded|rate limit|频率/.test(text)) {
        return { status: 'quota_exhausted', message: '额度或频率不足：本次读取未执行。' };
    }
    if (/unknown command|not available|no such command|不可用/.test(text)) {
        return { status: 'command_unavailable', message: '当前账号的可用命令里没有这一条。' };
    }
    return { status: 'failed', message: 'weibo-cli 调用失败。' };
}
/**
 * Parse one JSON document out of CLI output.
 *
 * The CLI prints JSON when asked (`--output json`); some commands may precede it with a
 * progress line, so this takes the first `{`…last `}` span rather than assuming the whole
 * stdout is the document. A payload that does not parse is a hard failure — returning a
 * partial object would let a caller treat "unreadable" as "empty".
 */
export function parseCliJson(stdout) {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end <= start)
        return { ok: false, reason: 'CLI 没有输出 JSON 对象' };
    const slice = stdout.slice(start, end + 1);
    try {
        return { ok: true, data: JSON.parse(slice) };
    }
    catch (error) {
        // ## The parse error carries a fragment of the input (v0.2.12 audit)
        //
        // `classifyFailure` scrubs stderr and stdout, but this path did not — and modern V8
        // includes a slice of the malformed input in the message:
        //
        //     Unexpected token 'a', "eyJhbGciOiJIUzI1NiIs..." is not valid JSON
        //
        // This `reason` becomes a `WeiboCliError.message`, which reaches logs, the diagnostic
        // panel and the model's context. Scrub it here too; the module's contract says nothing
        // token-shaped leaves through an error message.
        return { ok: false, reason: scrubCredentials(`CLI 输出的 JSON 无法解析：${error.message}`) };
    }
}
/**
 * Probe what this machine can actually do, without spending quota.
 *
 * Runs `version` and `doctor`, both of which the manual describes as local checks. The
 * result is the input to the capability matrix: a deployment where this says
 * `cli_missing` must not advertise any read as `supported`.
 */
export async function probeWeiboCli() {
    const version = await runCli(['version']);
    if (version.code !== 0) {
        const classified = classifyFailure(version.stderr, version.stdout, version.errorCode);
        // The common case on a machine that never installed the CLI deserves its own
        // wording: "install it" is a different instruction from "fix your auth".
        const missing = classified.status === 'cli_missing';
        return {
            status: classified.status,
            message: missing
                ? '没有安装 weibo-cli。这是最可能的原因：本机没有这个命令。'
                : classified.message,
            canRead: false,
            steps: missing
                ? [
                    '安装 CLI：npm install -g @weibo-ai/weibo-cli（需要 Node.js 18+）',
                    '在微博控制台用微博客户端扫码完成开发者认证',
                    '在「我的服务」领取体验服务（7 天）或购买积分包',
                    '运行 weibo-cli auth login 完成 OAuth 登录',
                    '运行 weibo-cli doctor 确认状态为就绪',
                ]
                : ['运行 weibo-cli doctor 查看具体缺哪一步', '完成对应步骤后重试'],
        };
    }
    const versionText = version.stdout.trim().split(/\r?\n/)[0] ?? '';
    const doctor = await runCli(['doctor']);
    if (doctor.code !== 0) {
        const classified = classifyFailure(doctor.stderr, doctor.stdout, doctor.errorCode);
        return {
            status: classified.status,
            message: classified.message,
            version: versionText,
            canRead: false,
            steps: [
                '运行 weibo-cli doctor 查看具体缺哪一步',
                '完成认证 / 开通服务 / 登录后重试',
            ],
        };
    }
    // `doctor` succeeding means authentication and service are in place. It is still one
    // more local check than a real read, so the caller must not advertise `supported` on
    // the strength of this alone.
    return {
        status: 'ok',
        message: 'weibo-cli 已就绪（认证与服务均已通过本地检查）。',
        version: versionText,
        canRead: true,
        steps: [],
    };
}
/**
 * The account's available command list.
 *
 * This is the only authority on "what can I call". Nothing in this module hard-codes a
 * command name for a *read*: the manual gives `commands list` / `commands show` as the
 * discovery mechanism, and inventing an endpoint path from memory is exactly what the
 * task book forbids.
 */
export async function listAvailableCommands() {
    const result = await runCli(['commands', 'list', '--available', '--output', 'json']);
    if (result.code !== 0) {
        const classified = classifyFailure(result.stderr, result.stdout);
        return { status: classified.status, message: classified.message };
    }
    const parsed = parseCliJson(result.stdout);
    if (!parsed.ok)
        return { status: 'failed', message: parsed.reason };
    const source = parsed.data;
    const list = Array.isArray(source)
        ? source
        : Array.isArray(source.commands)
            ? source.commands
            : Array.isArray(source.data)
                ? source.data
                : undefined;
    if (list === undefined) {
        return { status: 'failed', message: 'CLI 的命令清单结构与预期不符：找不到命令数组。' };
    }
    const commands = [];
    for (const entry of list) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        // The manual shows `users show/biz` style names; accept whichever field carries it.
        const name = [record.name, record.command, record.path].find((value) => typeof value === 'string' && value.trim() !== '');
        if (name === undefined)
            continue;
        commands.push({
            name,
            ...(typeof record.description === 'string' ? { description: record.description } : {}),
            ...(typeof record.price_type === 'string' ? { priceType: record.price_type } : {}),
        });
    }
    return { status: 'ok', message: `发现 ${commands.length} 条可用命令。`, data: commands };
}
/**
 * Whether the available list contains a read command we could use.
 *
 * ## Why this is only a *candidate* filter (v0.2.12)
 *
 * The task book is explicit: matching a command *name* with a regex does not establish
 * that the account can call it, and it certainly does not establish that its argument
 * shape matches what we would send. A catalog entry named `statuses/show` could require a
 * parameter this file does not know about, or be listed while the entitlement behind it is
 * inactive.
 *
 * So this function answers "which entries *look like* a status read or a comment read",
 * and {@link inspectCommand} must confirm the argument shape before anything is invoked.
 * `classifyCommands` alone must never be used to advertise a capability.
 */
export function classifyCommands(commands) {
    const names = commands.map((command) => command.name.toLowerCase());
    return {
        statuses: names.some((name) => /status|weibo|post/.test(name) && /show|get|read|detail/.test(name)),
        comments: names.some((name) => /comment/.test(name) && /list|show|get|read/.test(name)),
    };
}
/**
 * The argument names this layer is able to supply, and what it sends for each.
 *
 * ## Why a table rather than a regex (v0.2.12 audit)
 *
 * The first version decided "can we fill this?" with two patterns. That was wrong twice over:
 *
 * 1. **A name that looks like paging is not a name we can feed.** `PAGE_LIKE` matched
 *    `cursor` / `since` / `max_id` / `count` / `limit`, but `provider.ts` only ever sends
 *    `--page`. So a command whose *required* parameter was `cursor` was declared usable and
 *    then invoked **without it** — the guard did nothing while claiming to have checked.
 *
 * 2. **Unanchored substring matching.** `discount` contains `count`, `homepage_id` contains
 *    `page`. A required `--discount` looked fillable.
 *
 * The table below is the single source of truth: a name is fillable **only** if it appears
 * here, and the argv builder for it is the same one the adapter uses. If a future read needs a
 * new parameter, it has to be added here *and* in the invocation — the two cannot drift.
 */
const FILLABLE_ARGUMENTS = {
    // The post or comment being read. Passed positionally, never as a flag: the catalog's own
    // invocation form is `statuses/show <id>`.
    id: () => [],
    idstr: () => [],
    mid: () => [],
    status_id: () => [],
    weibo_id: () => [],
    post_id: () => [],
    // Paging. `page` is the only knob the adapter actually turns.
    page: (context) => ['--page', String(context.page)],
};
/**
 * Whether a required parameter name is one we can actually supply.
 *
 * Kept as a function so the table lookup is the only way in — a caller cannot accidentally
 * reintroduce a pattern match.
 */
export function canFillArgument(name, context) {
    const builder = FILLABLE_ARGUMENTS[name];
    if (builder === undefined)
        return false;
    // `page` only makes sense for a paged read; requiring it on an unpaged one would make every
    // such command look unusable.
    if (name === 'page' && !context.paged)
        return true;
    return builder(context) !== undefined;
}
/** Whether the CLI can express "replies to this one comment" at all. */
export function nestedFilterSupported(parameters) {
    // These are the plausible spellings. The point is not to guess which one the server uses —
    // it is to accept only a name the catalog actually lists, and report `undefined` otherwise.
    const candidates = ['parent_id', 'comment_id', 'reply_to', 'to_comment', 'root_id', 'cid'];
    return candidates.find((candidate) => parameters.includes(candidate));
}
/**
 * Read one command's schema with `commands show` and decide whether we can drive it.
 *
 * ## What "usable" means here
 *
 * We send a post id and a page number, nothing else. A command is usable only if **every
 * required parameter appears in `FILLABLE_ARGUMENTS`**. Anything else means we cannot
 * construct a valid call, and inventing a value would be forging a request.
 *
 * ## The `unknown` case the first version got backwards
 *
 * An earlier version did `rawParams = asArray(...) ?? []`, so a schema whose shape we failed to
 * parse produced `required = []`, which read as "no required parameters" and therefore
 * `usable: true`. That is the exact opposite of what this function exists for: a schema we
 * could not parse is a schema we have **not** verified. It is now `evidence: 'unknown'` and
 * refused.
 */
export async function inspectCommand(name, context = { paged: true, page: 1 }) {
    // The id comes from the catalog, not from user input, but it still goes in as a single
    // argv element — never concatenated into a command line.
    const result = await runCli(['commands', 'show', name, '--output', 'json']);
    if (result.code !== 0) {
        const classified = classifyFailure(result.stderr, result.stdout, result.errorCode);
        return { status: classified.status, message: classified.message };
    }
    const parsed = parseCliJson(result.stdout);
    if (!parsed.ok)
        return { status: 'failed', message: parsed.reason };
    const body = parsed.data;
    // The catalog's exact field names are not documented in the manual, so accept the few
    // shapes that could carry a parameter list rather than assuming one.
    //
    // `asArray(body)` is in the chain because a standard JSON Schema puts `properties` at the
    // **top level** of the document, not under a `schema` key. `asArray` already knows how to
    // turn a `properties` map into parameter rows, so handing it the whole document is what
    // makes that shape readable — without it, a textbook schema looked "unparseable".
    const parsedParams = asArray(body) ??
        asArray(body.params) ??
        asArray(body.parameters) ??
        asArray(body.schema?.params) ??
        asArray(body.schema?.parameters) ??
        asArray(body.schema?.properties) ??
        asArray(body.input?.params) ??
        asArray(body.input?.properties);
    // `undefined` (unrecognised shape) is different from `[]` (a genuinely parameterless
    // command), and the two must not collapse into the same verdict.
    const evidence = parsedParams === undefined ? 'unknown' : 'parsed';
    const rawParams = parsedParams ?? [];
    const parameters = [];
    const required = [];
    for (const entry of rawParams) {
        if (typeof entry === 'string') {
            parameters.push(entry.toLowerCase());
            continue;
        }
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        const paramName = [record.name, record.key, record.param].find((value) => typeof value === 'string' && value.trim() !== '');
        if (paramName === undefined)
            continue;
        parameters.push(paramName.toLowerCase());
        if (record.required === true || record.is_required === true)
            required.push(paramName.toLowerCase());
    }
    // A JSON-schema-style sibling `required: ["mid"]` array names parameters without repeating
    // them per property. The first version only read each property's own `required` flag, so a
    // standard schema always yielded an empty list. Merging both sources is what makes that
    // shape readable.
    const siblingRequired = [body.required, body.schema?.required];
    for (const candidate of siblingRequired) {
        if (!Array.isArray(candidate))
            continue;
        for (const name of candidate) {
            if (typeof name !== 'string')
                continue;
            const normalised = name.toLowerCase();
            if (!parameters.includes(normalised))
                parameters.push(normalised);
            if (!required.includes(normalised))
                required.push(normalised);
        }
    }
    const unfillable = required.filter((param) => !canFillArgument(param, context));
    const nestedFlag = nestedFilterSupported(parameters);
    const schema = {
        name,
        parameters,
        required,
        evidence,
        ...(nestedFlag === undefined ? {} : { nestedFilterFlag: nestedFlag }),
        // A schema we could not parse can never be "usable": the whole point of this check is to
        // confirm the shape before invoking.
        usable: evidence === 'parsed' && unfillable.length === 0,
        ...(evidence === 'unknown'
            ? {
                reason: `命令 ${name} 返回的参数 schema 结构无法识别，不能据此断定可以调用；` +
                    '无法确认要传哪些参数时不调用，猜测等于伪造请求。',
            }
            : unfillable.length === 0
                ? {}
                : {
                    reason: `命令 ${name} 要求必填参数 ${unfillable.join('、')}，本插件只会传帖子 id 与 --page；` +
                        '猜一个值去调用等于伪造请求，所以不调用。',
                }),
    };
    return { status: 'ok', message: `已读取 ${name} 的参数。`, data: schema };
}
/** Accept an array stored directly or under a `properties`-style wrapper. */
function asArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value === 'object' && value !== null) {
        const properties = value.properties;
        if (Array.isArray(properties))
            return properties;
        if (typeof properties === 'object' && properties !== null) {
            // JSON-schema `properties` is a map; the parameter names are its keys.
            return Object.keys(properties).map((key) => {
                const spec = properties[key];
                const required = typeof spec === 'object' && spec !== null && spec.required === true;
                return { name: key, required };
            });
        }
    }
    return undefined;
}
/**
 * Invoke one already-validated read command.
 *
 * ## What this deliberately does not do
 *
 * - It does not discover or validate: the caller must have run {@link inspectCommand}
 *   first. Keeping validation and invocation apart means a caller cannot accidentally
 *   execute a command whose argument shape was never checked.
 * - It does not retry. A retry after a timeout is how the same comment gets read twice and
 *   then counted twice; the caller decides, with the dedupe rules in hand.
 * - It does not treat a non-zero exit as a soft failure. Every failure keeps its classified
 *   status so the caller can distinguish quota from auth from upstream.
 */
export async function runReadCommand(command, args, options = {}) {
    const started = Date.now();
    const result = await runCli([command, ...args, '--output', 'json'], options.timeoutMs);
    const elapsedMs = Date.now() - started;
    if (result.code !== 0) {
        const classified = classifyFailure(result.stderr, result.stdout, result.errorCode);
        return { status: classified.status, message: classified.message, command, elapsedMs };
    }
    const parsed = parseCliJson(result.stdout);
    if (!parsed.ok)
        return { status: 'failed', message: parsed.reason, command, elapsedMs };
    return { status: 'ok', message: `${command} 执行成功。`, data: parsed.data, command, elapsedMs };
}
//# sourceMappingURL=cli.js.map