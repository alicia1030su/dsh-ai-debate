/**
 * The host-half probes and diagnostics the settings page calls.
 *
 * Everything here is a *read*: `testModel` sends one tiny completion and counts
 * the round trip, `checkLogin` reads the account page, `previewPersonas` renders
 * the persona prompts locally without calling the model at all. None of them
 * publish, none of them touch the store's session list, and none of them return
 * a credential value.
 *
 * That restraint is the whole point of the module. A settings page with a
 * "test connection" button is a settings page that can be pressed carelessly, so
 * every probe is cheap, idempotent and unable to change the world beyond its own
 * network read.
 */
import { readFileSync } from 'node:fs';
import { PERSONAS, PERSONA_STYLES, buildPersonaPrompt, resolvePersona } from './persona.js';
import { LlmError } from './llm.js';
import { chooseModelSource } from './model-source.js';
import { extractJsonObject } from './generator.js';
import { chooseStoreDir, dshHomeDir } from './store-dir.js';
/**
 * Plugin version, mirrored into the diagnostics panel.
 *
 * Read from the package manifest rather than typed here. The literal had drifted
 * — it still said 0.1.6 while the package was 0.1.8 — so the diagnostics panel
 * was confidently reporting a version that did not exist. Deriving it removes
 * the whole class of mistake; `test/version.test.ts` pins the result so a
 * packaging change that breaks the lookup fails loudly instead of silently
 * falling back.
 */
