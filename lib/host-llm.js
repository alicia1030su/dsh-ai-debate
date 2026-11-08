/**
 * 复用宿主（DSH）已经配置好的模型服务。
 *
 * ## 为什么要有这条路
 *
 * 插件自己的模型配置要求用户再填一次 Base URL 与 API Key —— 哪怕他刚刚在
 * DSH 里配好模型、正在正常聊天。那是**第二份凭据**：多一处要保管的密钥，
 * 也多一种「两边不一致」的故障（宿主能聊、插件报未授权）。
 *
 * 宿主从 0.2.x 起把模型能力注册成公开服务 `llm`（`Runtime` 里 `ctx.get('llm')`），
 * 提供 `listProviders()` / `listModels(provider)` / `stream(request)`。这是**正式
 * 接口**：宿主自己的 agent 循环就走它，请求与分片的形状有类型声明
 * （`GenerateOptions` / `StreamChunk`）。所以本模块只做一件事 —— 把那三个方法
 * 适配成插件内部的 `LlmClient`，**不读取、不缓存、不落盘任何凭据**。
 *
 * ## 为什么不在这个文件里申请权限、也不读宿主配置
 *
 * 密钥在宿主手里，插件从头到尾看不到它。这不是洁癖：`llmApiKey` 一旦被插件
 * 读过一次，它就会出现在插件的内存、可能的日志和 bug 报告里。走宿主服务，
 * 插件能拿到的只有「文本 + token 数」，泄露面最小。
 *
 * ## 契约是结构化的，不是 import 来的
 *
 * 这里用结构化类型（`HostLlmLike`）而不是 `import type { ... } from '@deepseek-ai/dsh-llm'`：
 * 插件要能在不同 Harness 构建上加载，绑定到具体版本的类型会让「宿主升级 → 插件
 * 加载失败」。形状对不上时**报一条能读的错**，而不是静默返回空字符串。
 */
import { LlmError } from './llm.js';
/** 把 `unknown` 收成字符串，非字符串一律空串。 */
function str(value) {
    return typeof value === 'string' ? value : '';
}
/** 从宿主返回的模型条目里取 provider/model，容忍多写或少写字段。 */
function choiceOf(entry, provider) {
    if (entry === null || typeof entry !== 'object')
        return undefined;
    const record = entry;
    const model = str(record.id) || str(record.model);
    if (model === '')
        return undefined;
    const owner = str(record.provider) || provider;
    const name = str(record.name);
    return { provider: owner, model, ...(name === '' ? {} : { name }) };
}
/**
 * 探测宿主模型服务。
 *
 * 只读：`listProviders` / `listModels`。不发起任何补全，所以调用它是安全的 ——
 * 设置页可以随时刷新这一栏，不会花掉一次生成预算。
 */
export async function probeHostLlm(service, signal) {
    if (service === undefined || service === null) {
        return { available: false, servicePresent: false, providers: [], models: [], reason: '宿主没有提供 llm 服务（ctx.get("llm") 为空）' };
    }
    if (typeof service.stream !== 'function') {
        return {
            available: false,
            servicePresent: true,
            providers: [],
            models: [],
            reason: '宿主的 llm 服务没有 stream()，与本插件认识的形状不一致',
        };
    }
    const providers = [];
    try {
        const listed = typeof service.listProviders === 'function' ? service.listProviders() : [];
        for (const entry of listed ?? []) {
            const id = typeof entry === 'string' ? entry : str(entry?.id);
            if (id !== '')
                providers.push(id);
        }
    }
    catch (error) {
        return {
            available: false,
            servicePresent: true,
            providers: [],
            models: [],
            reason: `列举宿主模型提供方失败：${error.message}`,
        };
    }
    if (providers.length === 0) {
        return {
            available: false,
            servicePresent: true,
            providers: [],
            models: [],
            reason: '宿主的 llm 服务在，但没有任何已注册的模型提供方',
        };
    }
    const models = [];
    const failures = [];
    for (const provider of providers) {
        if (typeof service.listModels !== 'function')
            continue;
        try {
            const entries = await service.listModels(provider);
            for (const entry of entries ?? []) {
                const choice = choiceOf(entry, provider);
                if (choice !== undefined)
                    models.push(choice);
            }
        }
        catch (error) {
            failures.push(`${provider}: ${error.message}`);
        }
    }
    if (signal !== undefined && signal.aborted)
        throw new LlmError('已取消', 'cancelled');
    // 「有提供方但一个模型都列不出来」是真实的失败状态：可能是没登录、没配 key、
    // 或者适配器起不来。报 available=false 并给出原因，而不是让调用方挑一个空模型名
    // 再去等一个更难读的报错。
    if (models.length === 0) {
        return {
            available: false,
            servicePresent: true,
            providers,
            models: [],
            reason: failures.length > 0
                ? `列出模型失败：${failures.join('；')}`
                : '宿主有提供方，但没有可用模型（可能还没登录或没配置密钥）',
        };
    }
    return { available: true, servicePresent: true, providers, models };
}
/**
 * 挑一个默认模型。
 *
 * 偏好顺序写死在这里，是因为「默认值」必须可预测：宿主往往会注册多个提供方，
 * 取第一个实现的枚举顺序会在宿主升级时静默换模型。优先 DeepSeek 官方，其次
 * 名字里带 flash 的（便宜、够用），最后退回第一个。
 */
