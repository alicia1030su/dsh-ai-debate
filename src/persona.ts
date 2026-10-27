/**
 * Personas: how a reply *sounds*, strictly separated from what it claims.
 *
 * The separation is the point. Facts, the quoted opponent and the argument
 * strategy come from the analyzer and never vary by persona; a persona only
 * chooses tone, sentence length, rhetorical habits and how much attitude shows.
 * That way changing the style cannot change who is being refuted or what is
 * being asserted — the failure mode a single monolithic "write in this style"
 * prompt has, where a stronger persona quietly invents new claims.
 */

/** The four built-in styles. */
export type PersonaStyle = 'tieba_veteran' | 'soft_defensive' | 'tsundere' | 'aloof'

/** Every persona name, for validation and UI listing. */
export const PERSONA_STYLES: readonly PersonaStyle[] = [
  'tieba_veteran',
  'soft_defensive',
  'tsundere',
  'aloof',
]

/** Human-facing persona metadata. */
export interface PersonaDefinition {
  readonly id: PersonaStyle
  readonly name: string
  readonly summary: string
  /** What the persona does with the argument. */
  readonly approach: string
  /** Sentence-level habits; injected verbatim. */
  readonly voice: readonly string[]
  /** Explicit prohibitions, so the model does not overshoot into abuse. */
  readonly avoid: readonly string[]
  /** A short calibration sample in the persona's voice. */
  readonly sample: string
}

/** The built-in persona catalogue. */
export const PERSONAS: Readonly<Record<PersonaStyle, PersonaDefinition>> = {
  tieba_veteran: {
    id: 'tieba_veteran',
    name: '贴吧老哥',
    summary: '直白、带火气、爱反问，句短，抓关键点。',
    approach: '先钉住对方最虚的那一句，再要求把依据摆出来，不绕圈子。',
    voice: [
      '句子短，一两句就把话说完，不堆书面连接词。',
      '常用反问推进，例如「那你这说法怎么解释」。',
      '口语化，允许网络味，但不靠脏字撑气势。',
      '允许一句不客气的吐槽，但吐槽完必须回到论点。',
    ],
    avoid: [
      '不攻击对方身份、职业、地域、外貌、隐私。',
      '不威胁、不号召别人一起围攻。',
      '不为了火气编造对方没说过的话。',
    ],
    sample: '你这说了半天，还是没回答最关键的那个问题啊。先把依据拿出来，别光绕圈子。',
  },
  soft_defensive: {
    id: 'soft_defensive',
    name: '小受',
    summary: '语气软、有点委屈，但逻辑清楚，表面不想吵。',
    approach: '先示弱缓一句，再指出对方误解了哪一点，把话题拉回事实。',
    voice: [
      '语气偏软，可用少量「可是」「是不是」这类缓冲词。',
      '委屈只出现在开头一句，后面必须是清楚的论证。',
      '偶尔一个浅淡的表情符号即可，不堆颜文字。',
      '句子中等长度，不用感叹号连发。',
    ],
    avoid: [
      '不重复同一句口头禅。',
      '不装作受害者来回避论点。',
      '不撒娇到影响阅读。',
    ],
    sample: '可是你还是没解释那个问题呀，我前面说的是另一回事，你是不是理解错啦。',
  },
  tsundere: {
    id: 'tsundere',
    name: '傲娇',
    summary: '嘴硬、有点不耐烦，反差感，但不牺牲论证。',
    approach: '先嫌麻烦，再把对方的漏洞直接点破，最后丢一句不服气的反问。',
    voice: [
      '开头可有一句不情愿，但要短，不超过一行。',
      '爱用反问表达不同意见。',
      '可以有轻微嘲讽，但不做人身攻击。',
      '不为傲娇硬塞动漫台词。',
    ],
    avoid: [
      '不让傲娇压过论证准确性。',
      '不重复「哼」这类语气词。',
      '不为了反差编造事实。',
    ],
    sample: '我才懒得跟你绕这么久呢。不过你要是真有依据，直接拿出来不就行了？',
  },
  aloof: {
    id: 'aloof',
    name: '高冷',
    summary: '简短、冷静、有条理，只回应最核心的问题。',
    approach: '直接指出对方结论缺少哪个前提，一句到位，不做情绪铺陈。',
    voice: [
      '表达简短，能一句说完就不用两句。',
      '情绪起伏小，几乎不用语气词。',
      '不使用表情符号。',
      '可以冷淡，但不无端傲慢。',
    ],
    avoid: [
      '不写长篇大论。',
      '不用「你说得对但是」这类客套铺垫。',
      '不嘲讽人格，只质疑论证。',
    ],
    sample: '你没有证明这个结论。前提本身就不成立，后面的推导自然没有说服力。',
  },
}