export const PLUGIN_VERSION = (() => {
    try {
        const url = new URL('../package.json', import.meta.url);
        const parsed = JSON.parse(readFileSync(url, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.version === 'string') {
            return parsed.version;
        }
    }
    catch {
        // A missing manifest must not stop the plugin from mounting.
    }
    return '0.0.0-unknown';
})();
/** The fixed exchange the persona preview renders against. */
const PREVIEW_EXCHANGE = {
    opponent: '你这说法根本站不住脚，别拿个例当规律。',
    claim: '对方用一个例子否定整体结论，忽略了样本本身不具代表性。',
};
/**
 * Render all four personas against the fixed exchange.
 *
 * Deliberately local: the preview exists so a user can compare *prompt shapes*
 * and register differences before spending tokens, and so a deployment with no
 * model configured still shows something true. The `sample` is the persona's own
 * calibration line, which is what generation is steered toward; the prompt shape
 * is the actual text the model receives, trimmed to its structure.
 */
export async function previewPersonas(config) {
    return PERSONA_STYLES.map((style) => {
        const persona = PERSONAS[style];
        const resolved = resolvePersona({
            style,
            intensity: config.intensity,
            maxLength: config.maxLength,
            emojiLevel: config.emojiLevel,
            sarcasmLevel: config.sarcasmLevel,
            directness: config.directness,
        });
        const prompt = buildPersonaPrompt(resolved);
        const lines = prompt.split('\n');
        return {
            style,
            name: persona.name,
            summary: persona.summary,
            sample: persona.sample,
            // The structural shape: the identity line, the approach, and the four
            // parameter lines that the sliders actually move. Taking only the first
            // three lines would have shown an identical string for every intensity —
            // a preview that cannot show the thing it is previewing.
            promptShape: [
                ...lines.slice(0, 2),
                ...lines.filter((line) => /^- (整体|表达|可以|只陈述|讽刺|开门见山)/.test(line)),
            ]
                .slice(0, 6)
                .join(' / '),
        };
    });
}
/**
 * The contract probe: can this model return the JSON the workflow needs?
 *
 * ## Why a second call is worth the tokens
 *
 * "The endpoint answered OK" and "the model can fill this schema" are different claims, and
 * only the second one decides whether the plugin works. A model that speaks the protocol
 * perfectly and ignores the JSON contract fails later, inside a generation, where the
 * reported symptom is "the model returned something unparseable" — which sends the owner
 * looking at their prompt instead of their model.
 *
 * ## Why this fixture and not the real generation prompt
 *
 * The real prompt needs a collected thread, a validated brief and a persona. Sending it here
 * would make "test connection" cost a full generation and depend on the store. This fixture
 * is the smallest exchange that still exercises every field the parser needs, so a pass
 * means the *contract* works, not that a particular discussion will work.
 */
const CONTRACT_PROBE_PROMPT = `下面是一小段论坛对话。

主人：「这个方案的成本会翻倍，不能这么做。」
对方：「翻倍是暂时的，分摊到三年就不算什么。」

请只输出一个 JSON 对象，不要 markdown 代码块，不要解释。字段：
{
  "status": "ok",
  "owner_position": "主人主张的一句话",
  "opponent_position": "对方主张的一句话",
  "main_dispute": "双方分歧的一句话",
  "latest_argument": "对方最新一句的要点",
  "response_target_id": "opp-post-1",
  "strategy": "direct_rebuttal",
  "confidence": 0.7,
  "uncertainties": [],
  "reply": "一条三十字以内的中文回复"
}`;
/** Fields every contract answer must carry, and the JSON types they must have. */
const CONTRACT_FIELDS = [
    { name: 'status', kind: 'string' },
    { name: 'owner_position', kind: 'string' },
    { name: 'opponent_position', kind: 'string' },
    { name: 'main_dispute', kind: 'string' },
    { name: 'response_target_id', kind: 'string' },
    { name: 'strategy', kind: 'string' },
    { name: 'confidence', kind: 'number' },
    { name: 'uncertainties', kind: 'array' },
    { name: 'reply', kind: 'string' },
];
/**
 * Check one answer against the contract.
 *
 * Uses `extractJsonObject` — the same locator the generation path uses — so a model that
 * wraps its JSON in prose or a code fence is judged exactly as it will be judged in
 * production rather than more harshly here.
 */
function checkContract(text) {
    const sample = text.trim().slice(0, 200);
    const json = extractJsonObject(text);
    if (json === undefined) {
        return {
            ok: false,
            message: '模型没有返回 JSON 对象：这个模型可能不支持结构化输出，或提示词被忽略',
            sample,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return { ok: false, message: '模型返回的 JSON 无法解析（可能被截断或引号未转义）', sample };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, message: '模型返回的不是 JSON 对象', sample };
    }
    const record = parsed;
    const missing = [];
    for (const field of CONTRACT_FIELDS) {
        const value = record[field.name];
        if (value === undefined || value === null) {
            missing.push(field.name);
            continue;
        }
        if (field.kind === 'array' && !Array.isArray(value))
            missing.push(`${field.name}(应为数组)`);
        else if (field.kind === 'string' && typeof value !== 'string')
            missing.push(`${field.name}(应为字符串)`);
        else if (field.kind === 'number' && typeof value !== 'number')
            missing.push(`${field.name}(应为数字)`);
    }
    if (missing.length > 0) {
        return {
            ok: false,
            message: `模型返回了 JSON，但缺少或类型错误的字段：${missing.join('、')}`,
            missingFields: missing,
            sample,
        };
    }
    const reply = typeof record.reply === 'string' ? record.reply.trim() : '';
    if (reply === '' && record.status === 'ok') {
        return { ok: false, message: '模型返回 status=ok 但 reply 为空：它没有真正按契约回答', sample };
    }
    return { ok: true, message: '模型能按契约返回 JSON 候选', sample };
}
/**
 * Probe the configured model endpoint.
 *
 * One short completion with a token cap, so a misconfigured endpoint costs a few
 * hundred tokens rather than a full draft. A failure is reported as data, not
 * thrown: the page needs to show *why* it failed, and "the button did nothing"
 * is the outcome this exists to prevent.
 */
export async function testModel(runtime, config) {
    // 先问「会走哪条路」，而不是先问「配置里有没有 Base URL」：v0.2.36 起，没有
    // 自己配置也可能完全可用 —— 宿主就带着模型。按旧顺序判断会在这种环境里报
    // 「还没有配置模型接口」，而实际上点一下生成就能出结果。
    let choice;
    try {
        choice = chooseModelSource(config, { host: runtime.hostLlm, egress: runtime.egress });
    }
    catch (error) {
        const code = error instanceof LlmError ? error.code : 'unavailable';
        return {
            ok: false,
            baseUrl: config.llmBaseUrl,
            model: config.llmModel,
            message: error instanceof Error ? error.message : String(error),
            protocol: config.llmProtocol === 'responses' ? 'responses' : 'chat/completions',
            errorCode: code,
            source: 'none',
            ...(runtime.hostLlm === undefined ? {} : { hostAvailable: true }),
            suggestions: [
                '在插件设置里填 Base URL / API Key / 模型名称，指向任意 OpenAI 兼容接口',
                '或者先让 DSH 自己配好模型，再把「模型来源」设为「自动」',
            ],
        };
    }
    const hostInUse = choice.source === 'host';
    // 宿主这一路没有「Base URL」可言：请求由宿主的适配器发出。这里报空串，让页面
    // 显示「宿主模型服务」而不是一个假的地址。
    const baseUrl = hostInUse ? '' : config.llmBaseUrl;
    const model = hostInUse ? '' : config.llmModel;
    const protocol = hostInUse
        ? 'host'
        : config.llmProtocol === 'responses'
            ? 'responses'
            : 'chat/completions';
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let sample;
    try {
        const client = runtime.llm();
        const reply = await client.complete({
            system: '你是一个连通性测试。只回复 OK 两个字母，不要标点，不要解释。',
            messages: [{ role: 'user', content: 'ping' }],
            maxTokens: 8,
            temperature: 0,
        });
        const latencyMs = Date.now() - started;
        inputTokens += reply.inputTokens ?? 0;
        outputTokens += reply.outputTokens ?? 0;
        const text = (reply.text ?? '').trim();
        if (text !== '')
            sample = text.slice(0, 40);
        /**
         * 第二步：同一连接上再做一次契约探测（v0.2.35 §2.1）。
         *
         * 同一个 client、同一套凭据、同一个协议 —— 所以它顺带证明了「刚才那次成功不是偶然」，
         * 而不只是证明「这个模型会回 OK」。失败不复位 `ok`：连通性是通的事实仍然成立，
         * 页面需要同时看到这两件事。
         */
        const contractStarted = Date.now();
        let contract;
        try {
            const answer = await client.complete({
                system: '你是一个严格按 JSON 契约输出的助手。只输出要求的 JSON 对象。',
                messages: [{ role: 'user', content: CONTRACT_PROBE_PROMPT }],
                maxTokens: 400,
                temperature: 0,
            });
            inputTokens += answer.inputTokens ?? 0;
            outputTokens += answer.outputTokens ?? 0;
            const verdict = checkContract(answer.text);
            contract = {
                ...verdict,
                latencyMs: Date.now() - contractStarted,
                ...(answer.inputTokens === undefined ? {} : { inputTokens: answer.inputTokens }),
                ...(answer.outputTokens === undefined ? {} : { outputTokens: answer.outputTokens }),
                ...(answer.truncated === true
                    ? { message: `${verdict.message}（这次输出被截断，可能上限太低）` }
                    : {}),
            };
        }
        catch (error) {
            const code = error instanceof LlmError ? error.code : 'unknown';
            contract = {
                ok: false,
                message: `契约探测失败：${error instanceof Error ? error.message : String(error)}（${code}）`,
                latencyMs: Date.now() - contractStarted,
            };
        }
        const sourceLabel = hostInUse ? '宿主模型服务' : '自己配置的接口';
        return {
            ok: true,
            baseUrl,
            model: model === '' ? (reply.model ?? '') : model,
            ...(reply.model === undefined ? {} : { provider: reply.model }),
            latencyMs,
            message: `连接正常（${sourceLabel}），耗时 ${latencyMs} ms。`,
            protocol,
            source: choice.source,
            ...(sample === undefined ? {} : { sample }),
            ...(reply.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }),
            ...(reply.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens }),
            contract,
            totalMs: Date.now() - started,
            // A response that was cut off at 8 tokens still proves the endpoint speaks the protocol.
            // Saying so prevents the owner from reading a short sample as a broken model.
            ...(reply.truncated === true ? { suggestions: ['模型在 8 个 token 内就达到输出上限；连通性没问题，但生成时请调大输出上限'] } : {}),
        };
    }
    catch (error) {
        const latencyMs = Date.now() - started;
        const code = error instanceof LlmError ? error.code : 'unknown';
        const status = error instanceof LlmError ? error.status : undefined;
        return {
            ok: false,
            baseUrl,
            model,
            latencyMs,
            message: error instanceof Error ? error.message : String(error),
            protocol,
            source: choice.source,
            errorCode: code,
            ...(status === undefined ? {} : { status }),
            totalMs: Date.now() - started,
            suggestions: suggestionsFor(code),
        };
    }
    void inputTokens;
    void outputTokens;
}
/**
 * Turn a failure code into something the owner can act on.
 *
 * ## Why this is a table rather than a sentence
 *
 * "模型接口请求失败" is true and useless: it names neither the cause nor the next step, so the
 * reader's only recourse is to guess. Each code below corresponds to a different action, and
 * they are not interchangeable — retrying a rejected key burns quota, and changing the key
 * when the context was too long fixes nothing.
 */
