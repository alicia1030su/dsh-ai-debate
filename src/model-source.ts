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

import type { ResolvedConfig } from './config.js'
import { LlmError, OpenAiCompatibleClient, type LlmClient, type OpenAiClientOptions } from './llm.js'
import { LazyHostLlmClient, type HostLlmLike } from './host-llm.js'
import type { EgressGuard } from './net-audit.js'

/** 选路需要的依赖。 */
export interface ModelSourceDeps {
  /** 宿主的模型服务；宿主没提供时为 undefined。 */
  readonly host?: HostLlmLike | undefined
  /** 出网守卫；没有时不做限制（测试与旧调用方）。 */
  readonly egress?: EgressGuard | undefined
  /** 测试注入点。 */
  readonly fetchImpl?: typeof fetch
}

/** 选出来的结果，附带「为什么是它」。 */
export interface ModelSourceChoice {
  readonly client: LlmClient
  /** `host` / `custom` / `none`，用于设置页与诊断。 */
  readonly source: 'host' | 'custom' | 'none'
  /** 人读的说明：用了哪个模型的哪条路，以及为什么。 */
  readonly reason: string
}

/** 自己那份配置是否完整到可以用。 */
function customReady(config: ResolvedConfig): boolean {
  return config.llmBaseUrl.trim() !== '' && config.llmModel.trim() !== ''
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
export function chooseModelSource(config: ResolvedConfig, deps: ModelSourceDeps = {}): ModelSourceChoice {
  const wantHost = config.llmSource === 'host'
  const wantCustom = config.llmSource === 'custom'

  if (wantCustom) {
    if (!customReady(config)) {
      throw new LlmError(
        '模型来源被设为「自己配置」，但 Base URL 或模型名称还没填。请在插件设置里补齐这两项，或把来源改回「自动」。',
        'unavailable',
      )
    }
    return { client: customClient(config, deps), source: 'custom', reason: `自己配置的接口：${config.llmModel}` }
  }

  if (wantHost) {
    if (deps.host === undefined) {
      throw new LlmError(
        '模型来源被设为「宿主模型」，但当前宿主没有提供 llm 服务。请改回「自动」，或在插件设置里自己配置模型接口。',
        'unavailable',
      )
    }
    return { client: new LazyHostLlmClient(deps.host), source: 'host', reason: '宿主模型服务（密钥由宿主持有，插件不读取）' }
  }

  // auto
  if (customReady(config)) {
    return {
      client: customClient(config, deps),
      source: 'custom',
      reason: `自动选择：自己配置的接口（${config.llmModel}）优先`,
    }
  }
  if (deps.host !== undefined) {
    return {
      client: new LazyHostLlmClient(deps.host),
      source: 'host',
      reason: '自动选择：检测到宿主模型服务，且没有自己配置的接口（密钥由宿主持有，插件不读取）',
    }
  }
  throw new LlmError(
    '还没有可用的模型。两条路选一条：① 在设置里把 Base URL / API Key / 模型名称填上（任意 OpenAI 兼容接口）；② 让宿主先配好模型，再把「模型来源」设为「自动」或「宿主模型」。',
    'unavailable',
  )
}

/** 构造自己配置的客户端，并套上出网守卫。 */
function customClient(config: ResolvedConfig, deps: ModelSourceDeps): LlmClient {
  const options: OpenAiClientOptions = {
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    protocol: config.llmProtocol,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmRetries ?? 0,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    // 守卫包在 fetch 上：这是模型侧唯一的外呼出口，包在这里意味着没有第二条
    // 绕过它的路径（换协议、换重试都不会）。
    ...(deps.egress === undefined ? {} : { fetchImpl: deps.egress.fetch(deps.fetchImpl ?? fetch) }),
  }
  return new OpenAiCompatibleClient(options)
}
