/**
 * Build a `DebateBrief` from what was actually collected.
 *
 * ## Why this file had to be written in v0.2.12
 *
 * `brief.ts` had a type, a validator and a renderer — and **no builder**. So the brief could
 * be validated and rendered in tests while the production generation path went on using
 * `compressContext()` alone. That is the gap the task book calls out: `validateBrief()` was
 * "只存在于测试文件".
 *
 * This module closes it by deriving the brief from `Dispute` — the reconstruction the
 * analyzer already produces from real collected data. Every field it fills cites post ids,
 * and every field it cannot support is left as an explicit uncertainty rather than a guess.
 *
 * ## The three rules it follows
 *
 * 1. **Evidence or nothing.** A position, an argument or an agreed fact is only emitted with
 *    the post ids that support it. `validateBrief` then re-checks that those ids exist and
 *    belong to the side being described.
 * 2. **The reply target is not a model choice.** `targetPostId` comes from the opponent's
 *    verified last post, exactly as the publish path already requires. A builder that let a
 *    later stage change it would hand the model the one decision the design keeps away from
 *    it.
 * 3. **Uncertainty is stated, not smoothed over.** Missing nested replies, an inferred
 *    reply edge, a name-only opponent — each becomes an entry in `uncertainties`, because a
 *    reply written on top of a silent assumption is the failure mode this project keeps
 *    having to remove.
 */
import type { Dispute, Participant } from './analyzer.js';
import { type ConflictVerdict } from './conflict.js';
import type { BriefSources, DebateBrief } from './brief.js';
import type { CollectedThread } from './collector.js';
import type { PlatformId } from './types.js';
/** Everything the builder is allowed to look at. */
export interface BuildBriefInput {
    readonly platform: PlatformId;
    readonly threadId: string;
    readonly collected: CollectedThread;
    readonly dispute: Dispute;
}
/**
 * Build the brief.
 *
 * Returns the brief plus the `BriefSources` that `validateBrief` needs, so a caller cannot
 * accidentally validate against a different set of posts than the brief was built from.
 */
export declare function buildBrief(input: BuildBriefInput): {
    readonly brief: DebateBrief;
    readonly sources: BriefSources;
    /**
     * The verdict the brief's disagreements were derived from (v0.2.14 §6.4).
     *
     * Returned rather than recomputed downstream: the publisher needs to know whether the
     * analysis was *settled* (it could name a proven relation), and re-running the judge on text
     * assembled elsewhere would answer a slightly different question than the brief did.
     */
    readonly verdict: ConflictVerdict;
};
/**
 * Everything the brief is allowed to cite.
 *
 * Built from the collected thread rather than from the brief, so validation can catch a
 * citation the builder invented — if both came from the same narrowing, the check would be
 * circular.
 */
export declare function buildSources(input: BuildBriefInput): BriefSources;
/**
 * Render a brief for a small context window.
 *
 * ## What is kept when space runs out
 *
 * The task book allows compressing the brief but requires the **evidence relationships** to
 * survive: who said which post id. So this drops prose before it drops ids — a shorter
 * summary with the same citations is still checkable, while a citation-free paragraph is
 * not.
 */
export declare function renderBriefCompact(brief: DebateBrief, maxChars: number): string;
/** Whether a dispute produced enough material for a brief worth validating. */
export declare function briefIsViable(dispute: Dispute): boolean;
/** Exposed for tests that need the same participant shape. */
export type { Participant };
//# sourceMappingURL=brief-builder.d.ts.map