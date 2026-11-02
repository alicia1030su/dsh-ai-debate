/**
 * Durable state for sessions, deduplication and usage accounting.
 *
 * Requirements this file has to satisfy at once:
 *
 * - **Survives a restart without double-posting.** The dedupe record is
 *   written *before* a publish is attempted and updated after, so a crash in
 *   between leaves a record saying "this may have been sent", which blocks an
 *   automatic retry and asks a human to check.
 * - **Survives a torn write.** Every save goes through a temp file and a
 *   rename, so a crash mid-write leaves the previous file intact instead of a
 *   truncated one.
 * - **Never contains credentials.** Only ids, text, states and counters live
 *   here; cookies stay in memory and in the profile's own secret store.
 *
 * Storage is a plain JSON file because the data is small and per-profile. A
 * database would add an install dependency for no benefit at this size.
 */

import { mkdir, link, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import type { TargetSnapshot } from './types.js'
import type { CapabilityName } from './platforms/contracts.js'
import type { ApprovalRecord } from './security/approvals.js'
import { pruneApprovals } from './security/approvals.js'

/**
 * A store failure the caller is expected to act on.
 *
 * These used to be swallowed so the plugin would keep running. That is exactly
 * the wrong trade for this project: a persisted dedupe record is the only thing
 * standing between "the process died mid-publish" and "the bot posts the same
 * reply twice", so a write that did not happen must stop the pipeline rather
 * than be forgotten.
 */
export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreError'
    this.code = code
  }
}

/** The three ways a store operation can fail, each with its own remedy. */
export type StoreErrorCode = 'read_failed' | 'corrupt' | 'write_failed'

/** Every state a task can be in. */
export type TaskState =
  | 'DETECTED'
  | 'AUTHORIZED'
  | 'COLLECTING'
  | 'ANALYZING'
  | 'GENERATING'
  | 'REVIEWING'
  | 'READY'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'PAUSED'
  | 'CANCELLED'
  | 'NEEDS_CONFIRMATION'

/** States from which no further automatic progress happens. */
export const TERMINAL_STATES: readonly TaskState[] = ['PUBLISHED', 'FAILED', 'CANCELLED']

/**
 * A stored reply candidate.
 *
 * Each candidate carries its own target snapshot and version. Putting the
 * snapshot on the session instead would let a candidate generated against an old
 * target be published after the target moved — the check would compare the
 * session's snapshot against itself and always pass.
 */
export interface StoredCandidate {
  readonly replyId: string
  readonly text: string
  readonly strategy: string
  readonly targetPostId: string
  /**
   * The verified target this text was written against.
   *
   * Absent means the candidate predates snapshotting, or generation could not
   * confirm the target. Either way it must not be published: without a snapshot
   * there is nothing to compare a fresh read against.
   */
  readonly targetSnapshot?: TargetSnapshot
  /**
   * Monotonic counter per session, bumped on every generation.
   *
   * A human approval binds to one candidate id plus this version, so regenerating
   * invalidates any earlier approval even if the text happens to match.
   */
  readonly candidateVersion: number
  /** Hash of `text`, so an approval can prove it approved this exact prose. */
  readonly textHash: string
  readonly confidence: number
  readonly violations: readonly string[]
  readonly notes: readonly string[]
  /**
   * The security assessment this text was generated under.
   *
   * v0.2.3: a candidate with no assessment cannot be published. The field is
   * optional only because candidates persisted before this version have none —
   * and the publish gate refuses exactly those, which is the point: an approval
   * that predates the gate must not be treated as having passed it.
   */
  readonly security?: CandidateSecurityRecord
  readonly createdAt: string
  /** True once a human approved this exact text at this exact version. */
  readonly approved: boolean
  /** Set after publishing, when the platform confirmed it. */
  readonly publishedPostId?: string
}

/**
 * The persisted form of a candidate's security assessment.
 *
 * A structural copy of `CandidateSecurityAssessment` from `security/security-policy.ts`,
 * declared here so `store.ts` keeps knowing nothing about the security module —
 * persistence is a data concern, and a store that imports policy logic would make
 * the two impossible to version apart.
 */
export interface CandidateSecurityRecord {
  readonly injectionDetected: boolean
  readonly ownerIdentityValid: boolean
  readonly targetIdentityValid: boolean
  readonly stanceConsistency: 'consistent' | 'uncertain' | 'contradictory'
  readonly ownerDirectedAttack: boolean
  readonly unauthorizedInstructionFollowed: boolean
  readonly secretLeakRisk: boolean
  readonly evidenceIntegrityValid: boolean
  readonly decision: 'allow' | 'review' | 'block'
  readonly reasons: readonly string[]
  /**
   * Whether the *debate analysis* behind this text was settled (v0.2.14 §6.4).
   *
   * ## Why this lives on the candidate rather than the session
   *
   * The other fields here are text-safety facts: "does this prose leak a secret", "does it attack
   * the owner". This one is about comprehension: "did we establish that these two people are
   * actually arguing about the same thing?"
   *
   * It belongs on the candidate because it is a property of *this* text: after the owner clarifies
   * the dispute, a regenerated candidate can be settled while the old one stays unsettled.
   * Putting it on the session would make one clarification retroactively bless every earlier
   * draft.
   *
   * Optional only because candidates persisted before v0.2.14 have none. The publish policy reads
   * `undefined` as unsettled, so an old candidate keeps needing a human — the correct reading of
   * "we never checked".
   */
  readonly semanticSettled?: boolean
  /**
   * Fingerprint binding this decision to one exact text and target.
   *
   * The publisher recomputes it before sending. Without it, "approved" would be
   * attached to a session rather than to a piece of prose, and editing the text
   * after approval would inherit the old approval.
   */
  readonly fingerprint: string
}