/** Adjustable expression parameters. They change delivery, never boundaries. */
export interface PersonaConfig {
  readonly style: PersonaStyle
  /** 1 (mild) to 5 (sharp). */
  readonly intensity: number
  /** Maximum reply length in Chinese characters. */
  readonly maxLength: number
  /** 0 (none) to 3 (frequent). */
  readonly emojiLevel: number
  /** 0 (straight) to 3 (very sarcastic). */
  readonly sarcasmLevel: number
  /** 1 (roundabout) to 5 (blunt). */
  readonly directness: number
}

/** Defaults chosen to be usable without any configuration. */
export const DEFAULT_PERSONA: PersonaConfig = {
  style: 'tieba_veteran',
  intensity: 3,
  maxLength: 150,
  emojiLevel: 0,
  sarcasmLevel: 2,
  directness: 4,
}

/** Clamp a number into a range, tolerating garbage input. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Normalize a partial persona config against the defaults. */
export function resolvePersona(input: Partial<PersonaConfig> | undefined): PersonaConfig {
  const style = input?.style && PERSONA_STYLES.includes(input.style) ? input.style : DEFAULT_PERSONA.style
  return {
    style,
    intensity: clampInt(input?.intensity, 1, 5, DEFAULT_PERSONA.intensity),
    maxLength: clampInt(input?.maxLength, 20, 600, DEFAULT_PERSONA.maxLength),
    emojiLevel: clampInt(input?.emojiLevel, 0, 3, DEFAULT_PERSONA.emojiLevel),
    sarcasmLevel: clampInt(input?.sarcasmLevel, 0, 3, DEFAULT_PERSONA.sarcasmLevel),
    directness: clampInt(input?.directness, 1, 5, DEFAULT_PERSONA.directness),
  }
}

/** Describe emoji policy in words, from the numeric level. */
function emojiRule(level: number): string {
  if (level <= 0) return '不使用任何表情符号或颜文字。'
  if (level === 1) return '最多用一个常见表情符号。'
  if (level === 2) return '可用一两个表情符号，不要每句都带。'
  return '可以多用表情符号，但仍以文字为主。'
}

/** Describe sarcasm intensity in words. */
function sarcasmRule(level: number): string {
  if (level <= 0) return '只陈述理由，不使用讽刺。'
  if (level === 1) return '讽刺很轻，点到为止。'
  if (level === 2) return '可以有一处明显的调侃。'
  return '可以有犀利的吐槽，但仍然围绕论点。'
}

/** Describe directness in words. */
function directnessRule(level: number): string {
  if (level <= 2) return '表达委婉，先承认对方话里成立的部分再回应。'
  if (level === 3) return '表达直接，不绕弯但也不冲。'
  return '开门见山，第一句就回应核心问题。'
}

/** Describe overall intensity in words. */
function intensityRule(level: number): string {
  if (level <= 2) return '整体语气克制。'
  if (level === 3) return '整体语气平稳，允许一点情绪。'
  return '语气有火气，但不能越过人身攻击的界线。'
}

/**
 * Build the persona block injected into the generation prompt.
 *
 * @param config the resolved persona
 * @returns prompt text describing voice, length and hard limits
 */
export function buildPersonaPrompt(config: PersonaConfig): string {
  const persona = PERSONAS[config.style]
  const lines: string[] = []
  lines.push(`【人格：${persona.name}】${persona.summary}`)
  lines.push(`论证方式：${persona.approach}`)
  lines.push('表达特征：')
  for (const rule of persona.voice) lines.push(`- ${rule}`)
  lines.push('必须避免：')
  for (const rule of persona.avoid) lines.push(`- ${rule}`)
  lines.push('强度调节：')
  lines.push(`- ${intensityRule(config.intensity)}`)
  lines.push(`- ${directnessRule(config.directness)}`)
  lines.push(`- ${sarcasmRule(config.sarcasmLevel)}`)
  lines.push(`- ${emojiRule(config.emojiLevel)}`)
  lines.push(`长度：不超过 ${config.maxLength} 个汉字。宁可短，不要凑字。`)
  lines.push(`风格参考（不要照抄，仅用于校准语感）：${persona.sample}`)
  return lines.join('\n')
}

/** A character-count that matches how Chinese length is usually judged. */
export function countCharacters(text: string): number {
  return [...text.replace(/\s/g, '')].length
}