export function pickHostModel(models) {
    if (models.length === 0)
        return undefined;
    const official = models.find((entry) => entry.provider === 'deepseek-official');
    if (official !== undefined)
        return official;
    const flash = models.find((entry) => /flash|mini|small|lite/i.test(entry.model));
    return flash ?? models[0];
}
/** 把宿主的失败分类成插件自己的错误码。 */
function classify(status, code) {
    if (status === 401 || status === 403)
        return 'unauthorized';
    if (status === 402)
        return 'quota';
    if (status === 429)
        return 'rate_limited';
    if (status === 413)
        return 'context_too_long';
    if (code === 'ABORTED' || code === 'CANCELLED')
        return 'cancelled';
    if (code === 'TIMEOUT' || code === 'ETIMEDOUT')
        return 'timeout';
    if (code === 'NO_ADAPTER' || code === 'UNAVAILABLE')
        return 'unavailable';
    if (code === 'MAX_TOKENS' || code === 'TRUNCATED')
        return 'truncated';
    return 'unknown';
}
/** 请求里的消息转成宿主认得的形状。 */
function toHostMessage(message) {
    return { role: message.role, content: [{ type: 'text', text: message.content }] };
}
/**
 * 宿主模型客户端。
 *
 * 每次 `complete()` 只发一次 `stream()`，不重试：宿主服务自己带重试策略，
 * 再叠一层会让一次点击花掉两次额度而使用者只看到一次。
 */
export class HostLlmClient {
    label;
    service;
    choice;
    constructor(service, choice) {
        this.service = service;
        this.choice = choice;
        this.label = `host:${choice.provider}/${choice.model}`;
    }
    async complete(request) {
        const stream = this.service.stream;
        if (typeof stream !== 'function') {
            throw new LlmError('宿主的 llm 服务没有 stream()，无法生成', 'unavailable');
        }
        if (request.signal !== undefined && request.signal.aborted)
            throw new LlmError('已取消', 'cancelled');
        // `system` 单独给，不塞进 messages：宿主把它渲染成系统节点，塞进用户消息会
        // 让模型的「指令 / 数据」边界消失 —— 而提示词注入正是靠这个边界失效的。
        const payload = {
            provider: this.choice.provider,
            model: this.choice.model,
            ...(request.system === undefined ? {} : { system: request.system }),
            messages: request.messages.map(toHostMessage),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
            signal: request.signal,
        };
        let text = '';
        let inputTokens;
        let outputTokens;
        let finish;
        let sawChunk = false;
        try {
            for await (const raw of stream.call(this.service, payload)) {
                if (request.signal !== undefined && request.signal.aborted)
                    throw new LlmError('已取消', 'cancelled');
                if (raw === null || typeof raw !== 'object')
                    continue;
                sawChunk = true;
                const chunk = raw;
                const type = str(chunk.type);
                if (type === 'text-delta') {
                    text += str(chunk.text);
                    continue;
                }
                if (type === 'usage') {
                    const usage = chunk.usage;
                    if (usage !== undefined && usage !== null) {
                        const inTokens = usage.inputTokens;
                        const outTokens = usage.outputTokens;
                        if (typeof inTokens === 'number')
                            inputTokens = inTokens;
                        if (typeof outTokens === 'number')
                            outputTokens = outTokens;
                    }
                    continue;
                }
                if (type === 'finish') {
                    const reason = chunk.reason;
                    const kind = str(reason?.kind);
                    const failure = reason?.failure;
                    finish = {
                        kind,
                        ...(failure === undefined || failure === null
                            ? {}
                            : {
                                failure: {
                                    code: str(failure.code),
                                    ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
                                    message: str(failure.message),
                                },
                            }),
                    };
                }
            }
        }
        catch (error) {
            if (error instanceof LlmError)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            if (request.signal?.aborted === true)
                throw new LlmError('已取消', 'cancelled');
            throw new LlmError(`宿主模型调用失败：${message}`, 'unknown', { cause: error });
        }
        if (finish !== undefined && finish.kind === 'error') {
            const status = finish.failure?.status;
            const code = classify(status, finish.failure?.code ?? '');
            throw new LlmError(`宿主模型返回错误：${finish.failure?.message ?? finish.failure?.code ?? '未知'}`, code, status === undefined ? {} : { status });
        }
        if (finish !== undefined && finish.kind === 'aborted') {
            throw new LlmError('已取消', 'cancelled');
        }
        if (text === '' && !sawChunk) {
            // 一个分片都没有：形状不对或服务没有真正注册适配器。报出来，不要把空串当成
            // 「模型说了空话」—— 那会让解析层把一次基础设施故障记成一次模型违纪。
            throw new LlmError('宿主模型没有返回任何分片（服务形状可能与本插件不一致）', 'bad_response');
        }
        const truncated = finish?.kind === 'max-tokens';
        return {
            text,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            model: `${this.choice.provider}/${this.choice.model}`,
            ...(finish === undefined ? {} : { finishReason: truncated ? 'length' : finish.kind }),
            ...(truncated ? { truncated: true } : {}),
            attempts: 1,
        };
    }
}
/**
 * 从宿主 ctx 里取 llm 服务。
 *
 * 两种读法都试：`ctx.get('llm')`（Cordis 的服务表）与 `ctx.llm`（旧构建上的直挂）。
 * 取不到就返回 `undefined` ——「宿主没提供模型服务」是一个正常状态，不是错误。
 */