/** One discussion session, scoped to a single thread + owner + opponent. */export interface StoredSession {
  readonly id: string
  readonly platform: string
  readonly threadId: string
  readonly threadUrl: string
  readonly threadTitle: string
  readonly forumName: string
  readonly ownerKey: string
  readonly ownerName?: string
  readonly opponentKey?: string
  readonly opponentName?: string
  /** Post id or floor post id where the argument started. */
  readonly disputeFloorPostId: string
  readonly disputeFloorNumber: number
  /** The post that summoned the AI. */
  readonly triggerPostId: string
  /**
   * Whether the reply must land on a floor or inside one.
   *
   * Stored rather than inferred at publish time: inferring it from which id
   * happens to be set is how a nested reply was sent to the floor instead.
   */
  readonly targetKind?: 'floor' | 'nested'
  /**
   * Stable opponent user id when the platform exposes one.
   *
   * Kept apart from `opponentKey`, which may be a display name; the publisher
   * uses this for the author check and the @ prefix.
   */
  readonly opponentUserId?: string
  /**
   * The verified target the *most recent* generation was written against.
   *
   * Kept for display only; the authoritative snapshot lives on each candidate.
   * Publishing never reads this field, precisely so an old candidate cannot ride
   * on a newer snapshot.
   */
  readonly targetSnapshot?: TargetSnapshot
  readonly state: TaskState
  /** Short human-readable status line. */
  readonly statusText: string
  readonly persona: { style: string; intensity: number; maxLength: number }
  readonly dialogueSummary?: string
  readonly candidates: readonly StoredCandidate[]
  /** Post ids the AI has already published in this session. */
  readonly publishedPostIds: readonly string[]
  /** Reply texts already sent, for repetition checks. */
  readonly sentTexts: readonly string[]
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** A deduplication record for one trigger event. */
/**
 * The permanent publish record for one summoning trigger.
 *
 * This row, not the session, is the durable truth about whether a reply was sent.
 * Sessions are a working cache and are pruned on a TTL; this ledger is not, because
 * forgetting a publish is how the plugin posts the same reply twice.
 */
export interface DedupeRecord {
  readonly key: string
  readonly platform: string
  readonly threadId: string
  /**
   * The owner as the *ledger* identifies them: a stable handle when one is known,
   * never a display name when an id exists.
   *
   * Older records (and the current writers, for name-only owners) still carry a
   * nickname here. That is why the key no longer depends on this field: a display
   * name can be changed at will, and an idempotency key built from it changes with
   * it. See {@link canonicalTriggerId}.
   */
  readonly ownerKey: string
  readonly triggerPostId: string
  readonly eventId?: string
  readonly sessionId: string
  readonly firstSeenAt: string
  /** `pending` means a publish was started; its outcome is unknown. */
  readonly publishState?: 'pending' | 'confirmed' | 'failed'
  readonly publishedPostId?: string
  /**
   * When the publish reached its final state.
   *
   * Kept on the ledger so the per-thread cooldown still works after the session that
   * carried it has been pruned. `firstSeenAt` cannot serve: it records when the
   * trigger was first analysed, which may be days before the reply went out.
   */
  readonly decidedAt?: string
  /**
   * Owner identity as written by pre-0.1.5 versions: the display name.
   *
   * Kept only so a migrated row can explain where it came from. New writes never
   * populate it and nothing reads it for a decision.
   */
  readonly legacyOwnerKey?: string
}

/** One LLM call, for cost accounting. */
export interface UsageRecord {
  readonly at: string
  readonly sessionId?: string
  readonly purpose: 'analyze' | 'generate' | 'repair'
  readonly model?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly elapsedMs: number
  readonly error?: string
}

/** The whole persisted document. */
export interface StoreData {
  readonly version: 1
  readonly sessions: readonly StoredSession[]
  readonly dedupe: readonly DedupeRecord[]
  readonly usage: readonly UsageRecord[]
  /**
   * Recent security events, newest last.
   *
   * Optional because a store written by an earlier version has none, and because
   * an empty list and an absent field mean the same thing here ("nothing recorded
   * yet"). The events themselves never carry attacker text beyond a redacted
   * excerpt — see `security/security-events.ts`, which owns that rule.
   */
  readonly security?: readonly SecurityEventRecord[]
  /**
   * Human approvals, oldest first.
   *
   * This is the record that makes "the owner approved" checkable, replacing the
   * v0.2.4 arrangement where a boolean in the model's tool arguments *was* the
   * approval. See `security/approvals.ts` for the binding rules and for why the id
   * is not handed to the model.
   *
   * Optional for the same reason `security` is: a store written by an earlier
   * version has no approval list, and "no records" and "absent field" mean the same
   * thing — nothing has been approved.
   */
  readonly approvals?: readonly ApprovalRecord[]
  /**
   * One-off publish verification records, oldest first (v0.2.21 §三).
   *
   * This is the durable half of the verification flow. It is written **before** the network
   * call (`outcome: 'pending'`) and again after, so a crash mid-publish leaves "attempted,
   * outcome unknown" rather than silence. The second write upserts by `key`, which is what makes
   * "one authorization, one publish" true across process restarts instead of only in memory.
   *
   * Optional for the same reason `security` and `approvals` are: a store written by an earlier
   * version has no such list, and "no records" means "nothing has been verified yet".
   */
  readonly verification?: readonly VerificationRecordRow[]
}

/**
 * The persisted form of a security event.
 *
 * Structurally identical to `SecurityEvent` in `security/security-events.ts`,
 * declared separately so persistence keeps knowing nothing about the security
 * module.
 */
export interface SecurityEventRecord {
  readonly id: string
  readonly at: string
  readonly kind: string
  readonly severity: string
  readonly summary: string
  readonly platform?: string
  readonly threadId?: string
  readonly postId?: string
  readonly decision?: string
  readonly excerpt?: string
}

/**
 * The persisted form of one publish-verification attempt.
 *
 * Structurally identical to `VerificationRecord` in `verification.ts`, declared separately so
 * persistence keeps knowing nothing about that module's types — the same arrangement
 * `SecurityEventRecord` uses.
 */
export interface VerificationRecordRow {
  readonly key: string
  readonly platform: string
  readonly capability: CapabilityName
  readonly authorizedAccountId: string
  readonly authorizedThreadId: string
  readonly authorizedBy: string
  readonly approvedText: string
  readonly startedAt: string
  /**
   * The adapter build this attempt ran against (v0.2.21 §三.9).
   *
   * Absent on records written before the field existed, and absent is treated as "unknown build",
   * which never promotes a capability.
   */
  readonly adapterVersion?: string
  readonly outcome: 'pending' | 'succeeded' | 'failed' | 'uncertain'
  readonly publishedPostId?: string
  readonly readBack?: {
    readonly postFound: boolean
    readonly authorMatched: boolean
    readonly textMatched: boolean
    readonly parentMatched: boolean
    readonly notes: readonly string[]
  }
  readonly failure?: string
}

/** Empty store. */
export function emptyStore(): StoreData {
  return { version: 1, sessions: [], dedupe: [], usage: [], security: [], approvals: [], verification: [] }
}

/** Options for the store. */
export interface StoreOptions {
  /** Directory the store lives in. */
  readonly dir: string
  /** Sessions older than this are pruned on save. Defaults to 7 days. */
  readonly sessionTtlMs?: number
  /** Usage rows kept. Defaults to 500. */
  readonly maxUsageRows?: number
  /**
   * Max **finished** sessions kept. Defaults to 200.
   *
   * This bounds history, not live work. Sessions the user or the plugin may still
   * act on (`READY`, `GENERATING`, `PUBLISHING`, `REVIEWING`, `NEEDS_CONFIRMATION`,
   * …) are never dropped to satisfy this cap — with `maxSessions: 1`, an earlier
   * version silently deleted a second `READY` draft the moment another was saved.
   *
   * When the number of live sessions reaches this cap, {@link activeSessionCapacity}
   * reports it and the runtime refuses to start new work rather than sacrificing a
   * task in progress.
   */
  readonly maxSessions?: number
  /**
   * Max dedupe rows. Defaults to 2000.
   *
   * Reached only after thousands of distinct trigger events. This is a soft ceiling:
   * `confirmed` and `pending` rows are never deleted to meet it, because forgetting a
   * publish is how the same summon gets answered twice. The health check reports the
   * count so a user sees the cap approaching instead of discovering it as a re-post.
   */
  readonly maxDedupeRows?: number
  /**
   * How long to wait for the cross-process write lock before giving up.
   *
   * Defaults to 5000 ms. A store whose lock cannot be taken in that window throws
   * rather than writing anyway: an unlocked write is how one instance erases
   * another's approval or publish record, and a visible failure is strictly better
   * than a silent lost update.
   */
  readonly lockTimeoutMs?: number
}

/** Default wait for the write lock. */
const DEFAULT_LOCK_TIMEOUT_MS = 5000

/**
 * What `acquireLock` hands back: a release function plus an ownership check.
 *
 * The check exists because "I acquired the lock" and "I still hold it" are different
 * statements across an `await` (v0.2.9). Every filesystem call in the critical section
 * is a suspension point, and during any of them another process can decide this lock
 * looks stale, move it aside, and take its place. Writing on the strength of the
 * original acquisition is what let two writers overlap; asking again immediately before
 * the write turns that into a refused write.
 */
interface LockHandle {
  /** Re-read the lock and confirm it still carries this acquisition's token. */
  verify(): Promise<boolean>
  /** Delete the lock, but only if it is still ours. */
  release(): Promise<void>
}

/**
 * Take an advisory cross-process lock for one store file.
 *
 * ## Why a lock file rather than an in-process mutex
 *
 * The lost-update bug is not only "two objects in one process". DSH runs a Host,
 * the agent's tool calls and the settings routes, and a second DSH process (or a
 * CLI run against the same profile) can point at the same `state.json`. An
 * in-process queue would serialize the first case and do nothing for the second.
 *
 * ## Why `wx` and not "check then create"
 *
 * `open(path, 'wx')` fails atomically when the file exists. A `exists()`-then-write
 * sequence has a window between the two calls in which both writers see "no lock"
 * and both proceed — which is the bug, not the fix.
 *
 * ## The reclamation window, and why "move it aside" was not a CAS (v0.2.9)
 *
 * v0.2.8 reclaimed a stale lock by renaming it to a graveyard path and then comparing
 * the moved bytes with the bytes it had judged stale. That reads like a compare-and-swap
 * and is not one: **the rename empties `lockPath`**, and an empty path under `wx` is an
 * invitation. The sequence that breaks it:
 *
 *   1. reclaimer R reads the lock and decides the holder is dead;
 *   2. R renames it away — the path is now free;
 *   3. writer N opens the free path with `wx` and starts writing;
 *   4. R compares the moved bytes, finds them stale, and reports "reclaimed";
 *   5. R's caller proceeds to write, believing it holds the lock.
 *
 * R and N are now both inside the critical section, and nothing in either noticed. The
 * bytes comparison in step 4 cannot help: it validates *what R moved*, not *whether R
 * ended up holding anything*. I reproduced this with a child process that polls the path
 * and takes it the moment it frees — `PEER-ACQUIRED` and a successful store write
 * happened in the same run.
 *
 * The two fixes here are complementary:
 *
 * - **Reclamation only counts if the reclaimer ends up owning the lock.** After moving
 *   the stale file aside, `acquireLock` loops back and does a normal `open('wx')`. If a
 *   peer got there first, this acquisition simply fails and retries — it never reports a
 *   reclaim it did not consolidate into ownership.
 * - **Ownership is re-checked immediately before the write** (`LockHandle.verify`).
 *   Between acquiring and writing there are `await`s (reading the document), and a peer
 *   may reclaim in that window by the same rules. A write that no longer holds the lock
 *   is refused rather than performed.
 *
 * A process that dies while holding the lock is still reclaimable, so a crash does not
 * wedge the store; what is no longer possible is *profiting* from a reclaim that lost
 * the race.
 *
 * ## Staleness, tokens, and why the pid alone is not enough (v0.2.8)
 *
 * A process that dies while holding the lock would otherwise wedge the store
 * forever, so a stale lock has to be breakable. v0.2.7 decided staleness from
 * `at` (a timestamp) and then, in the same expression, exempted `process.pid` from
 * the liveness check. The audit found the consequence: **a lock whose holder was
 * still alive but whose timestamp had aged past the threshold was collected**, and
 * the writer that owned it kept going as if it still held the lock.
 *
 * Worse, the lock body carried no holder identity, so `release()` could only
 * `unlink` — meaning a process that *believed* it held a lock could delete the lock
 * a different process had since created. Nothing detected that, because there was
 * nothing to compare.
 *
 * The protocol now is:
 *
 * 1. **A random token per acquisition**, written into the lock body. The token, not
 *    the pid, is the identity of "this lock is mine".
 * 2. **Liveness wins over age.** If the recorded holder is a live process, the lock
 *    is live no matter how old `at` is — a writer can legitimately run longer than
 *    any fixed threshold (slow disk, large document, a paused process that has not
 *    died). Age is only used when liveness cannot be established.
 * 3. **Reclaiming is not a claim.** Breaking a stale lock only *frees the path*; the
 *    breaker must then win a normal `open('wx')` like everyone else. It never reports
 *    success on the strength of the rename alone (v0.2.9 — see the window described
 *    above).
 * 4. **Ownership is re-checked before the write.** `verify()` re-reads the lock and
 *    compares the token, so a write whose lock was reclaimed during the read phase is
 *    refused instead of performed.
 * 5. **Release verifies ownership.** `release()` reads the lock, compares the token,
 *    and only unlinks on a match. If the token changed, the lock was broken and
 *    re-acquired by someone else, and this process must not touch it.
 *
 * @param file the state file being written; the lock lives beside it
 * @param timeoutMs how long to keep retrying
 * @returns a handle that can re-verify and then release the lock
 */
async function acquireLock(file: string, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): Promise<LockHandle> {
  const lockPath = `${file}.lock`
  const started = Date.now()
  let delay = 2

  for (;;) {
    // A fresh token per attempt: it identifies *this acquisition*, so a stale
    // acquisition's release cannot match a later one with the same pid.
    const token = randomUUID()
    const body = JSON.stringify({ pid: process.pid, at: Date.now(), token })
    try {
      // The directory may not exist yet on a first run, and `open(..., 'wx')` does
      // not create parents. Creating it here is also what makes the lock and the
      // state file share one directory, so a rename cannot cross filesystems.
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(body, 'utf8')
      } finally {
        await handle.close()
      }
      let released = false
      return {
        /**
         * Confirm the lock on disk is still the one this call created.
         *
         * Called immediately before persisting. A `false` answer means a peer reclaimed
         * this lock while the document was being read, so writing now would place two
         * writers in the critical section — the caller must abort instead.
         */
        async verify() {
          if (released) return false
          let current: string
          try {
            current = await readFile(lockPath, 'utf8')
          } catch {
            // Gone: reclaimed and not yet re-taken. Either way, not ours.
            return false
          }
          return tokenOf(current) === token
        },
        async release() {
          if (released) return
          released = true
          // Only delete the lock if it is still ours. A lock that was broken as stale
          // and re-acquired by a peer now carries a different token, and unlinking it
          // here would silently remove that peer's protection.
          let current: string
          try {
            current = await readFile(lockPath, 'utf8')
          } catch {
            // Already gone. Releasing a lock that no longer exists is success.
            return
          }
          const currentToken = tokenOf(current)
          if (currentToken !== token) return
          try {
            await unlink(lockPath)
          } catch {
            // Raced with another release or a break. Nothing to do.
          }
        },
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        // A directory we cannot write to, or a permissions problem. Surface it: a
        // write that silently proceeds without the lock is the bug being fixed.
        throw new StoreError('write_failed', `无法获取状态写入锁（${lockPath}）：${(error as Error).message}`, {
          cause: error,
        })
      }
      if (await breakStaleLock(lockPath)) {
        // The path is free *now*, but a peer may take it first. Loop back and compete
        // for it like anyone else: a reclaim that does not end in ownership is not a
        // reclaim. v0.2.8 treated this loop-back as confirmation and returned a lock it
        // did not hold.
        continue
      }
      if (Date.now() - started >= timeoutMs) {
        throw new StoreError(
          'write_failed',
          `状态写入锁被占用超过 ${timeoutMs}ms（${lockPath}）：另一个进程正在写入，` +
            '为避免丢失授权或发表记录，这次写入被拒绝。请稍后重试。',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 50)
    }
  }
}

/** How long a lock with an *unknowable* holder is allowed to sit before it is broken. */
const LOCK_STALE_MS = 30_000

/** The `token` field of a lock body, or `undefined` when absent/unparseable. */
function tokenOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { token?: unknown }
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : undefined
  } catch {
    return undefined
  }
}

