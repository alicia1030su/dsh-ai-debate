/**
 * Where the plugin keeps its state.
 *
 * ## The bug this file exists to fix
 *
 * v0.2.23 resolved the state directory as:
 *
 * ```ts
 * config.storeDir || join(homedir(), '.dsh', 'ai-debate')
 * ```
 *
 * `homedir()` is the *operating system* home, so a DSH instance started with an
 * isolated `DSH_HOME` still wrote its state into the real user's `~/.dsh/ai-debate`.
 * That was found during the v0.2.23 acceptance run, where the settings page reported
 * the production path while the whole point of the run was to stay out of it. It was
 * worked around at the time with an explicit `--patch` override, which is a fix for
 * one acceptance run and not for users.
 *
 * ## Resolution order
 *
 * 1. **`storeDir` from config.** The owner said where. Highest priority, always wins.
 * 2. **The DSH host's own data directory**, when the host actually exposes one.
 *    This is checked *dynamically* — see {@link hostDataDir}. If no such service
 *    exists, this step is skipped rather than guessed.
 * 3. **`DSH_HOME`**, when it is set to a usable absolute path.
 * 4. **`~/.dsh/ai-debate`**, the historical default, for users who set none of the
 *    above. This is the only reason old installs keep working.
 *
 * Step 2 exists because step 3 is a convention rather than a contract: the host may
 * later grow a real per-profile directory service, and the plugin should prefer it.
 * It is written as a probe precisely because pretending to know an API that does not
 * exist would be worse than not using one — the failure mode would be a silently
 * wrong directory, which is the bug being fixed.
 */
/** How the directory was chosen. Reported to the settings page so it is auditable. */
export type StoreDirSource = 'configured' | 'host' | 'dsh_home' | 'default';
export interface ResolvedStoreDir {
    readonly dir: string;
    readonly source: StoreDirSource;
    /**
     * Set when the resolution is *known* to differ from the historical default, so the
     * page can say "this is not the old location" instead of leaving the owner to
     * discover it.
     */
    readonly differsFromDefault: boolean;
}
/**
 * Ask the host for a per-profile data directory, if it has one.
 *
 * Returns `undefined` unless the host answers with a plausible absolute path. No
 * default is invented here: an unknown host must fall through to the next rule, not
 * to a guess.
 */
export declare function hostDataDir(get: ((name: string) => unknown) | undefined): string | undefined;
/** Read `DSH_HOME`, accepting only a value that can actually be used as a path. */
export declare function dshHomeDir(env?: NodeJS.ProcessEnv): string | undefined;
/** The historical location, kept so v0.2.22-and-earlier installs keep working. */
export declare function legacyStoreDir(home?: string): string;
/**
 * Choose the state directory, without creating it.
 *
 * Split from creation so the choice can be unit-tested and reported on a machine
 * where creating the directory would be a side effect.
 */
export declare function chooseStoreDir(options: {
    readonly configured?: string | undefined;
    readonly get?: ((name: string) => unknown) | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
}): ResolvedStoreDir;
/** What is already on disk, for the "two candidates both have state" refusal. */
export interface StoreDirProbe {
    readonly dir: string;
    readonly stateExists: boolean;
    readonly stateBytes: number;
}
/**
 * Resolve and create the store directory, refusing the ambiguous case.
 *
 * ## The two-are-populated rule
 *
 * If the chosen directory has no state but the *legacy* one does, that is not a
 * reason to read the legacy one: the owner asked for isolation, and reading across
 * into `~/.dsh` would defeat it — and could silently merge two different ledgers.
 * The refusal is surfaced instead, so the owner can move or point at the file
 * deliberately. Nothing is copied, migrated or deleted.
 */
export declare function resolveStoreDirStrict(options: {
    readonly configured?: string | undefined;
    readonly get?: ((name: string) => unknown) | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
}): ResolvedStoreDir & {
    readonly probe: StoreDirProbe;
};
/**
 * Refuse to write over a state file that cannot be parsed.
 *
 * Called by the store before its first write. A damaged file is a reason to stop,
 * not a reason to start from empty: rebuilding silently would present an empty
 * ledger as "nothing was ever published", which reads as a clean slate rather than
 * as data loss.
 */
export declare function assertStateWritable(dir: string): void;
//# sourceMappingURL=store-dir.d.ts.map