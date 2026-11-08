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
export type PersonaStyle = 'tieba_veteran' | 'soft_defensive' | 'tsundere' | 'aloof';
/** Every persona name, for validation and UI listing. */
export declare const PERSONA_STYLES: readonly PersonaStyle[];
/** Human-facing persona metadata. */
export interface PersonaDefinition {
    readonly id: PersonaStyle;
    readonly name: string;
    readonly summary: string;
    /**
     * 这个人格「说话的样子」，**不含打法**（v0.2.38）。
     *
     * ## 为什么这个字段被收窄
     *
     * 它原来是「先钉住对方最虚的那一句，再要求把依据摆出来」这类描述 —— 那是**论证策略**，
     * 不是语气。四种人格的 approach 于是变成了四份不同的打法说明，而它是当时唯一的打法
     * 来源，结果就是「换人格＝换打法」，四种人格在真实模型上全都收敛到「追问参照」。
     *
     * 现在打法由 `strategy.ts` 独立选择，这里只描述**同一句话在不同人格下长什么样**：
     * 句子节奏、开口方式、情绪露出的多少。写成打法就会重新把两层绑回去。
     */
    readonly approach: string;
    /** Sentence-level habits; injected verbatim. */
    readonly voice: readonly string[];
    /** Explicit prohibitions, so the model does not overshoot into abuse. */
    readonly avoid: readonly string[];
    /** A short calibration sample in the persona's voice. */
    readonly sample: string;
}
/** The built-in persona catalogue. */
export declare const PERSONAS: Readonly<Record<PersonaStyle, PersonaDefinition>>;
/** Adjustable expression parameters. They change delivery, never boundaries. */
export interface PersonaConfig {
    readonly style: PersonaStyle;
    /** 1 (mild) to 5 (sharp). */
    readonly intensity: number;
    /** Maximum reply length in Chinese characters. */
    readonly maxLength: number;
    /** 0 (none) to 3 (frequent). */
    readonly emojiLevel: number;
    /** 0 (straight) to 3 (very sarcastic). */
    readonly sarcasmLevel: number;
    /** 1 (roundabout) to 5 (blunt). */
    readonly directness: number;
}
/** Defaults chosen to be usable without any configuration. */
export declare const DEFAULT_PERSONA: PersonaConfig;
/** Normalize a partial persona config against the defaults. */
export declare function resolvePersona(input: Partial<PersonaConfig> | undefined): PersonaConfig;
/**
 * Build the persona block injected into the generation prompt.
 *
 * @param config the resolved persona
 * @returns prompt text describing voice, length and hard limits
 */
export declare function buildPersonaPrompt(config: PersonaConfig): string;
/** A character-count that matches how Chinese length is usually judged. */
export declare function countCharacters(text: string): number;
//# sourceMappingURL=persona.d.ts.map