export function hostLlmOf(ctx) {
    if (ctx === null || typeof ctx !== 'object')
        return undefined;
    const record = ctx;
    /**
     * ## 读服务必须容错到「属性访问本身会抛」（v0.2.36）
     *
     * Cordis 的 ctx 是代理：**没有在 `inject` 里声明过的服务，读属性会直接抛**
     * `cannot get property "llm" without inject`，而不是返回 undefined。第一版只把
     * `get()` 包在 try 里，`ctx.llm` 那一次裸读就让插件在真实容器上**挂载失败** ——
     * 一个「探测可选能力」的函数把整个插件搞崩了，这是最不该发生的形状。
     *
     * 所以两种读法都在 try 里，且任何异常都按「没有这个服务」处理。
     */
    const usable = (value) => value !== null &&
        typeof value === 'object' &&
        typeof value.stream === 'function';
    try {
        const direct = record.llm;
        if (usable(direct))
            return direct;
    }
    catch {
        // 未声明 inject 的代理抛错，按「没有」处理。
    }
    const get = record.get;
    if (typeof get === 'function') {
        try {
            const service = get.call(ctx, 'llm');
            if (usable(service))
                return service;
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
/**
 * 延迟解析的宿主客户端。
 *
 * `buildLlm()` 是同步的（`Runtime.llm()` 的签名如此），而「宿主有哪些模型」是异步
 * 的。硬把它改成异步会波及整条调用链，所以这里把解析推迟到**第一次真正要生成**
 * 的时候，并把结果记住。代价是第一次生成多一次 `listModels`（宿主内部的本地查询，
 * 不发网络请求）；收益是不改任何既有签名。
 */
export class LazyHostLlmClient {
    label = 'host:auto';
    service;
    preferred;
    resolved;
    constructor(service, preferred) {
        this.service = service;
        this.preferred = preferred;
    }
    /** 当前解析到的模型，供用量日志读取；还没解析时为 undefined。 */
    current() {
        return this.resolved;
    }
    async complete(request) {
        const choice = this.resolved ?? (await this.resolve());
        this.resolved = choice;
        return new HostLlmClient(this.service, choice).complete(request);
    }
    async resolve() {
        if (this.preferred !== undefined)
            return this.preferred;
        const probe = await probeHostLlm(this.service);
        if (!probe.available) {
            throw new LlmError(`宿主模型服务不可用：${probe.reason ?? '未知原因'}。可以在插件设置里改用「自己配置的模型接口」。`, 'unavailable');
        }
        const picked = pickHostModel(probe.models);
        if (picked === undefined)
            throw new LlmError('宿主没有任何可用模型', 'unavailable');
        return picked;
    }
}
//# sourceMappingURL=host-llm.js.map