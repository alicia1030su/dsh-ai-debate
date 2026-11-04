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

import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'

/** How the directory was chosen. Reported to the settings page so it is auditable. */
export type StoreDirSource =
  | 'configured' // explicit storeDir in config
  | 'host' // a directory service the host exposed
  | 'dsh_home' // DSH_HOME environment variable
  | 'default' // ~/.dsh/ai-debate

export interface ResolvedStoreDir {
  readonly dir: string
  readonly source: StoreDirSource
  /**
   * Set when the resolution is *known* to differ from the historical default, so the
   * page can say "this is not the old location" instead of leaving the owner to
   * discover it.
   */
  readonly differsFromDefault: boolean
}

/**
 * Ask the host for a per-profile data directory, if it has one.
 *
 * Returns `undefined` unless the host answers with a plausible absolute path. No
 * default is invented here: an unknown host must fall through to the next rule, not
 * to a guess.
 */
export function hostDataDir(get: ((name: string) => unknown) | undefined): string | undefined {
  if (typeof get !== 'function') return undefined
  for (const name of ['profilePaths', 'paths', 'storage']) {
    let service: unknown
    try {
      service = get(name)
    } catch {
      continue
    }
    if (service === undefined || service === null || typeof service !== 'object') continue
    const candidate = (service as { dataDir?: unknown }).dataDir
    if (typeof candidate === 'string' && candidate !== '' && isAbsolute(candidate)) return candidate
  }
  return undefined
}

/** Read `DSH_HOME`, accepting only a value that can actually be used as a path. */
export function dshHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_HOME
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  // An empty or relative DSH_HOME is not a location. Treating it as one would put
  // state in whatever the current working directory happened to be.
  if (trimmed === '' || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

/** The historical location, kept so v0.2.22-and-earlier installs keep working. */
export function legacyStoreDir(home: string = homedir()): string {
  return join(home, '.dsh', 'ai-debate')
}

/**
 * Choose the state directory, without creating it.
 *
 * Split from creation so the choice can be unit-tested and reported on a machine
 * where creating the directory would be a side effect.
 */
export function chooseStoreDir(options: {
  readonly configured?: string | undefined
  readonly get?: ((name: string) => unknown) | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly home?: string | undefined
}): ResolvedStoreDir {
  const home = options.home ?? homedir()
  const legacy = legacyStoreDir(home)

  const configured = options.configured
  if (typeof configured === 'string' && configured.trim() !== '') {
    // Always honoured, even if relative: the owner typed it, and silently rewriting
    // it would make the settings page disagree with reality.
    const dir = resolve(configured.trim())
    return { dir, source: 'configured', differsFromDefault: dir !== legacy }
  }

  const host = hostDataDir(options.get)
  if (host !== undefined) {
    return { dir: resolve(host), source: 'host', differsFromDefault: resolve(host) !== legacy }
  }

  const dshHome = dshHomeDir(options.env)
  if (dshHome !== undefined) {
    // A per-instance directory *inside* DSH_HOME, so two instances never share a
    // ledger, and a profile can be deleted as a unit.
    const dir = join(dshHome, 'plugin-data', 'ai-debate')
    return { dir, source: 'dsh_home', differsFromDefault: dir !== legacy }
  }

  return { dir: legacy, source: 'default', differsFromDefault: false }
}

/** What is already on disk, for the "two candidates both have state" refusal. */
export interface StoreDirProbe {
  readonly dir: string
  readonly stateExists: boolean
  readonly stateBytes: number
}

function probeState(dir: string): { exists: boolean; bytes: number } {
  const file = join(dir, 'state.json')
  try {
    const stat = statSync(file)
    return { exists: stat.isFile(), bytes: stat.size }
  } catch {
    return { exists: false, bytes: 0 }
  }
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
export function resolveStoreDirStrict(options: {
  readonly configured?: string | undefined
  readonly get?: ((name: string) => unknown) | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly home?: string | undefined
}): ResolvedStoreDir & { readonly probe: StoreDirProbe } {
  const chosen = chooseStoreDir(options)
  const legacy = legacyStoreDir(options.home ?? homedir())

  const chosenState = probeState(chosen.dir)
  const legacyState = chosen.dir === legacy ? chosenState : probeState(legacy)

  if (chosen.dir !== legacy && !chosenState.exists && legacyState.exists) {
    throw new Error(
      `状态目录已经切换到 ${chosen.dir}，但旧的 ${legacy} 里还有状态文件（${legacyState.bytes} 字节）。` +
        '插件不会自动迁移，也不会跨目录读取或合并两份台账——那会把两个不同环境的记录混在一起。' +
        `请二选一：把旧 state.json 手动移动到新目录，或在设置里显式填写 storeDir 指回 ${legacy}。`,
    )
  }

  mkdirSync(chosen.dir, { recursive: true })

  return {
    ...chosen,
    probe: { dir: chosen.dir, stateExists: chosenState.exists, stateBytes: chosenState.bytes },
  }
}

/**
 * Refuse to write over a state file that cannot be parsed.
 *
 * Called by the store before its first write. A damaged file is a reason to stop,
 * not a reason to start from empty: rebuilding silently would present an empty
 * ledger as "nothing was ever published", which reads as a clean slate rather than
 * as data loss.
 */
export function assertStateWritable(dir: string): void {
  const file = join(dir, 'state.json')
  if (!existsSync(file)) return
  // Reading and parsing is the store's job; this only refuses the obvious case of a
  // zero-length file, which no valid state can be.
  const probe = probeState(dir)
  if (probe.exists && probe.bytes === 0) {
    throw new Error(
      `状态文件 ${file} 是空的（0 字节），不是有效的状态。` +
        '插件不会自动重建它——那会把「台账丢了」显示成「从没发表过」。' +
        '请从备份恢复该文件，或确认后手动删除它再重试。',
    )
  }
}
