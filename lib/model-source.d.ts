/**
 * 模型客户端的选择：宿主、自己配置的接口，还是什么都不选。
 *
 * ## 为什么单独一个文件
 *
 * `buildLlm()` 原来只有一条路径（读配置里的 Base URL）。v0.2.36 加进来两件事：
 * 宿主模型服务与出网守卫。把「选哪条路 + 为什么选它」摊在一个函数里，比在
 * 运行时里堆三元表达式更容易说清，也更容易测 —— 这个文件不碰磁盘、不碰网络，
 * 只拿配置和两个可注入的依赖，返回一个 `LlmClient` 或一条能读的拒绝理由。
 */
import type { ResolvedConfig } from './config.js';
import { type LlmClient } from './llm.js';
import { type HostLlmLike } from './host-llm.js';
import type { EgressGuard } from './net-audit.js';
/** 选路需要的依赖。 */
export interface ModelSourceDeps {
    /** 宿主的模型服务；宿主没提供时为 undefined。 */
    readonly host?: HostLlmLike | undefined;
    /** 出网守卫；没有时不做限制（测试与旧调用方）。 */
    readonly egress?: EgressGuard | undefined;
    /** 测试注入点。 */
    readonly fetchImpl?: typeof fetch;
}
/** 选出来的结果，附带「为什么是它」。 */
export interface ModelSourceChoice {
    readonly client: LlmClient;
    /** `host` / `custom` / `none`，用于设置页与诊断。 */
    readonly source: 'host' | 'custom' | 'none';
    /** 人读的说明：用了哪个模型的哪条路，以及为什么。 */
    readonly reason: string;
}
/**
 * 选一个模型客户端，或者抛出一条带下一步动作的错误。
 *
 * 顺序（`auto`）：
 * 1. 自己配了 Base URL + 模型名 → 用自己那份。用户的显式配置永远优先于推断。
 * 2. 否则宿主有可用模型 → 用宿主的。
 * 3. 都没有 → 抛出 `unavailable`，并分别说明两条路各缺什么。
 *
 * `host` 与 `custom` 是强制选择：选了 `host` 就不再回落到自己的配置 —— 一个
 * 「我选了只用宿主的」的用户，不该在某次宿主故障时悄悄花掉自己另一份额度。
 */
export declare function chooseModelSource(config: ResolvedConfig, deps?: ModelSourceDeps): ModelSourceChoice;
//# sourceMappingURL=model-source.d.ts.map