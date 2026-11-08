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
import { type LlmClient, type LlmRequest, type LlmResponse } from './llm.js';
/** 宿主模型服务暴露的最小形状。 */
export interface HostLlmLike {
    listProviders?: () => readonly unknown[];
    listModels?: (provider: string) => Promise<readonly unknown[]> | readonly unknown[];
    stream?: (request: unknown) => AsyncIterable<unknown> | Iterable<unknown>;
}
/** 一个可选的宿主模型。 */
export interface HostModelChoice {
    readonly provider: string;
    readonly model: string;
    readonly name?: string;
}
/** 探测结果：有没有宿主服务、能列出哪些模型、列不出来时为什么。 */
export interface HostLlmProbe {
    readonly available: boolean;
    readonly servicePresent: boolean;
    readonly providers: readonly string[];
    readonly models: readonly HostModelChoice[];
    /** 人读的原因：没有服务、形状不对、列模型失败。 */
    readonly reason?: string;
}
/**
 * 探测宿主模型服务。
 *
 * 只读：`listProviders` / `listModels`。不发起任何补全，所以调用它是安全的 ——
 * 设置页可以随时刷新这一栏，不会花掉一次生成预算。
 */
export declare function probeHostLlm(service: HostLlmLike | undefined, signal?: AbortSignal): Promise<HostLlmProbe>;
/**
 * 挑一个默认模型。
 *
 * 偏好顺序写死在这里，是因为「默认值」必须可预测：宿主往往会注册多个提供方，
 * 取第一个实现的枚举顺序会在宿主升级时静默换模型。优先 DeepSeek 官方，其次
 * 名字里带 flash 的（便宜、够用），最后退回第一个。
 */
export declare function pickHostModel(models: readonly HostModelChoice[]): HostModelChoice | undefined;
/**
 * 宿主模型客户端。
 *
 * 每次 `complete()` 只发一次 `stream()`，不重试：宿主服务自己带重试策略，
 * 再叠一层会让一次点击花掉两次额度而使用者只看到一次。
 */
export declare class HostLlmClient implements LlmClient {
    readonly label: string;
    private readonly service;
    private readonly choice;
    constructor(service: HostLlmLike, choice: HostModelChoice);
    complete(request: LlmRequest): Promise<LlmResponse>;
}
/**
 * 从宿主 ctx 里取 llm 服务。
 *
 * 两种读法都试：`ctx.get('llm')`（Cordis 的服务表）与 `ctx.llm`（旧构建上的直挂）。
 * 取不到就返回 `undefined` ——「宿主没提供模型服务」是一个正常状态，不是错误。
 */
export declare function hostLlmOf(ctx: unknown): HostLlmLike | undefined;
/**
 * 延迟解析的宿主客户端。
 *
 * `buildLlm()` 是同步的（`Runtime.llm()` 的签名如此），而「宿主有哪些模型」是异步
 * 的。硬把它改成异步会波及整条调用链，所以这里把解析推迟到**第一次真正要生成**
 * 的时候，并把结果记住。代价是第一次生成多一次 `listModels`（宿主内部的本地查询，
 * 不发网络请求）；收益是不改任何既有签名。
 */
export declare class LazyHostLlmClient implements LlmClient {
    readonly label = "host:auto";
    private readonly service;
    private readonly preferred;
    private resolved;
    constructor(service: HostLlmLike, preferred?: HostModelChoice);
    /** 当前解析到的模型，供用量日志读取；还没解析时为 undefined。 */
    current(): HostModelChoice | undefined;
    complete(request: LlmRequest): Promise<LlmResponse>;
    private resolve;
}
//# sourceMappingURL=host-llm.d.ts.map