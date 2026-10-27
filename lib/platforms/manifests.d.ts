/**
 * Future platform manifests.
 *
 * A manifest is **not** an adapter. It is the honest, written-down description of
 * what a platform could support, what would be needed to support it, and where
 * the current state of the research is. v0.2.0 ships manifests only — no Weibo,
 * Zhihu, Xiaohongshu or Douyin code, and therefore no claim in the settings page
 * or the README that any of them works.
 *
 * Two rules this file follows, because breaking either is how a project starts
 * lying about platform support:
 *
 * 1. **No invented API.** Every row below says `unavailable` or
 *    `permission_required`, never `supported`. There is no `getComments()`
 *    sketch, no guessed endpoint and no placeholder response shape.
 * 2. **No guessed capability.** "The platform has comments, therefore we can read
 *    them" is a claim about permissions and quotas, not about the existence of a
 *    comments section. The `requiredPermissions` fields name what would have to
 *    be granted before any code is worth writing.
 *
 * The manifests are deliberately data, not code: the settings page renders them,
 * the tests check them, and turning one into a real adapter means adding a
 * `provider.ts` next to it — never editing the agent core.
 */
import type { PlatformCapabilityMatrix } from './contracts.js';
/** Where the current research into one platform stands. */
export type ResearchStage = 
/** Only collecting public information; no API access attempted. */
'survey'
/** Official documentation read; no developer account yet. */
 | 'documented'
/** A developer account exists but the needed scopes are not granted. */
 | 'credentialed'
/** Read path works against the live platform. */
 | 'read-verified'
/** Write path works against the live platform. */
 | 'write-verified';
/** One future platform. */
export interface PlatformManifest {
    readonly id: string;
    readonly displayName: string;
    /** What the platform is shaped like, in the conversation-graph sense. */
    readonly shape: 'microblog' | 'qa' | 'note' | 'video';
    /** Example URL shapes, for the "will this link work?" question. */
    readonly urlShapes: readonly string[];
    /**
     * How the conversation maps onto the platform.
     *
     * Written as prose rather than as code on purpose: this is the design note a
     * future implementer reads before writing an adapter.
     */
    readonly conversationShape: string;
    /** The auth model the platform actually uses. */
    readonly authModel: string;
    readonly research: ResearchStage;
    /** The same matrix shape the registry uses, so the page can render both alike. */
    readonly capabilities: PlatformCapabilityMatrix;
    /** What would have to happen before an adapter is written. */
    readonly prerequisites: readonly string[];
    /** Known hard constraints, phrased for a human. */
    readonly constraints: readonly string[];
}
/**
 * Weibo.
 *
 * The trajectory here is the clearest of the four: an official open platform with
 * OAuth, but with developer qualification, quota and an AI-content labelling
 * requirement that all have to be satisfied before a single reply may be posted.
 */
export declare const weiboManifest: PlatformManifest;
/**
 * Zhihu.
 *
 * The read path is the plausible one: questions, answers and articles are public.
 * Comment creation is the part that is not obviously available to a third party,
 * so a candidate that the owner copies out by hand is the honest fallback — never
 * a fake "published" result.
 */
export declare const zhihuManifest: PlatformManifest;
/**
 * Xiaohongshu.
 *
 * Manifest only. The comment API situation is not clearly documented for third
 * parties, and inventing one would be worse than shipping nothing.
 */
export declare const xiaohongshuManifest: PlatformManifest;
/** Douyin. Manifest only, same reasoning as Xiaohongshu. */
export declare const douyinManifest: PlatformManifest;
/** Every future platform, in display order. */
export declare const PLATFORM_MANIFESTS: readonly PlatformManifest[];
/** Look one manifest up by id. */
export declare function manifestOf(id: string): PlatformManifest | undefined;
//# sourceMappingURL=manifests.d.ts.map