/**
 * Remove a lock left behind by a writer that is demonstrably gone.
 *
 * ## Liveness beats age
 *
 * v0.2.7 gated the liveness check behind the age check, which meant an aged lock
 * belonging to a *live* process was collected and the owner never learned. Here the
 * order is inverted: a live holder always wins, and age is only consulted when
 * liveness cannot be established (no pid recorded, or the pid cannot be probed).
 *
 * A paused process (`SIGSTOP`, or a debugger break) counts as alive, because
 * `process.kill(pid, 0)` succeeds for it. That is deliberate: breaking a moved-along
 * lock while its owner is merely suspended is how two writers end up inside the same
 * critical section.
 *
 * ## Compare-and-swap, not "read then delete"
 *
 * The bytes that were judged stale are captured, and after the rename the moved file
 * is checked against them. If a peer broke and re-created the lock in the meantime,
 * the bytes differ and this call restores nothing but also deletes nothing of the
 * peer's — it simply reports "not broken" and the caller retries the whole loop.
 *
 * @returns true when this call actually broke the lock
 */
async function breakStaleLock(lockPath: string): Promise<boolean> {
  let observed: string
  try {
    observed = await readFile(lockPath, 'utf8')
  } catch {
    // Released between our failed create and this read. Report "broken" so the
    // caller retries the create immediately.
    return true
  }

  let parsed: { pid?: number; at?: number; token?: string } = {}
  try {
    parsed = JSON.parse(observed) as { pid?: number; at?: number; token?: string }
  } catch {
    // A half-written body is not a valid claim. Fall through to the age check below,
    // which will only break it once it is older than the threshold.
  }

  const owner = typeof parsed.pid === 'number' ? parsed.pid : undefined

  // 1. A live holder always wins, regardless of how old the timestamp is.
  if (owner !== undefined && isProcessAlive(owner)) return false

  // 2. No usable liveness signal: decide by age, using the recorded timestamp when
  //    there is one and the file's own mtime when there is not.
  if (owner === undefined || owner === null) {
    const at = typeof parsed.at === 'number' ? parsed.at : 0
    if (at !== 0) {
      if (Date.now() - at < LOCK_STALE_MS) return false
    } else {
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return false
      } catch {
        return true
      }
    }
  }
  // 3. The holder is a dead pid. Break it — but only if it is still the same lock.

  const graveyard = `${lockPath}.${process.pid}.${randomUUID()}.stale`
  try {
    await rename(lockPath, graveyard)
  } catch {
    // Someone else moved it first, or it is gone. Either way nothing of ours was
    // deleted; let the caller retry the acquire loop.
    return false
  }

  // The bytes we just moved must be the bytes we judged stale.
  let moved: string | undefined
  try {
    moved = await readFile(graveyard, 'utf8')
  } catch {
    moved = undefined
  }
  if (moved !== observed) {
    // A peer's fresh lock was renamed away by us — a race we must undo rather than
    // benefit from. Put it back only if the path is free; if it is not, the peer
    // will notice its own token is gone and re-acquire.
    try {
      await link(graveyard, lockPath)
    } catch {
      // The path is occupied again; the peer's token check will fail loudly on
      // release, and no state was written by us. Deleting the moved file is safe.
    }
    await unlink(graveyard).catch(() => undefined)
    return false
  }
  await unlink(graveyard).catch(() => undefined)
  return true
}

/** Whether a pid is still running. Signal 0 probes without delivering a signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The persisted store.
 *
 * All mutations go through `mutate`, which serializes writes so two concurrent
 * tasks cannot interleave and lose one another's changes. Construction is
 * synchronous — only the first read touches the disk — so a plugin can build the
 * store during mount without blocking, and every async entry point awaits
 * {@link ready} before using the synchronous accessors.
 */
export class DebateStore {
  private readonly options: StoreOptions
  private readonly file: string
  private data: StoreData = emptyStore()
  private loading: Promise<void> | undefined
  /**
   * Serializes writes as a chain, but each link resolves with *its own* outcome.
   *
   * The previous implementation did `.catch(() => undefined)`, which made a
   * failed write indistinguishable from a successful one to every caller. Here
   * the chain only orders the writes; the error still reaches whoever awaited
   * that particular `mutate`.
   */
  private writeChain: Promise<unknown> = Promise.resolve()
  /**
   * True while the in-memory document is known to differ from the file.
   *
   * Set when a write fails and cleared by the next successful one. It is what
   * lets the publisher refuse to send after a lost dedupe record: memory saying
   * "not sent yet" is worthless if the disk never learned it.
   */
  private dirty = false
  /** The last write failure, reported until a write succeeds. */
  private lastWriteError: StoreError | undefined
  /**
   * Whether this instance has ever seen a document on disk.
   *
   * `false` means "a missing file is genuinely a first run". Once true, a missing
   * file is a disappearance — deleted, moved, or a network path that dropped — and
   * must not be treated as an empty database (v0.2.8). Set on the first successful
   * load and on the first successful write, so a store that started empty and then
   * wrote is afterwards protected too.
   */
  private loadedOnce = false
  /**
   * Why the cached document may be out of date, when that is known (v0.2.8).
   *
   * Set by a failed {@link refreshFromDisk}, cleared by a successful one. The whole
   * point is that a failed refresh used to be silently ignored: the settings page
   * then rendered the *cached* session list and reported "no candidate is waiting
   * for approval", which is indistinguishable from a genuine empty list. A reader
   * that cannot see the current file must say so, not answer as if it had.
   */
  private stale: { reason: string; code?: StoreErrorCode } | undefined

  constructor(options: StoreOptions) {
    this.options = options
    this.file = join(options.dir, 'state.json')
  }

  /** Path of the backing file, for diagnostics. */
  get path(): string {
    return this.file
  }

  /** True when memory and disk are known to disagree. */
  get hasUnsavedChanges(): boolean {
    return this.dirty
  }

  /** The most recent write failure, when the store is dirty. */
  get unsavedReason(): string | undefined {
    return this.lastWriteError?.message
  }

  /** Load once; safe to call from every entry point. */
  ready(): Promise<void> {
    this.loading ??= this.load()
    return this.loading
  }

