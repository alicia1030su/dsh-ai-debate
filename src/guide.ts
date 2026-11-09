/**
 * 把「出错了」翻译成「下一步做什么」（v0.2.39 §4.2）。
 *
 * ## 为什么错误提示要单独成一个模块
 *
 * 一个普通用户遇到的第一件事，往往不是「功能不会用」，而是某一步失败了。而失败信息
 * 在这个项目里以前有三种来源各说各话：`LlmError.code`、导入解析器的中文句子、以及
 * 各种 `throw new Error(...)` 的自由文本。于是同一个「没配模型」可能显示成
 * 「宿主有提供方，但没有可用模型」「调用失败」「LLM unavailable」三句不同的话，而
 * 三句都没有告诉用户点哪里。
 *
 * 这里把**能行动的错误**收成一张表：每种错误有一个稳定的 id、一句人话、以及按顺序
 * 排列的下一步。判据是「用户能照做」，不是「技术上准确」—— 技术上准确的错误码对用户
 * 没有用。
 *
 * ## 这个模块不做什么
 *
 * 它不做诊断。诊断（到底是 401 还是 DNS 失败）在 `llm.ts` 与 `host-llm.ts` 里，
 * 那些地方才看得到 HTTP 状态与错误消息。这里只做**翻译**：拿到已经判定的错误种类，
 * 给出该说的话。把诊断也放进来，就等于让一个纯函数去猜网络状态。
 */

/** 用户会遇到的、需要一句不同的话的错误种类。 */
export type GuideId =
  /** 宿主没有提供 llm 服务。 */
  | 'no_host_model'
  /** 宿主有服务，但没有可用模型（没登录 / 没配密钥）。 */
  | 'host_model_unavailable'
  /** 自己配置的接口地址不对（协议、路径、端口）。 */
  | 'bad_base_url'
  /** 密钥无效或过期。 */
  | 'auth_failed'
  /** 接口说的话不是本插件认识的协议。 */
  | 'protocol_mismatch'
  /** 导入文本不符合格式。 */
  | 'import_format'
  /** 讨论里没有可用评论。 */
  | 'no_comments'
  /** 材料不足以支撑一条回复。 */
  | 'insufficient_evidence'
  /** 网络不可达。 */
  | 'network'
  /** 模型超时。 */
  | 'timeout'
  /** 剪贴板权限被拒。 */
  | 'clipboard_blocked'
  /** 配额或频率限制。 */
  | 'quota'

/** 一条错误的可执行说明。 */
export interface Guide {
  readonly id: GuideId
  /** 一句话说清发生了什么。不写错误码，不写堆栈。 */
  readonly title: string
  /** 按顺序的下一步。第一条应当是最可能有效的。 */
  readonly next: readonly string[]
  /**
   * 是不是用户这边可以自己解决的。
   *
   * `false` 表示「先别试了，等一会儿或找维护者」—— 把可重试与不可重试分开，能省掉
   * 用户反复点按钮的那几分钟。
   */
  readonly retryable: boolean
}

