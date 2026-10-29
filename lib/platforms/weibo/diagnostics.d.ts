/**
 * Diagnostics for the Weibo platform (v0.2.12 §二).
 *
 * ## Why this is not folded into `healthCheck()`
 *
 * The general health report answers "is the plugin configured". A Weibo diagnostic has to
 * answer a different question: **how far along the authorisation chain did we get** — and
 * those are not the same failure. "The CLI is not installed", "the CLI is installed but you
 * never logged in", "you logged in but the service is not activated" and "the service is
 * active but this account lacks the command" each need a different action from the owner.
 *
 * The task book is explicit that `unverified` must not be used to hide a missing
 * implementation. So each field here is derived from a probe that actually ran, and the state
 * distinguishes *not implemented* from *not available right now*.
 *
 * ## What this can and cannot see
 *
 * It can see: whether the binary exists, its version, whether `doctor` passes, which commands
 * the catalog lists, and whether each candidate's required parameters are fillable.
 *
 * It cannot see: the remaining credit balance. The official manual exposes that through
 * `me`/`credit ledger`, and this plugin deliberately does not call a billing command on the
 * owner's behalf — reading a balance spends nothing but the command is not part of the read
 * path, and calling it would be doing account management the task book says not to automate.
 * The field is therefore reported as `unsupported` with that reason, not omitted silently.
 */
import type { WeiboCliStatus } from './cli.js';
/**
 * The distinct diagnoses.
 *
 * `not_implemented` is separate from every runtime failure because it is the one state the
 * owner cannot fix by installing or authorising anything — and the task book requires it to
 * be visible rather than hidden behind `unverified`.
 */
export type WeiboDiagnosisState = 
/** The adapter has no read path at all for this feature. */
'not_implemented'
/** `weibo-cli` is not on PATH. */
 | 'cli_missing'
/** Installed, but no OAuth login is bound to this machine. */
 | 'not_authorised'
/** Logged in, but developer qualification or service activation is missing. */
 | 'service_inactive'
/** Authorised and active, but this account's catalog lacks the command. */
 | 'permission_insufficient'
/** The command exists and runs, but the quota or rate limit is exhausted. */
 | 'quota_exhausted'
/** A read actually completed. */
 | 'read_ok'
/** Something else went wrong; `message` carries the detail. */
 | 'failed';
/** One line of the diagnostic. */
export interface WeiboDiagnosticLine {
    readonly state: WeiboDiagnosisState;
    /** What to show the owner, already safe to display. */
    readonly message: string;
    /** What the owner can do about it, when there is something. */
    readonly steps: readonly string[];
}
/** The full Weibo diagnostic block. */
export interface WeiboDiagnostics {
    /** Whether `weibo-cli` was found. */
    readonly cliInstalled: boolean;
    /** The CLI's own version string, when it answered. */
    readonly cliVersion?: string;
    /** Whether an OAuth login is bound. */
    readonly oauthLoggedIn: boolean;
    /** Whether the developer qualification and service are usable. */
    readonly serviceActive: boolean;
    /** The catalog entry that would drive `getThread`, when one validated. */
    readonly threadCommand?: string;
    /** The catalog entry that would drive `getReplies`, when one validated. */
    readonly commentCommand?: string;
    /** Credit or plan information — only when an official command exposes it. */
    readonly quota: WeiboDiagnosticLine;
    /** The most recent real read, when one happened this process. */
    readonly lastRead?: {
        readonly ok: boolean;
        readonly at: string;
        /** How far it got: `thread` or `comments`. */
        readonly stage: string;
        readonly message: string;
    };
    /** The most recent error, whichever stage produced it. */
    readonly lastError?: {
        readonly at: string;
        readonly state: WeiboDiagnosisState;
        readonly message: string;
    };
    /** One line per aspect, for direct rendering. */
    readonly lines: readonly WeiboDiagnosticLine[];
}
/** Mutable diagnostics recorder, kept per adapter instance. */
export interface WeiboDiagnosticRecorder {
    readonly recordRead: (ok: boolean, stage: string, message: string) => void;
    readonly recordError: (state: WeiboDiagnosisState, message: string) => void;
    readonly snapshot: () => Pick<WeiboDiagnostics, 'lastRead' | 'lastError'>;
}
/**
 * Create a recorder.
 *
 * Kept as a small object rather than module state so two adapters (a test one and a real one)
 * cannot overwrite each other's history.
 */
export declare function createDiagnosticRecorder(): WeiboDiagnosticRecorder;
/**
 * Map a CLI status to a diagnosis state.
 *
 * The CLI layer already distinguishes six statuses; this is the mapping into the vocabulary
 * the settings page speaks. Keeping it a pure function means the mapping is testable without
 * spawning anything.
 */
export declare function diagnosisOfStatus(status: WeiboCliStatus): WeiboDiagnosisState;
/** Assemble the display lines from the probe facts. */
export declare function buildDiagnosticLines(input: {
    readonly cliInstalled: boolean;
    readonly cliVersion?: string;
    readonly oauthLoggedIn: boolean;
    readonly serviceActive: boolean;
    readonly threadCommand?: string;
    readonly commentCommand?: string;
    readonly threadProblem?: string;
    readonly commentProblem?: string;
    readonly readinessState: WeiboDiagnosisState;
    readonly readinessMessage: string;
    readonly readinessSteps: readonly string[];
    readonly lastRead?: WeiboDiagnostics['lastRead'];
    readonly lastError?: WeiboDiagnostics['lastError'];
}): WeiboDiagnosticLine[];
//# sourceMappingURL=diagnostics.d.ts.map