  /**
   * Re-read the document from disk before a decision that depends on it.
   *
   * ## Why a reader needs this at all
   *
   * `mutate` now merges against the on-disk document, so writes are safe. Reads are
   * a different problem: this instance's `data` is a cache, and another writer may
   * have replaced the file since it was last refreshed. A reader that decides
   * "this trigger has no dedupe record, so publish it" from a stale cache is exactly
   * the double-post the ledger exists to prevent — the record it needed was written
   * by the other instance a moment earlier.
   *
   * Callers use it at the few points where staleness changes behaviour: before
   * claiming a dedupe key, before consuming an approval, and before composing the
   * publish decision. Ordinary UI reads do not need it and stay cheap.
   *
   * Failures are swallowed on purpose. A refresh is an *improvement* over the
   * cached view, not a precondition: a transient read error must not make an
   * otherwise-working status page fail. The cached document is still what the
   * previous successful read observed.
   *
   * The swallowed error is *not* discarded (v0.2.8): it becomes {@link staleness},
   * because "I could not re-read" and "I re-read and nothing is waiting" have to be
   * distinguishable by whoever renders the result. Show the latter when the former
   * is true and the owner sees an empty approve list and walks away.
   */
  async refreshFromDisk(): Promise<void> {
    await this.ready()
    // A dirty store must not be refreshed from disk at all.
    //
    // "Dirty" means this instance holds a document it could not save. The file on
    // disk is therefore *behind* memory, and replacing memory with it would discard
    // the very record whose loss the dirty flag exists to report — the caller would
    // then see "no session", "no dedupe row", "no approval", and could decide to
    // send something the unsaved record was meant to prevent.
    //
    // The flag is cleared only by a successful write, never by a read.
    if (this.dirty) {
      this.stale = { reason: '本实例有尚未写盘的内存改动，磁盘内容比内存旧，因此这次没有用磁盘覆盖内存。' }
      return
    }
    try {
      this.data = await this.readCurrentDocument()
      this.lastWriteError = undefined
      this.stale = undefined
      // `loadedOnce` is deliberately **not** set here (v0.2.21 P0-1).
      //
      // `readCurrentDocument` returns an empty document when the file simply does not exist
      // yet, and that is indistinguishable from having read one. Setting the flag on that path
      // made the very next `transact` treat the still-absent file as "it disappeared while the
      // plugin was running" and refuse to write — so a brand-new store could not record its
      // first verification claim at all. The flag means "a document has been created or read",
      // and only `load()` and `persist()` can establish that.
    } catch (error) {
      // Keep the cached document — but remember *why* it is now of unknown age.
      this.stale = {
        reason: error instanceof Error ? error.message : String(error),
        ...(error instanceof StoreError ? { code: error.code } : {}),
      }
    }
  }

  /**
   * How stale {@link snapshot} may be, when that is known.
   *
   * `undefined` means the last read succeeded (or nothing has needed a re-read yet),
   * so the cached document is at least as new as the last successful refresh. A value
   * means the last attempt to re-read failed or was skipped, and the caller must not
   * present the cached document as current.
   *
   * Read-only and cheap: the settings route calls this on every render.
   */
  get staleness(): { readonly reason: string; readonly code?: StoreErrorCode } | undefined {
    return this.stale
  }

  /** True when this instance's document could not be refreshed from disk. */
  get hasStaleView(): boolean {
    return this.stale !== undefined
  }