const GUIDES: Readonly<Record<GuideId, Guide>> = {
  no_host_model: {
    id: 'no_host_model',
    title: '没有找到可用的模型：这个 DSH 没有把模型服务交给插件',
    next: [
      '在「设置 → 模型」里把「模型来源」改成「自己配置的模型接口」，填 Base URL、模型名和 API Key',
      '填完点「测试模型连接」，看到「连接成功」再回到这里',
      '如果你确认宿主本来就有模型，先点一次「检查宿主模型」看它是否列得出来',
    ],
    retryable: false,
  },
  host_model_unavailable: {
    id: 'host_model_unavailable',
    title: '宿主有模型服务，但没有可用模型（通常是没登录或没配密钥）',
    next: [
      '在 DSH 里登录你的模型账号，或确认已经在宿主的模型设置里配好密钥',
      '回到「设置 → 模型」点「检查宿主模型」，能看到模型名就说明好了',
      '不想登录也可以改用「自己配置的模型接口」，填自己的接口',
    ],
    retryable: false,
  },
  bad_base_url: {
    id: 'bad_base_url',
    title: '模型接口地址看起来不对：请求没有到达一个 OpenAI 兼容的接口',
    next: [
      '确认 Base URL 以 /v1 结尾，例如 https://api.example.com/v1',
      '如果是本机服务，确认端口和路径（http://127.0.0.1:3000/v1）',
      '点「测试模型连接」，它会显示实际请求的地址和返回的前几十个字',
    ],
    retryable: true,
  },
  auth_failed: {
    id: 'auth_failed',
    title: '模型接口拒绝了这次请求：密钥无效、过期，或没有这个模型的权限',
    next: [
      '在「设置 → 模型」重新填一次 API Key（旧值不会显示，需要整段重填）',
      '确认这个 Key 有权限调用你填的那个模型名',
      '换一个模型名试试，有些服务商的 Key 是按模型授权的',
    ],
    retryable: false,
  },
  protocol_mismatch: {
    id: 'protocol_mismatch',
    title: '接口回的话不是本插件认识的格式：协议选错了，或这个地址不是模型接口',
    next: [
      '在「设置 → 模型 → 接口协议」里切换 chat / responses 再试一次',
      '确认 Base URL 指向的是模型服务，而不是网页或文档地址',
      '点「测试模型连接」，它会显示返回的前几十个字，能直接看出是不是模型接口',
    ],
    retryable: true,
  },
  import_format: {
    id: 'import_format',
    title: '这段文字没有被解析成讨论：缺少作者与分隔符',
    next: [
      '把第一行填成「作者：内容」作为原帖，然后单独一行写 ---',
      '在 --- 之后，每条评论一行「作者：内容」，粘贴进输入框',
      '点「预览解析结果」，它会告诉你读到了几层、几条，以及哪一行没认出来',
    ],
    retryable: true,
  },
  no_comments: {
    id: 'no_comments',
    title: '这段讨论里没有别的评论，只有原帖',
    next: [
      '把评论一起复制进来：没有对方发言就没有可回应的内容',
      '确认复制时没有漏掉 --- 之后的部分',
      '如果原帖本来就没评论，这个功能用不上，换一条讨论',
    ],
    retryable: false,
  },
  insufficient_evidence: {
    id: 'insufficient_evidence',
    title: '材料不足以支撑一条有依据的回复：模型要求补充，这是正确行为',
    next: [
      '按它说出的缺口补上那一部分（通常是对方那条被删的评论、原文链接或截图里的数字）',
      '在「评论列表」里换一条更有依据的目标',
      '不补也可以：现在这条如果硬写，只会变成没有依据的猜测',
    ],
    retryable: false,
  },
  network: {
    id: 'network',
    title: '连不上模型服务：网络不通，或地址在本机不可达',
    next: [
      '确认这台机器能访问那个地址（浏览器打开 Base URL 看是否有响应）',
      '如果在代理后面，确认 DSH 走了代理',
      '本机服务确认进程还在跑',
    ],
    retryable: true,
  },
  timeout: {
    id: 'timeout',
    title: '模型在规定时间内没有返回',
    next: [
      '再点一次生成（长回复偶尔会超时）',
      '在「设置 → 模型」里把「最大输出 token」调小一些，输出越长越容易超时',
      '在「设置 → 模型 → 模型名称」里换一个响应更快的模型',
    ],
    retryable: true,
  },
  clipboard_blocked: {
    id: 'clipboard_blocked',
    title: '浏览器没有允许写剪贴板',
    next: [
      '页面上会显示要复制的全文，手动选中复制即可',
      '在浏览器地址栏左侧的权限设置里允许这个页面使用剪贴板',
      '在 DSH 桌面端里打开这个页面通常不需要额外授权',
    ],
    retryable: true,
  },
  quota: {
    id: 'quota',
    title: '模型服务说额度用完了，或被限流',
    next: [
      '等几分钟再试（限流通常是短时的）',
      '确认账号余额与套餐',
      '换一个模型或换一个服务商',
    ],
    retryable: true,
  },
}

/** 取一条说明。未知 id 也能安全调用 —— 返回一条通用的，而不是抛错。 */
export function guideOf(id: GuideId): Guide {
  return GUIDES[id]
}

/**
 * 把 `LlmError.code` 翻成 `GuideId`。
 *
 * 认不出来的码返回 `undefined`，由调用方决定说什么 —— 编一个「未知错误」的说明，
 * 等于假装我们知道原因。
 */
export function guideIdOfLlmCode(code: string): GuideId | undefined {
  switch (code) {
    case 'unavailable':
      return 'no_host_model'
    case 'unauthorized':
      return 'auth_failed'
    case 'timeout':
      return 'timeout'
    case 'rate_limited':
    case 'quota':
      return 'quota'
    case 'bad_response':
      return 'protocol_mismatch'
    case 'truncated':
      return 'timeout'
    case 'context_too_long':
      return 'insufficient_evidence'
    default:
      return undefined
  }
}

/** 全部 id。用于测试遍历，避免新增一条却忘了加断言。 */
export const GUIDE_IDS: readonly GuideId[] = Object.keys(GUIDES) as GuideId[]

/**
 * 从任意一个抛出来的错误里认出该给哪条说明。
 *
 * ## 为什么按结构认，不按消息文本认
 *
 * 消息文本是给人读的中文，会随着措辞改动而变；靠 `message.includes('没有可用模型')`
 * 判断，等于把文案变成协议。这里只认两样稳定的东西：
 *
 * - `LlmError.code`（一个封闭的枚举）
 * - 错误对象上显式的 `guide` 字段（调用方已经知道是哪一类时自己标）
 *
 * 都认不出来就返回 `undefined`，让调用方原样显示错误 —— 比编一句「未知错误」好。
 */
export function guideForError(error: unknown): Guide | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const tagged = (error as { guide?: unknown }).guide
  if (typeof tagged === 'string' && GUIDE_IDS.includes(tagged as GuideId)) {
    return GUIDES[tagged as GuideId]
  }
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  const id = guideIdOfLlmCode(code)
  return id === undefined ? undefined : GUIDES[id]
}