function suggestionsFor(code) {
    switch (code) {
        case 'unauthorized':
            return ['API Key 被拒绝：检查 Key 是否正确、是否已过期、是否有该模型的权限'];
        case 'quota':
            return ['额度不足：检查账户余额或该 Key 的用量上限'];
        case 'rate_limited':
            return ['被限流：降低频率后重试；插件默认不自动重试，避免叠加消耗'];
        case 'timeout':
            return ['请求超时：模型可能较慢，可调大「模型超时」；也可能是 Base URL 不可达'];
        case 'context_too_long':
            return ['上下文超出模型限制：减少读取页数，或在设置里换用上下文更长的模型'];
        case 'bad_response':
            return [
                '返回内容不是预期的 JSON 契约：确认 Base URL 指向 OpenAI 兼容的 /v1 接口，而不是 /v1/responses 或网页地址',
                '若地址正确，可能是该模型不支持 JSON 输出，换一个支持结构化输出的模型',
            ];
        case 'cancelled':
            return ['请求被取消：重新点一次「测试连接」即可'];
        case 'unavailable':
            return ['无法连接：检查 Base URL、网络与代理；本机模型确认服务已启动'];
        default:
            return ['检查 Base URL 与模型名称是否正确'];
    }
}
/**
 * Probe the bound account's login state through the adapter.
 *
 * The adapter owns the cookie jar, so this is the only honest way to answer
 * "am I logged in": it makes the same request a real publish would, and reports
 * the account the platform says is logged in. A `ok: false` here is not a
 * failure of the *plugin* — an unauthenticated state still allows public reads —
 * so the message says what still works.
 *
 * Wording is platform-neutral since v0.2.0: it used to say "贴吧" and "Cookie",
 * which was correct for one platform and wrong for the next one.
 */