  /**
   * Load from disk.
   *
   * A missing file is a normal first run. A file that exists but fails validation
   * is **not**: silently starting empty would drop every dedupe record and let the
   * plugin re-post replies it had already sent. Every invalid case therefore
   * backs up the original bytes and throws — there is no "repair and continue"
   * path, because that is exactly the path that loses publish history.
   */
  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.data = emptyStore()
        return
      }
      throw new StoreError('read_failed', `无法读取状态文件 ${this.file}：${(error as Error).message}`, {
        cause: error,
      })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Preserve the damaged bytes first: the user needs them to recover, and
      // the next successful save will overwrite this path.
      await this.backupCorrupt(raw)
      throw new StoreError(
        'corrupt',
        `状态文件 ${this.file} 不是合法 JSON：${(error as Error).message}。` +
          '为避免重复回帖，插件不会自动重置它；请先备份并检查该文件，或确认安全后手动删除。',
        { cause: error },
      )
    }

    // Full structural validation. Anything wrong is fatal, and the original bytes
    // are kept so a human can fix or migrate them.
    const validated = validateStore(parsed)
    if (!validated.ok) {
      await this.backupCorrupt(raw)
      throw new StoreError('corrupt', `状态文件 ${this.file} ${validated.reason}`, { cause: undefined })
    }
    this.data = validated.data
    // From here on, "the file is missing" means it disappeared — not a first run.
    this.loadedOnce = true
  }

  /** Keep a copy of an unreadable document next to the live one. */
  private async backupCorrupt(raw: string): Promise<void> {
    const backup = `${this.file}.corrupt-${Date.now()}`
    try {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
      await writeFile(backup, raw, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // A backup failure must not mask the real problem; the caller reports it.
    }
  }

  /** Current snapshot. */
  snapshot(): StoreData {
    return this.data
  }

  /**
   * Apply a change atomically and persist it.
   *
   * ## Why this re-reads under the lock (v0.2.7)
   *
   * A `change` function receives the *current* document and returns the next one.
   * Applying it to whatever this instance happens to hold in memory is only correct
   * while this instance is the sole writer. It is not: `buildRuntime()` constructs a
   * store, and `currentRuntime()` constructs another one on every config or
   * credential change — same directory, same `state.json`. Any operation still
   * holding the older instance then writes a document that was loaded *before* the
   * newer instance's writes, silently discarding them.
   *
   * That loss is not cosmetic. The records it eats are exactly the ones that must
   * survive: a `confirmed` dedupe row means "this reply was already sent" (losing it
   * re-posts), and an approval record means "the owner authorised this" (losing it
   * either blocks a real approval or, if a stale one survived, authorises the wrong
   * thing).
   *
   * So the change is applied to the document **as it is on disk right now**, inside
   * an advisory lock, rather than to this instance's private copy. The in-memory
   * copy is then replaced with the merged result, which also refreshes it for
   * readers.
   *
   * The `change` function must therefore be *pure with respect to the passed
   * document*: it may only look at its argument, never at `this.data`. Every caller
   * already is, because that is what the parameter is for.
   *
   * @param change a function from the current document to the next one
   * @returns the persisted next document
   * @throws StoreError when the lock cannot be taken or the write fails; the caller
   *   must not treat a rejected promise as a saved record
   */
  async mutate(change: (data: StoreData) => StoreData): Promise<StoreData> {
    await this.ready()

    // Applies the change to the document on disk and remembers the intended result.
    //
    // The intended document is installed in memory *before* the write is attempted,
    // not after. That ordering is the contract documented on `mutate` since v0.1.4
    // and something the publish path relies on: when the write fails, the caller can
    // still inspect what it meant to record, and `hasUnsavedChanges` tells it not to
    // send. Installing only on success would leave the in-memory view describing the
    // *previous* state and make a failed write look like a no-op.
    const run = async (): Promise<StoreData> => {
      let lock: LockHandle
      try {
        lock = await acquireLock(this.file, this.options.lockTimeoutMs)
      } catch (error) {
        // The lock could not be taken, so nothing may be merged or written. The
        // change is still applied to this instance's copy so the caller can inspect
        // what it meant to record — the documented contract on `mutate` — and the
        // store stays marked dirty by the caller of this function.
        this.data = prune(change(this.data), this.options)
        throw error
      }
      try {
        // Read *inside* the lock. Reading before it would reintroduce the very
        // lost-update window this function exists to close — two writers would both
        // read, both merge against the same base, and the second rename would win.
        //
        // ## No fallback on a read failure (v0.2.8)
        //
        // v0.2.7 wrote `.catch(() => this.data)` here. That swallowed **every**
        // read error, including `StoreError('corrupt')`, and turned "the file on disk
        // is damaged" into "use the in-memory copy" — after which the write replaced
        // the damaged file with that copy. The user's recoverable bytes were gone, and
        // `mutate` had reported success.
        //
        // The reproduction is four steps long and needs no concurrency: initialise,
        // write once, corrupt the file externally, write again. `mutate` resolved and
        // the corrupt content disappeared.
        //
        // A read failure now aborts the write. The change is still applied to this
        // instance's copy — the documented `mutate` contract, and what the publish
        // path needs in order to see `hasUnsavedChanges` and refuse to send — but
        // nothing is written and the original file is left exactly as it was.
        const base = await this.readCurrentDocument()
        const next = prune(change(base), this.options)
        this.data = next
        // Ownership check immediately before the write (v0.2.9).
        //
        // Everything above — reading the document, merging, pruning — happens across
        // `await`s, and each one is a window in which a peer can conclude this lock is
        // stale, move it aside and take its place. Writing on the strength of the
        // original acquisition is how two writers ended up overlapping. Re-reading the
        // lock costs one small fs call and converts that overlap into a refusal.
        if (!(await lock.verify())) {
          throw new StoreError(
            'write_failed',
            `状态写入锁在写入前被另一个进程接管（${this.file}.lock），本次写入已回滚：` +
              '继续写会让两个写入者同时进入临界区，可能丢掉刚写入的发表记录或人工批准。' +
              '这是可重试的：请重新执行这次操作。',
          )
        }
        await this.persist(next)
        return next
      } catch (error) {
        // Keep the attempted document visible when the merge itself succeeded but the
        // read or write did not. `hasUnsavedChanges` then reports the truth: memory
        // and disk disagree, so a publish must not proceed.
        if (error instanceof StoreError) throw error
        throw new StoreError('write_failed', `状态写入失败：${(error as Error).message}`, { cause: error })
      } finally {
        await lock.release()
      }
    }

    // Chain so callers in *this* instance keep their relative order; the disk lock
    // handles the other instances. `then` with both handlers keeps the chain alive
    // after a failure while the error still reaches whoever awaited this call.
    const write = this.writeChain.then(run, run)
    this.writeChain = write.catch(() => undefined)

    try {
      const next = await write
      this.dirty = false
      this.lastWriteError = undefined
      return next
    } catch (error) {
      this.dirty = true
      const wrapped =
        error instanceof StoreError
          ? error
          : new StoreError('write_failed', `状态写入失败：${(error as Error).message}`, { cause: error })
      this.lastWriteError = wrapped
      throw wrapped
    }
  }

  /**
   * Read, decide, and write, all inside one lock hold.
   *
   * ## Why this exists (v0.2.8)
   *
   * Creating an approval used to be two separate operations:
   *
   *   1. `getSession()` — read the candidate from this instance's view and check the
   *      expected snapshot against it;
   *   2. `mutate()` — take the lock and append the approval record.
   *
   * Between those two steps another process can replace the candidate (the agent
   * regenerates a reply, the owner re-targets one). The check then validated a
   * document that no longer existed, and the record was appended describing content
   * nobody had reviewed — exactly the failure v0.2.7 was supposed to close, moved
   * from "stale page" to "stale within one request".
   *
   * A `mutate` callback cannot fix this on its own: it receives the fresh document,
   * but it has no way to *refuse* and return a verdict to the caller — it can only
   * return the next document, so the only ways to say "no" are throwing (which the
   * store records as a write failure, wrongly) or writing nothing (which looks like
   * success).
   *
   * `transact` gives the callback both abilities: it sees the freshly-read document
   * and returns a discriminated result. `{ commit, value }` persists and hands `value`
   * back; `{ abort: value }` leaves the file untouched and hands the same `value`
   * back. Aborting is not an error — it is the normal outcome of "the thing you
   * approved is gone".
   *
   * `value` is what the caller wants to know: an HTTP status, a verdict, a record.
   * The callback needs to *both* decide the outcome and, on the happy path, write —
   * so the two are returned together rather than inferred from a side channel.
   *
   * @param decide runs with the on-disk document under the write lock
   * @returns the callback's value, plus the persisted document when it committed
   */
  async transact<T>(
    decide: (data: StoreData) => { commit: StoreData; value: T } | { abort: T },
  ): Promise<{ committed: StoreData; value: T } | { aborted: true; value: T }> {
    await this.ready()

    const run = async (): Promise<{ committed: StoreData; value: T } | { aborted: true; value: T }> => {
      let lock: LockHandle
      try {
        lock = await acquireLock(this.file, this.options.lockTimeoutMs)
      } catch (error) {
        if (error instanceof StoreError) throw error
        throw new StoreError('write_failed', `状态写入失败：${(error as Error).message}`, { cause: error })
      }
      try {
        const base = await this.readCurrentDocument()
        const decision = decide(base)
        if ('abort' in decision) {
          // Nothing is written, nothing is pruned, and the in-memory copy is left
          // alone: an aborted decision must not change what other readers see.
          return { aborted: true, value: decision.abort }
        }
        const next = prune(decision.commit, this.options)
        this.data = next
        // Same ownership re-check as `mutate` (v0.2.9): the decision callback can do
        // arbitrary work, so the gap between reading and writing here is at least as
        // wide as it is there.
        if (!(await lock.verify())) {
          throw new StoreError(
            'write_failed',
            `状态写入锁在写入前被另一个进程接管（${this.file}.lock），本次事务已回滚：` +
              '继续写会让两个写入者同时进入临界区。请重新执行这次操作。',
          )
        }
        await this.persist(next)
        return { committed: next, value: decision.value }
      } catch (error) {
        if (error instanceof StoreError) throw error
        throw new StoreError('write_failed', `状态写入失败：${(error as Error).message}`, { cause: error })
      } finally {
        await lock.release()
      }
    }

    const write = this.writeChain.then(run, run)
    this.writeChain = write.catch(() => undefined)

    try {
      const result = await write
      if ('committed' in result) {
        this.dirty = false
        this.lastWriteError = undefined
      }
      return result
    } catch (error) {
      this.dirty = true
      const wrapped =
        error instanceof StoreError
          ? error
          : new StoreError('write_failed', `状态写入失败：${(error as Error).message}`, { cause: error })
      this.lastWriteError = wrapped
      throw wrapped
    }
  }

  /**
   * The document currently on disk, or an empty one when this really is a first run.
   *
   * ## "Absent" is only a first run before the first load (v0.2.8)
   *
   * `ENOENT` used to mean "first run" unconditionally. That is right exactly once —
   * before this instance has ever read the file. Afterwards it means the state file
   * was *deleted or unmounted* while we were running, and treating that as a fresh
   * database is the same data loss as overwriting a corrupt file: the in-memory copy
   * gets written out as a brand-new document, and the publish ledger and approvals
   * that used to be on disk are gone with no error.
   *
   * So the flag is `loadedOnce`: false until the first successful `load()` or write.
   * After that, a missing file is a `read_failed` and the write is refused.
   *
   * ## Corrupt is always fatal
   *
   * A parse or schema failure keeps `StoreError('corrupt')` and never falls back to
   * memory: writing a merged document over it would destroy whatever a human could
   * still recover from the bytes.
   */
  private async readCurrentDocument(): Promise<StoreData> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        if (!this.loadedOnce) return emptyStore()
        throw new StoreError(
          'read_failed',
          `状态文件 ${this.file} 在插件运行期间消失了（ENOENT）。` +
            '为避免把内存里的残缺副本当成新数据库写出去、从而丢掉发表台账与人工批准记录，' +
            '这次写入被拒绝。请确认该文件是否被删除、移动或所在磁盘/网络目录是否掉线；' +
            '确认安全后再手动处理。',
        )
      }
      throw new StoreError('read_failed', `无法读取状态文件 ${this.file}：${(error as Error).message}`, {
        cause: error,
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StoreError(
        'corrupt',
        `状态文件 ${this.file} 在写入前已损坏（${(error as Error).message}）；` +
          '为避免覆盖掉可恢复的内容，这次写入被拒绝。请先备份并检查该文件。',
        { cause: error },
      )
    }
    const validated = validateStore(parsed)
    if (!validated.ok) {
      throw new StoreError('corrupt', `状态文件 ${this.file} ${validated.reason}`, { cause: undefined })
    }
    return validated.data
  }

  /**
   * Write to disk via a temp file plus rename.
   *
   * The rename is retried, because on Windows it transiently fails with `EPERM`
   * while another process (an antivirus scanner, the search indexer, a backup agent)
   * holds the destination open for a few milliseconds. That is a lock, not a real
   * permission problem, and surfacing it as "cannot write state" is misleading: a
   * publish is refused on a dirty store, so a transient lock would look like a
   * permanent misconfiguration and the user would go hunting for a permissions bug
   * that does not exist.
   *
   * Only `EPERM`/`EACCES`/`EBUSY` are retried, only a handful of times, and the
   * final error still propagates — a genuinely unwritable directory keeps failing.
   */
  private async persist(data: StoreData): Promise<void> {
    const body = `${JSON.stringify(data, undefined, 2)}\n`
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // A fresh temp name per attempt: if a failed rename left the previous temp
      // file locked, reusing the name would fail again for the original reason.
      const temp = `${this.file}.${process.pid}.${Date.now()}.${attempt}.tmp`
      try {
        // 0700 on the directory and 0600 on the file: the store holds who said
        // what to whom, which is nobody else's business on a shared machine.
        await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
        await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
        await rename(temp, this.file)
        // A successful write means a document now exists, so from here on a missing
        // file is a disappearance rather than a first run — even for a store that
        // started against an empty directory.
        this.loadedOnce = true
        return
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break
        // Back off briefly: the lock is short-lived or it is not a lock at all.
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
    throw new StoreError('write_failed', `状态写入失败（${this.file}）：${(lastError as Error).message}`, {
      cause: lastError,
    })
  }

  /** Find a session by id. */
  getSession(id: string): StoredSession | undefined {
    return this.data.sessions.find((session) => session.id === id)
  }

  /**
   * Recent security events, oldest first.
   *
   * Returns an empty array when the store predates the field, so a caller never
   * has to distinguish "no events" from "old file" — both mean nothing to report.
   */
  getSecurityEvents(): readonly SecurityEventRecord[] {
    return this.data.security ?? []
  }

  /**
   * Every stored approval, oldest first.
   *
   * Returns an empty array when the store predates the field. A caller must not
   * read "empty" as "no approval needed" — the publish path treats a missing record
   * as a refusal, and this accessor only answers "what is on file".
   */
  getApprovals(): readonly ApprovalRecord[] {
    return this.data.approvals ?? []
  }

  /**
   * Append one security event, keeping the newest `limit`.
   *
   * The cap is enforced here rather than by the caller so a store written by any
   * path stays bounded: an attacker who can post a thousand times must not be able
   * to grow this file without limit.
   */
  async appendSecurityEvent(
    event: SecurityEventRecord,
    limit: number,
  ): Promise<void> {
    await this.mutate((data) => {
      const existing = data.security ?? []
      // An event with a duplicate id would mean two writers raced on the same
      // counter; dropping the new one keeps the log append-only and honest about
      // what it actually observed.
      if (existing.some((row) => row.id === event.id)) return data
      const next = [...existing, event]
      const bounded = limit > 0 && next.length > limit ? next.slice(next.length - limit) : limit === 0 ? [] : next
      return { ...data, security: bounded }
    })
  }

  /** Sessions for one thread, newest first. */
  sessionsForThread(threadId: string): readonly StoredSession[] {
    return this.data.sessions
      .filter((session) => session.threadId === threadId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Every verification record, oldest first. */
  getVerificationRecords(): readonly VerificationRecordRow[] {
    return this.data.verification ?? []
  }

  /**
   * Re-read the verification records from disk before answering.
   *
   * ## Why a plain getter is not enough (v0.2.21 P0-1)
   *
   * `getVerificationRecords()` answers from *this instance's* copy, which only changes when this
   * instance writes. Two plugin instances over one directory (the arrangement v0.2.7 made
   * routine) therefore disagree: the instance that did not claim the authorization still sees
   * none, and a settings page opened there would report "nothing has been verified yet" about a
   * record that demonstrably exists.
   *
   * The read-only paths that show this to a human are async already, so they can pay one file
   * read. The publish gate stays synchronous on purpose — a gate that awaits a disk read in the
   * middle of a decision is a gate with a new failure mode — and is refreshed by the same call
   * whenever a publish begins.
   */
  async refreshVerificationRecords(): Promise<readonly VerificationRecordRow[]> {
    try {
      await this.refreshFromDisk()
    } catch {
      // A read failure must not turn into "no records": that is the reassuring answer for a
      // question we could not answer. The caller gets this instance's copy and the failure is
      // visible through the usual store error path on the next write.
    }
    return this.data.verification ?? []
  }

  /**
   * Record one verification attempt, upserting by `key`.
   *
   * Upsert rather than append is the whole point: the runner writes a `pending` row before the
   * network call and the outcome after, and those two writes describe **one** attempt. Appending
   * both would make "was this authorization used?" answerable two different ways depending on
   * which row a reader happened to look at.
   */
  async putVerificationRecord(record: VerificationRecordRow): Promise<void> {
    await this.mutate((data) => {
      const existing = data.verification ?? []
      const index = existing.findIndex((row) => row.key === record.key)
      const next = index === -1 ? [...existing, record] : existing.map((row, i) => (i === index ? record : row))
      return { ...data, verification: next }
    })
  }

  /**
   * Atomically claim one verification authorization, or report that it is spent.
   *
   * ## Why this cannot be "read the records, then write pending" (v0.2.21 P0-1)
   *
   * The runner used to do exactly that: read `getVerificationRecords()`, hand the resulting key
   * set to `checkVerification()`, and only then `putVerificationRecord({ outcome: 'pending' })`.
   * Both steps are correct on their own and useless together: two requests can both read an
   * empty list, both conclude the authorisation is unused, and both publish. The gap is small,
   * which is worse than a large one — it survives every manual test and shows up under exactly
   * the load nobody reproduces.
   *
   * `transact()` is the existing primitive for this shape (v0.2.8 built it for approvals for the
   * same reason). The check and the write happen inside one lock hold, against the document as
   * it is on disk, so "is this authorization spent?" and "record that it is now" are one
   * indivisible decision.
   *
   * Returns `{ claimed: false, existing }` — not an error — when the key is already present.
   * A refusal is the normal outcome here, and the caller must be able to tell it apart from a
   * disk failure. A write failure throws: the caller must **not** publish in that case.
   */
  async claimVerificationRecord(
    record: VerificationRecordRow,
  ): Promise<{ claimed: true } | { claimed: false; existing: VerificationRecordRow }> {
    const outcome = await this.transact<
      { claimed: true } | { claimed: false; existing: VerificationRecordRow }
    >((data) => {
      const existing = data.verification ?? []
      const found = existing.find((row) => row.key === record.key)
      if (found !== undefined) {
        // Abort, not commit: writing the pending row over a spent authorisation would
        // resurrect it, and the next reader would think the authorization is fresh again.
        return { abort: { claimed: false as const, existing: found } }
      }
      return { commit: { ...data, verification: [...existing, record] }, value: { claimed: true as const } }
    })
    if ('aborted' in outcome) return outcome.value
    return outcome.value
  }

  /** The dedupe record for a trigger, if any. */
  findDedupe(key: string): DedupeRecord | undefined {
    return this.data.dedupe.find((record) => record.key === key)
  }

  /**
   * How much live work is open, against the cap.
   *
   * Exposed as a method rather than by publishing `options`, so a caller cannot read
   * the config object and then compute capacity differently from `prune`.
   */
  capacity(): { active: number; cap: number; full: boolean; activeIds: readonly string[] } {
    return activeSessionCapacity(this.data, this.options)
  }

  /**
   * Publish activity for one thread, counted from the permanent ledger.
   *
   * Deliberately not computed from sessions: a session is pruned after the TTL, and
   * counting there let the per-thread cap reset itself — the plugin would happily
   * exceed `maxPublishesPerThread` simply because the earlier sessions had aged out.
   *
   * `unresolved` is reported separately because a `pending` publish is not evidence
   * of a sent reply, but it is not evidence of a free slot either; the caller decides
   * how conservative to be with it.
   */
  /**
   * Publish activity for one thread **on one platform**.
   *
   * The platform is part of the scope because thread ids are not globally unique:
   * `tieba/12345` and `weibo/12345` are different conversations, and counting
   * them together would let activity on one platform exhaust the other's quota —
   * or, worse, let one platform's cooldown silently suppress a publish on another.
   *
   * The old signature took only `threadId` and matched every row with that id. It
   * was correct while there was one platform and became a cross-platform bug the
   * moment a second one existed.
   *
   * @param platform the platform id; must be passed explicitly
   * @param threadId the thread id, unique only within the platform
   */
  threadPublishActivity(
    platform: string,
    threadId: string,
  ): {
    readonly confirmed: number
    readonly unresolved: number
    readonly lastConfirmedAt: number | undefined
  } {
    let confirmed = 0
    let unresolved = 0
    let lastConfirmedAt: number | undefined
    for (const record of this.data.dedupe) {
      // Both columns must match. A record written before the platform column
      // existed would have platform `'tieba'` (every pre-0.2.0 row), so old rows
      // keep counting for tieba and never for another platform.
      if (record.platform !== platform) continue
      if (record.threadId !== threadId) continue
      if (record.publishState === 'confirmed') {
        confirmed += 1
        const stamp = Date.parse(record.decidedAt ?? record.firstSeenAt)
        if (Number.isFinite(stamp) && (lastConfirmedAt === undefined || stamp > lastConfirmedAt)) {
          lastConfirmedAt = stamp
        }
      } else if (record.publishState === 'pending') {
        unresolved += 1
      }
    }
    return { confirmed, unresolved, lastConfirmedAt }
  }

  /** Usage totals. */
  usageSummary(): { calls: number; inputTokens: number; outputTokens: number; failures: number } {
    let inputTokens = 0
    let outputTokens = 0
    let failures = 0
    for (const row of this.data.usage) {
      inputTokens += row.inputTokens
      outputTokens += row.outputTokens
      if (row.error) failures += 1
    }
    return { calls: this.data.usage.length, inputTokens, outputTokens, failures }
  }
}

/**
 * Validate a parsed store document.
 *
 * Deliberately total: it either returns the document unchanged or explains why it
 * cannot be trusted. There is no "fill in the missing array" branch, because a
 * null `dedupe` array is indistinguishable from "every publish record was lost" —
 * and losing those records is how the plugin re-posts replies it already sent.
 *
 * @param value the parsed JSON
 * @returns the validated document, or the reason it was rejected
 */
export function validateStore(value: unknown): { ok: true; data: StoreData } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: '不是对象' }
  }
  const record = value as Record<string, unknown>

  if (!('version' in record)) return { ok: false, reason: '缺少 version 字段' }
  if (record.version !== 1) {
    // A future version may carry fields this build would silently drop, so it is a
    // refusal, not a downgrade. An older version would need an explicit migration
    // function; none exists yet, so it is also a refusal.
    return {
      ok: false,
      reason:
        `的 version 是 ${JSON.stringify(record.version)}，本版本只认识 1。` +
        '为避免丢失未知字段或误解旧格式，插件不会自动降级；请备份后手动处理或删除该文件。',
    }
  }

  for (const field of ['sessions', 'dedupe'] as const) {
    if (!(field in record)) return { ok: false, reason: `缺少 ${field} 字段` }
    if (!Array.isArray(record[field])) {
      return {
        ok: false,
        reason: `的 ${field} 不是数组（${JSON.stringify(record[field])}）`,
      }
    }
  }
  // `usage` is bookkeeping only: losing it costs a cost report, never a duplicate
  // post. It is allowed to be absent and is repaired to an empty list.
  if ('usage' in record && !Array.isArray(record.usage)) {
    return { ok: false, reason: `的 usage 不是数组（${JSON.stringify(record.usage)}）` }
  }

  const sessions = record.sessions as unknown[]
  for (const [index, session] of sessions.entries()) {
    const problem = validateSession(session)
    if (problem) return { ok: false, reason: `的第 ${index} 个会话${problem}` }
  }

  const dedupe = record.dedupe as unknown[]
  for (const [index, entry] of dedupe.entries()) {
    const problem = validateDedupe(entry)
    if (problem) return { ok: false, reason: `的第 ${index} 条去重记录${problem}` }
  }

  // A malformed approval is *dropped*, not repaired and not refused.
  //
  // Repairing it would invent authorisation from a damaged record, which is the one
  // direction that ends in a wrongly-published reply. Dropping is fail-closed: the
  // publish path treats "no record" as "not approved" and asks the owner again, which
  // costs one click. Refusing the whole document would be worse than either — a single
  // bad row would make the store unreadable and take the publish ledger with it.
  const approvals = (Array.isArray(record.approvals) ? record.approvals : []).filter(
    (entry): entry is ApprovalRecord => validateApproval(entry) === undefined,
  )

  return {
    ok: true,
    data: {
      version: 1,
      sessions: sessions as StoredSession[],
      dedupe: dedupe as DedupeRecord[],
      usage: Array.isArray(record.usage) ? (record.usage as UsageRecord[]) : [],
      // Same failure as `prune()`: this rebuilds the document field by field, so
      // anything omitted here is lost on read. `approvals` was omitted, which meant an
      // approval written by the settings page disappeared the moment the plugin
      // restarted — and the publish path then reported "no approval on file" for a
      // record the owner had demonstrably created minutes earlier.
      //
      // Both are optional-by-design (a v0.2.2 store has neither), so absent is
      // repaired to an empty list rather than refused. Validated below when present.
      security: Array.isArray(record.security) ? (record.security as SecurityEventRecord[]) : [],
      approvals,
      // v0.2.21: same class of bug the two fields above were. Omitting this rebuilds the
      // document without it, so every verification record would vanish on the first read after
      // a restart — and a vanished record means the same authorization could be spent a second
      // time, which is the double-post this whole flow exists to prevent.
      verification: Array.isArray(record.verification)
        ? (record.verification as VerificationRecordRow[])
        : [],
    },
  }
}

