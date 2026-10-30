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
    /** What the persona does with the argument. */
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