export async function checkLogin(runtime) {
    const cookieNames = describeCookieNames(runtime);
    const platformName = runtime.adapter.displayName;
    try {
        const auth = await runtime.adapter.checkAuthentication();
        if (!auth.authenticated) {
            return {
                ok: false,
                authenticated: false,
                message: (auth.reason ?? `当前没有有效的${platformName}登录态`) +
                    `。读取公开帖子仍然可以，但无法确认发帖账号身份，因此不能发表。` +
                    `请在凭据栏保存一份已登录浏览器的凭据。`,
                cookieNames,
            };
        }
        return {
            ok: true,
            authenticated: true,
            message: `已登录：${auth.userName ?? '（平台未返回昵称）'}`,
            ...(auth.userName === undefined ? {} : { userName: auth.userName }),
            ...(auth.userId === undefined ? {} : { userId: auth.userId }),
            cookieNames,
        };
    }
    catch (error) {
        return {
            ok: false,
            authenticated: false,
            message: `检查登录态失败：${error instanceof Error ? error.message : String(error)}`,
            cookieNames,
        };
    }
}
/** Which cookie names the adapter currently holds (never the values). */
function describeCookieNames(runtime) {
    const probe = runtime.adapter;
    return typeof probe.describeCookieNames === 'function' ? probe.describeCookieNames() : [];
}
/**
 * Assemble the diagnostics block.
 *
 * Counts come from the store snapshot and the publish ledger, which are the two
 * durable records. `recentErrors` reads the usage log's failed rows rather than a
 * separate error log, because that is where every failure already lands — keeping
 * a second list would guarantee the two disagree.
 */
