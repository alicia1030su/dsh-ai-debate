/**
 * 数据来源与能力的统一标识（v0.2.30 §四）。
 *
 * ## 为什么需要这个模块
 *
 * 到 v0.2.29 为止，「这份讨论是怎么来的」只散落在三处：平台的 `CapabilityMatrix`、
 * 会话上的 `readQuality`、以及诊断面板的自由文本。用户看到的是一个绿色的
 * 「微博」标签，然后自己猜这次到底是官方接口读的，还是自己粘进来的。
 *
 * 这不是措辞问题。两条来源的证据强度差着一个数量级：
 *
 * - **官方 CLI 真实读取**：内容是平台返回的，作者 id 可能是平台签发的，
 *   「读取完整」有可能被平台自己的声明证明。
 * - **人工导入**：内容是用户粘的，没有平台签名，没有作者 id，完整性无从谈起。
 *
 * 把两者显示成同一个「微博」，就是在用一个真实平台的名字给剪贴板内容背书。
 *
 * ## 五种状态，与能力矩阵同一套词汇
 *
 * `supported | degraded | unverified | permission_required | unavailable`——
 * 刻意复用 `PlatformCapabilityMatrix` 的取值，因为「这条能力现在是什么状态」在
 * 项目里已经有一个答案了，再造一套只会让两张面板对不齐。
 */

import type { CapabilityState } from '../platforms/contracts.js'
import { MANUAL_PLATFORM } from './manual.js'

/**
 * 一份讨论的来源。
 *
 * 只有两种，而且必须是两种：它们之间没有中间态。想做「部分核验」的分类会让
 * 用户以为存在一种既不是接口读的、也不是自己粘的第三种东西，而实际不存在。
 */
export type DataSource = 'official_read' | 'manual_import'

/** 来源的完整描述，页面直接渲染它。 */
export interface SourceDescriptor {
  readonly source: DataSource
  /** 短标签，一行能放下。 */
  readonly label: string
  /** 一句话说清「这份内容是谁给的」。 */
  readonly provenance: string
  /**
   * 这份内容能不能证明「我读全了」。
   *
   * 真实读取：平台自己说了算，有可能为真。
   * 人工导入：永远为假——粘贴的一定是片段，而且没有任何东西能核对缺了多少。
   */
  readonly canProveCompleteness: boolean
  /**
   * 作者能不能被证明是某个账号。
   *
   * 真实读取：平台可能签发稳定账号 id，那就可能为真。
   * 人工导入：永远为假，因为昵称是打进去的文本。
   */
  readonly canProveAuthorship: boolean
  /** 这份来源下，写操作是否可能发生。人工导入永远为 `false`。 */
  readonly allowsWrite: boolean
  /** 一句话的风险提示，必须与用户看到的其他标记一致。 */
  readonly caution: string
}

/** 官方接口读取来的。 */
export const OFFICIAL_READ: SourceDescriptor = {
  source: 'official_read',
  label: '官方接口读取',
  provenance: '内容由平台接口返回，读取过程有请求与响应的记录。',
  canProveCompleteness: true,
  canProveAuthorship: true,
  allowsWrite: true,
  caution: '读取成功不等于内容完整：是否读完取决于平台自己的声明，面板上会单独标注。',
}

/** 人工导入的。 */
export const MANUAL_IMPORT: SourceDescriptor = {
  source: 'manual_import',
  label: '人工导入 · 未经平台核验',
  provenance: '内容由你粘贴或从本地文件导入，插件没有向平台核对过其中任何一条。',
  canProveCompleteness: false,
  canProveAuthorship: false,
  allowsWrite: false,
  // 这句话是这个标记存在的理由：它要阻止「我在微博上看到过这条」变成
  // 「插件确认这是微博上的内容」。
  caution:
    '这份内容可能与平台上的实际情况不一致：可能被删改、可能漏掉一部分、' +
    '也可能是伪造的。插件只把它当作你提供的材料，不会据此向平台发出任何请求。',
}

/** 按平台与会话判断来源。 */
export function sourceOf(input: {
  readonly platform: string
  readonly hasImport?: boolean
}): SourceDescriptor {
  // 两个条件都要看：`imported` 存在是决定性的，`platform === manual` 是它的
  // 结构性后果。只在平台名上判断，会让一份被错误标成 `weibo` 的导入内容
  // 显示成官方读取；只在 `imported` 上判断，会让旧会话里 `platform` 是 `manual`
  // 但没存导入内容的那种情形显示成真实读取。
  return input.hasImport === true || input.platform === MANUAL_PLATFORM ? MANUAL_IMPORT : OFFICIAL_READ
}

/**
 * 一条能力的展示行。
 *
 * `state` 用能力矩阵的词汇，`evidence` 说明「凭什么这么说」。
 * 后者是必须的：没有证据的状态标签会让用户以为面板在猜。
 */
export interface CapabilityRow {
  /** 能力名，与 `CapabilityName` 对齐（`thread.read`、`comment.publish` 等）。 */
  readonly capability: string
  /** 面向用户的短名。 */
  readonly title: string
  readonly state: CapabilityState
  /** 为什么是这个状态。 */
  readonly evidence: string
  /** 用户能做什么，没有就空数组。 */
  readonly steps: readonly string[]
}

/**
 * 人工导入的能力表。
 *
 * ## 为什么这里的能力是「声明出来的」而不是「探测出来的」
 *
 * 真实平台的能力要探测：CLI 在不在、登录了没、账号有没有这个命令。导入没有
 * 可探测的东西——它的能力完全由代码结构决定，而且这个结构是刻意设计的：
 * 读的是本地内容，写的是不可能的。所以这里的每一行都是常量事实，
 * 而不是某次探测的结果。把它们标成 `unverified` 反而是错的。
 */
export const MANUAL_CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: 'thread.read',
    title: '读取讨论正文',
    state: 'supported',
    evidence: '正文就是你导入的那段文字，插件按原样显示，不做任何改写。',
    steps: [],
  },
  {
    capability: 'comment.list',
    title: '列出发言',
    state: 'supported',
    evidence: '按导入的顺序逐条列出，作者名按你写的原样显示。',
    steps: [],
  },
  {
    capability: 'comment.reply',
    title: '生成回复',
    state: 'supported',
    evidence: '生成在本地完成，读的是你导入的内容，不会向平台发请求。',
    steps: [],
  },
  {
    capability: 'comment.publish',
    title: '发表到平台',
    state: 'unavailable',
    evidence:
      '人工导入的内容没有对应的真实帖子，插件无法确认「这条回复该落在哪一条下面」。' +
      '离线流程的终点是复制回复，不是发表。',
    steps: ['生成之后点「复制回复」，自己贴到平台上。'],
  },
  {
    capability: 'identity.verify',
    title: '核验作者身份',
    state: 'unavailable',
    evidence:
      '导入内容里的作者名是打进去的文本，不是平台签发的账号 id。' +
      '重名的两个人在这里看起来完全一样。',
    steps: ['如果需要在真实平台上核验身份，请用官方接口读取该帖子。'],
  },
]
