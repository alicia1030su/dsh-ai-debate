/**
 * Normalise text for inspection without destroying the evidence.
 *
 * ## Two copies, on purpose
 *
 * An attacker hides an instruction with a full-width character, a zero-width
 * joiner, or a homoglyph. To recognise it, the checker has to look at a
 * normalised copy. But that copy must **never** be what we quote, store, or show
 * a human: the owner reviewing a block needs to see what was actually written,
 * and the evidence a report cites has to be the platform's bytes.
 *
 * So this module produces a `ScanView` holding both. Callers use `scan` for
 * detection and `raw` for everything else.
 *
 * ## What normalisation does *not* do
 *
 * - It does not "clean" the text for the model. Feeding a sanitised copy to the
 *   model would mean the model never sees the real argument, and stripping
 *   characters from a comment is a silent edit of someone's words.
 * - It does not decode encodings to execute them. Base64 that decodes to
 *   "ignore previous instructions" is recorded as *a suspicious encoded fragment*
 *   and scored; the decoded text is never treated as an instruction.
 * - It does not flag ordinary mentions of `system`, `prompt` or `删除`. Those are
 *   normal words in a discussion about software, and a false positive here
 *   wastes the owner's attention on a review that says nothing.
 */
/** How much invisible or deceptive formatting the input contains. */
export interface FormattingAnomaly {
    /** Zero-width and other invisible characters, as (codepoint, count) pairs. */
    readonly invisible: readonly {
        readonly cp: number;
        readonly name: string;
        readonly count: number;
    }[];
    /** Count of characters that are not what they appear to be (mixed scripts). */
    readonly mixedScripts: readonly string[];
    /** True when the text uses bidirectional overrides, a classic spoofing tool. */
    readonly bidiOverride: boolean;
    /** Control characters that should never appear in a post. */
    readonly controlChars: number;
    /** HTML entities such as `&lt;script&gt;` that would render as markup. */
    readonly htmlEntities: number;
}
/** The two views of one input. */
export interface ScanView {
    /** Exactly what the platform returned. Use this for quotes and evidence. */
    readonly raw: string;
    /** NFKC-normalised, invisibles stripped, lowercased for matching. Detection only. */
    readonly scan: string;
    readonly anomalies: FormattingAnomaly;
    /** True when `raw` was too long to scan in full; `scan` holds a prefix. */
    readonly truncated: boolean;
}
/** Maximum characters inspected. Beyond this the tail is not analysed. */
export declare const MAX_SCAN_CHARS = 20000;
/**
 * Build the two views.
 *
 * NFKC is the right choice because it folds the full-width and compatibility
 * forms an attacker uses, while leaving ordinary Chinese, Latin and punctuation
 * intact. NFD/NFC variants would not fold `ｉｇｎｏｒｅ` into `ignore`.
 */
export declare function scanView(raw: string): ScanView;
/** True when the formatting itself is suspicious enough to mention. */
export declare function hasFormattingAnomaly(anomalies: FormattingAnomaly): boolean;
/** One-line description of the anomalies, for a security event. */
export declare function describeAnomalies(anomalies: FormattingAnomaly): string;
/**
 * Candidate decodings of a suspicious fragment, for *analysis* only.
 *
 * Returns the decoded strings so a detector can look for instruction-shaped text
 * inside them. **Never** treat a successful decode as permission to act on its
 * contents; a base64 blob that decodes to "delete all sessions" is still just a
 * comment that said something odd.
 */
export declare function decodeCandidates(text: string): readonly {
    readonly encoding: string;
    readonly decoded: string;
}[];
//# sourceMappingURL=text-normalize.d.ts.map