export async function collectDiagnostics(runtime, config, options = {}) {
    await runtime.store.ready();
    const data = runtime.store.snapshot();
    const usage = runtime.store.usageSummary();
    const byState = new Map();
    for (const session of data.sessions) {
        byState.set(session.state, (byState.get(session.state) ?? 0) + 1);
    }
    const awaited = (byState.get('NEEDS_CONFIRMATION') ?? 0) + (byState.get('READY') ?? 0) + (byState.get('REVIEWING') ?? 0);
    const confirmed = data.dedupe.filter((row) => row.publishState === 'confirmed').length;
    const pending = data.dedupe.filter((row) => row.publishState === 'pending').length;
    const failed = data.dedupe.filter((row) => row.publishState === 'failed').length;
    const recentErrors = data.usage
        .filter((row) => typeof row.error === 'string' && row.error !== '')
        .slice(-10)
        .reverse()
        .map((row) => ({ at: row.at, message: String(row.error).slice(0, 300) }));
    // Recomputed rather than stored on the runtime: `chooseStoreDir` is pure, and a
    // second source of truth for "where did this path come from" is exactly how the
    // v0.2.23 page ended up showing a plausible path with no provenance.
    const chosenDir = chooseStoreDir({ configured: config.storeDir });
    return {
        enabled: config.enabled,
        storePath: runtime.store.path,
        storeDirSource: chosenDir.source,
        ...(dshHomeDir() === undefined ? {} : { dshHome: dshHomeDir() }),
        sessions: {
            total: data.sessions.length,
            // "active" means work is still possible from this state, which is exactly
            // the population the UI's "未完成任务" line should count.
            active: data.sessions.filter((row) => !['PUBLISHED', 'FAILED', 'CANCELLED'].includes(row.state)).length,
            awaitingConfirmation: awaited,
            published: byState.get('PUBLISHED') ?? 0,
        },
        publishLedger: {
            total: data.dedupe.length,
            confirmed,
            pending,
            failed,
            overCapacity: data.dedupe.length > 2000,
        },
        usage,
        recentErrors,
        rateLimit: {
            limited: options.rateLimited === true,
            note: options.rateLimited === true
                ? '贴吧接口当前对本机限流：楼中楼读取会降级为内联数据，页面会标注「声明 N 条 / 读到 M 条」。'
                : '未观测到限流；楼中楼读取按页面内联数据与接口补充。',
        },
        ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
        pluginVersion: PLUGIN_VERSION,
    };
}
/** The fixed exchange the persona preview is written against. */
export { PREVIEW_EXCHANGE };
//# sourceMappingURL=diagnostics.js.map