/** A session must at least carry the fields publishing depends on. */
function validateSession(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return '不是对象'
  const session = value as Record<string, unknown>
  for (const field of ['id', 'platform', 'threadId', 'triggerPostId', 'state'] as const) {
    if (typeof session[field] !== 'string') return `缺少字符串字段 ${field}`
  }
  if (!Array.isArray(session.candidates)) return '的 candidates 不是数组'
  if (!Array.isArray(session.publishedPostIds)) return '的 publishedPostIds 不是数组'
  return undefined
}

/**
 * A dedupe record is the publish guard, so it is validated hardest.
 *
 * A row without `key` cannot match any trigger and would silently allow a re-post;
 * one with an unknown `publishState` cannot be interpreted as "already sent".
 */
function validateDedupe(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return '不是对象'
  const entry = value as Record<string, unknown>
  for (const field of ['key', 'platform', 'threadId', 'ownerKey', 'triggerPostId', 'sessionId'] as const) {
    if (typeof entry[field] !== 'string' || (entry[field] as string).length === 0) {
      return `缺少非空字符串字段 ${field}`
    }
  }
  if ('publishState' in entry && entry.publishState !== undefined) {
    const state = entry.publishState
    if (state !== 'pending' && state !== 'confirmed' && state !== 'failed') {
      return `的 publishState 是未知值 ${JSON.stringify(state)}`
    }
  }
  return undefined
}

/**
 * A stored approval must carry every field the binding comparison reads.
 *
 * Missing one would make the comparison silently pass on that dimension: an
 * `undefined === undefined` on `assessmentFingerprint` would let an approval for one
 * assessment authorise a different one. So a row that cannot answer every question is
 * dropped rather than loaded with holes.
 */
function validateApproval(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '不是对象'
  const entry = value as Record<string, unknown>
  for (const field of [
    'id',
    'sessionId',
    'candidateId',
    'platform',
    'targetPostId',
    'publishingAccount',
    'textHash',
    'assessmentFingerprint',
    'grantedBy',
    'grantedAt',
  ] as const) {
    if (typeof entry[field] !== 'string') return `缺少字符串字段 ${field}`
  }
  // An empty id cannot be consumed by id, and an unparseable timestamp cannot be
  // expiry-checked — both would be permanently-valid free passes.
  if ((entry.id as string).length === 0) return 'id 为空'
  if (!Number.isFinite(Date.parse(entry.grantedAt as string))) return '的 grantedAt 不是时间戳'
  if (typeof entry.candidateVersion !== 'number' || !Number.isFinite(entry.candidateVersion)) {
    return '缺少数字字段 candidateVersion'
  }
  if ('consumedAt' in entry && entry.consumedAt !== undefined && typeof entry.consumedAt !== 'string') {
    return '的 consumedAt 不是字符串'
  }
  if ('revokedAt' in entry && entry.revokedAt !== undefined && typeof entry.revokedAt !== 'string') {
    return '的 revokedAt 不是字符串'
  }
  return undefined
}

/**
 * Drop expired sessions and trim unbounded lists.
 *
 * Two rules, and both exist because breaking them has already caused real bugs:
 *
 * **1. Publish records are never dropped silently.**
 *
 * A session is a working scratchpad and may expire. A dedupe row is the permanent
 * fact "this trigger was already answered", and deleting it is precisely how the same
 * summon gets answered twice — the guard would be gone while the platform still shows
 * the first reply.
 *
 * The previous version capped the array with `.slice(-maxDedupe)`, which discards the
 * *oldest* rows — precisely the most established publish records. A 2001-row store
 * silently forgot its first publish. Now:
 *
 * - `confirmed` and `pending` rows are never removed by pruning, whatever the count;
 * - only `failed` rows (nothing was sent) age out with the session TTL;
 * - exceeding the soft cap is *reported* (see {@link publishLedgerOverCapacity}) and
 *   never enforced by deletion, because a duplicate post costs far more than a few
 *   kilobytes of ledger.
 *
 * **2. `maxSessions` caps *terminal* sessions only.**
 *
 * The previous version filtered out expired terminal sessions and then applied
 * `.slice(-maxSessions)` to whatever remained — which still contained live work. With
 * `maxSessions: 1`, creating a second `READY` session silently deleted the first one:
 * a draft the user was part-way through reviewing simply vanished, and because the
 * ledger row survived it, the trigger looked "never analysed" while its candidate was
 * unrecoverable.
 *
 * Now the cap applies to finished sessions only. Live sessions — anything the user or
 * the plugin may still act on — are always kept, even past the cap. Over-capacity is
 * reported by {@link activeSessionCapacity} so the caller can refuse to start new work
 * instead of sacrificing data, which is the trade this plugin must never make
 * automatically.
 */
function prune(data: StoreData, options: StoreOptions): StoreData {
  const now = Date.now()
  const ttl = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000
  const maxSessions = options.maxSessions ?? 200
  const maxUsage = options.maxUsageRows ?? 500

  // Live sessions pass through untouched; finished ones may expire.
  const live: StoredSession[] = []
  const terminal: StoredSession[] = []
  for (const session of data.sessions) {
    if (!TERMINAL_STATES.includes(session.state)) {
      live.push(session)
      continue
    }
    const updated = Date.parse(session.updatedAt)
    // An expired finished session is dropped outright and never enters the cap pool.
    if (Number.isFinite(updated) && now - updated >= ttl) continue
    terminal.push(session)
  }

  // Only the finished-and-kept pool is subject to the cap. `slice(-maxSessions)` keeps
  // the most recent, which is the right end to keep for history — nothing live is in
  // this list, so nothing can be lost that the user was still working on.
  const keptTerminal = terminal.slice(Math.max(0, terminal.length - maxSessions))

  // Rebuild in the original order so ids, ordering and any external reasoning about
  // "the newest session" stay meaningful.
  const surviving = new Set<StoredSession>([...live, ...keptTerminal])
  const sessions = data.sessions.filter((session) => surviving.has(session))
  // Publish records are kept whole, in original order.
  const dedupe = data.dedupe.filter((record) => {
    // Unknown-outcome and already-sent publishes are permanent.
    if (record.publishState === 'pending') return true
    if (record.publishState === 'confirmed') return true
    // `failed` sent nothing, so it only needs to outlive a would-be retry.
    const seen = Date.parse(record.firstSeenAt)
    return !Number.isFinite(seen) || now - seen < ttl
  })

  const usage = data.usage.slice(-maxUsage)

  // `security` and `approvals` must survive this function.
  //
  // It returns a *fresh* document rather than mutating the old one, so any field it
  // forgets to carry is silently erased by the very next write. `approvals` was added
  // in v0.2.5 and not carried here, which meant every approval record vanished on the
  // next mutation — and since the publish path *writes a ledger row* before sending,
  // the record was gone before it could ever be checked. The failure mode was a
  // refusal that looked like "the owner never approved", with a record sitting in
  // memory that had demonstrably been created.
  //
  // `security` had the same latent bug from v0.2.3; the panel simply reads through a
  // different accessor that re-reads from disk, so it showed an empty log instead of
  // crashing. Both are fixed here, and `PRESERVED_FIELDS` below is asserted against
  // `StoreData` in the tests so a future field cannot repeat this.
  return {
    version: 1,
    sessions,
    dedupe,
    usage,
    security: data.security ?? [],
    approvals: pruneApprovals(data.approvals ?? [], () => now),
    // Verification records are the audit trail of "somebody actually published once to prove
    // it works". Pruning them would let the same authorization be spent again after a while,
    // which is exactly the double-post the once-per-authorization rule exists to prevent.
    verification: data.verification ?? [],
  }
}

/**
 * Every field of {@link StoreData}.
 *
 * `prune()` builds a new document by hand, so a field it omits is destroyed on the
 * next write. Listing them here lets a test assert that this list covers the
 * interface: adding a field to `StoreData` without deciding what happens to it in
 * `prune()` now fails loudly instead of losing data quietly.
 */
export const PRESERVED_FIELDS = [
  'version',
  'sessions',
  'dedupe',
  'usage',
  'security',
  'approvals',
  'verification',
] as const

/**
 * How many sessions are still actionable, and whether that exceeds the cap.
 *
 * The cap bounds *finished* history, not live work (see {@link prune}). Live sessions
 * are counted separately so a caller can refuse to start another task instead of
 * dropping one the user has not finished with.
 *
 * @param data the store document
 * @param options the store options
 * @returns live count, the cap, and whether starting more work would exceed it
 */
export function activeSessionCapacity(
  data: StoreData,
  options: StoreOptions,
): { active: number; cap: number; full: boolean; activeIds: readonly string[] } {
  const cap = options.maxSessions ?? 200
  const live = data.sessions.filter((session) => !TERMINAL_STATES.includes(session.state))
  return {
    active: live.length,
    cap,
    full: live.length >= cap,
    activeIds: live.map((session) => session.id),
  }
}

/**
 * Whether the publish ledger has outgrown its soft capacity.
 *
 * Reported rather than enforced: deleting a publish record to save space trades a
 * duplicate post for a few kilobytes, which is not a trade worth making
 * automatically. The caller surfaces this so a human can archive consciously.
 */
export function publishLedgerOverCapacity(
  data: StoreData,
  options: StoreOptions,
): { over: boolean; rows: number; cap: number } {
  const cap = options.maxDedupeRows ?? 2000
  return { over: data.dedupe.length > cap, rows: data.dedupe.length, cap }
}

/**
 * The durable identity of one summoning event.
 *
 * This is what an idempotency key must be built from: things the platform will still
 * report identically tomorrow.
 *
 * What is **out** and why:
 *
 * - **The owner's display name.** A nickname is user-editable at will. v0.1.4 built
 *   the key from it, so renaming oneself produced a second key for a summons that had
 *   already been answered, and the ledger's `confirmed` row no longer matched — the
 *   plugin could offer to post the same reply again. That is the bug this shape fixes.
 * - **Anything time- or process-derived.** A key that embeds "now" or a random session
 *   id is not idempotent, and two concurrent analyses of one summons would disagree.
 *
 * What is **in**: the platform, the thread, and the exact summoning post. Inside one
 * thread a post id is assigned by the platform and never reused, so
 * `(platform, threadId, triggerPostId)` is unique per event — and deliberately so:
 * two different triggers in one thread are different events, and the same trigger id
 * in two different threads is a different event. `eventId` stays optional because the
 * tieba adapter has no separate event identifier; when a platform does expose one it
 * belongs here rather than in the owner field.
 *
 * The owner is *not* part of the identity. Whether a particular person may act on a
 * trigger is an authorisation question, checked against the session and the platform
 * on every publish — not an identity question about the event itself.
 */
export interface TriggerIdentity {
  readonly platform: string
  readonly threadId: string
  readonly triggerPostId: string
  readonly eventId?: string
}

/**
 * Render the canonical id for one summoning event.
 *
 * Stable across nickname changes, avatar changes, restarts, concurrent runs and
 * version upgrades — which is the whole point. See {@link TriggerIdentity}.
 *
 * @param identity the platform-scoped event coordinates
 * @returns the canonical id, safe to use as a ledger key
 */
export function canonicalTriggerId(identity: TriggerIdentity): string {
  const event = identity.eventId && identity.eventId.length > 0 ? identity.eventId : 'na'
  return `${identity.platform}:${identity.threadId}:${identity.triggerPostId}:${event}`
}

/**
 * Build the ledger key for one trigger event.
 *
 * `ownerKey` is accepted and ignored. It stays in the signature because every caller
 * still has one to hand and because the field remains meaningful *on the record* — it
 * says who the owner was — but it must not reach the key: `ownerKey` is a display name
 * whenever the platform exposed no numeric id, and a name that can be edited cannot
 * anchor idempotency.
 *
 * @param input event coordinates; `ownerKey` is deliberately unused
 * @returns the canonical trigger id
 */
export function dedupeKey(input: {
  platform: string
  threadId: string
  /** Ignored. Kept for call-site compatibility; see the doc comment. */
  ownerKey?: string
  triggerPostId: string
  eventId?: string
}): string {
  return canonicalTriggerId({
    platform: input.platform,
    threadId: input.threadId,
    triggerPostId: input.triggerPostId,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
  })
}

/**
 * Find every ledger row that belongs to one canonical trigger, old scheme or new.
 *
 * This is the compatibility bridge. A user upgrading from 0.1.4 may hold rows keyed
 * by `platform:thread:昵称:trigger:na`; if the analysis only looked up the new
 * canonical key it would find nothing and re-offer a reply for a summon already
 * answered. So the match is made on the **explicit columns** — `platform`,
 * `threadId`, `triggerPostId` — which every version has written correctly, instead of
 * on the derived key string.
 *
 * Parsing the key was rejected on purpose: a nickname may itself contain a colon, so
 * "split and count fields" cannot tell a legacy key from a canonical one. The columns
 * are unambiguous.
 *
 * @param records the ledger
 * @param identity the canonical event
 * @returns every matching row, in ledger order
 */
export function findTriggerRecords(
  records: readonly DedupeRecord[],
  identity: TriggerIdentity,
): readonly DedupeRecord[] {
  return records.filter((record) => {
    if (record.platform !== identity.platform) return false
    if (record.threadId !== identity.threadId) return false
    if (record.triggerPostId !== identity.triggerPostId) return false
    // When the event carries an explicit id, rows recorded under a different one are
    // a different event. Absent on either side is not a mismatch: only one version
    // may know about it.
    if (identity.eventId !== undefined && record.eventId !== undefined && record.eventId !== identity.eventId) {
      return false
    }
    return true
  })
}

/**
 * Combine several historical rows for one trigger into one verdict.
 *
 * Upgrading can surface more than one row for a single summon: a nickname change
 * before the upgrade left two. They may disagree, and the merge must never invent a
 * safer-looking answer than the evidence supports:
 *
 * - **confirmed wins outright.** Once a reply is known to be in the thread, no other
 *   row's state can be allowed to re-open publishing. If confirmed rows name different
 *   posts, that is contradictory history and needs a human.
 * - **pending with no confirmed means "outcome unknown".** It blocks, because a retry
 *   could duplicate a reply that did go out.
 * - **failed means nothing was sent**, so it is the only state that leaves the summon
 *   free to proceed — and only when no stronger row exists.
 *
 * @param records the rows found for one trigger
 * @returns the merged state, plus whether the evidence is contradictory
 */
export function mergeTriggerRecords(records: readonly DedupeRecord[]):
  | {
      readonly found: false
    }
  | {
      readonly found: true
      readonly publishState: 'confirmed' | 'pending' | 'failed' | undefined
      readonly publishedPostId?: string
      readonly firstSeenAt: string
      readonly conflicting: boolean
      readonly reason?: string
    } {
  if (records.length === 0) return { found: false }

  const confirmed = records.filter((record) => record.publishState === 'confirmed')
  const pending = records.filter((record) => record.publishState === 'pending')

  const earliest = records
    .map((record) => record.firstSeenAt)
    .filter((stamp) => Number.isFinite(Date.parse(stamp)))
    .sort()[0]

  if (confirmed.length > 0) {
    const ids = new Set(confirmed.map((record) => record.publishedPostId ?? ''))
    // Different post ids across confirmed rows mean the ledger cannot say which reply
    // is the real one. Publishing again on that basis is exactly the duplicate this
    // whole mechanism exists to prevent, so it is reported, not resolved.
    const conflicting = ids.size > 1
    const postId = [...ids].find((id) => id.length > 0)
    return {
      found: true,
      publishState: 'confirmed',
      ...(postId ? { publishedPostId: postId } : {}),
      firstSeenAt: earliest ?? records[0]!.firstSeenAt,
      conflicting,
      ...(conflicting
        ? {
            reason:
              '历史记录里有不止一条“已确认发表”，但记录的回复 ID 不一致，' +
              '无法确定哪一条才是真实发出过的。已停止自动发布，请打开帖子人工核对。',
          }
        : {}),
    }
  }

  if (pending.length > 0) {
    return {
      found: true,
      publishState: 'pending',
      firstSeenAt: earliest ?? records[0]!.firstSeenAt,
      conflicting: false,
    }
  }

  return {
    found: true,
    // No confirmed and no pending row: `failed` if anything was tried, otherwise the
    // row exists but the publish never started. Both leave the summon free to proceed.
    publishState: records.some((record) => record.publishState === 'failed') ? 'failed' : undefined,
    firstSeenAt: earliest ?? records[0]!.firstSeenAt,
    conflicting: false,
  }
}

/** Create a session id that sorts by time and stays unique. */
export function newSessionId(seed: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const hash = [...seed].reduce((acc, char) => (acc * 31 + char.codePointAt(0)!) >>> 0, 7)
  return `s${stamp}${hash.toString(36)}`
}

/** Create a candidate id. */
export function newCandidateId(sessionId: string, index: number): string {
  return `${sessionId}-c${index}`
}

/**
 * Insert or merge a publish record.
 *
 * Merging, not replacing: the publish facts on a record are the reason it exists,
 * and a caller that omits one — the analysis path re-registering a trigger, for
 * instance — must not erase it by writing a blank row under the same key.
 *
 * `confirmed` is absorbing. Once a reply is known to be in the thread, no later
 * write may demote it to `pending` or `failed`, because both invite a retry, and
 * a retry after a confirmed publish is a duplicate post.
 *
 * @param records the current ledger
 * @param next the row to store
 * @returns a new ledger with the row inserted or merged
 */
export function upsertDedupe(records: readonly DedupeRecord[], next: DedupeRecord): readonly DedupeRecord[] {
  const index = records.findIndex((record) => record.key === next.key)
  if (index < 0) return [...records, next]

  const previous = records[index]!
  const merged: DedupeRecord = {
    ...previous,
    ...next,
    // The first sighting is a historical fact; a later write cannot move it.
    firstSeenAt: previous.firstSeenAt || next.firstSeenAt,
    // An omitted field means "not stated here", which is weaker than what is
    // already recorded, so the stored value wins.
    ...(next.publishState === undefined && previous.publishState !== undefined
      ? { publishState: previous.publishState }
      : {}),
    ...(next.publishedPostId === undefined && previous.publishedPostId !== undefined
      ? { publishedPostId: previous.publishedPostId }
      : {}),
  }

  const copy = [...records]
  copy[index] =
    previous.publishState === 'confirmed' && merged.publishState !== 'confirmed'
      ? { ...merged, publishState: 'confirmed', publishedPostId: previous.publishedPostId }
      : merged
  return copy
}

/** Where the store lives when the caller does not say. */
export function defaultStoreDir(homeDir: string): string {
  return join(homeDir, '.dsh', 'ai-debate')
}

/** Ensure a directory exists, resolving its absolute form. */
export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dirname(join(dir, 'x')).replace(/[\\/]x$/, '') || dir
}
