/**
 * Composition for the one-off publish verification (v0.2.21 §三).
 *
 * `verification.ts` is the rules, `verification-runner.ts` is the order of operations, and this
 * file is the wiring: it binds the runner to the store, the registry and the adapter manager so
 * that the settings page (the owner) can actually start one. Before v0.2.21 the flow existed but
 * nothing called it — a rule with no caller is a rule that protects nothing.
 *
 * ## Why this is not exposed as an agent tool
 *
 * The task book requires that the owner, not the model, provide the account, the thread, the
 * target and the exact text. A tool's arguments are written by the model, so a tool that accepts
 * "publish this text to this thread to prove publishing works" is a tool that lets the model pick
 * where to post. The entry point therefore lives on the owner-only settings route, and the model
 * cannot reach it — the same reasoning that keeps approval ids out of tool outputs.
 *
 * ## What the caller must pass
 *
 * Everything. There is no default account, no default thread, no generated text. See
 * `describeAuthorizationRequirements` in `verification.ts` for the text shown to the owner.
 */

import { adapterVersionOfAdapter, effectiveCapability, type CapabilityEvidenceRecord } from './capability-evidence.js'
import type { CapabilityName, CapabilityState } from './platforms/contracts.js'
import type { PlatformAdapter } from './types.js'
import type { VerificationAuthorization, VerificationRecord } from './verification.js'
import {
  runVerification,
  type VerificationRecordStore,
  type VerificationRunResult,
} from './verification-runner.js'

/** What the wiring needs from the host. All of it already exists in the plugin. */
export interface VerificationServiceDeps {
  /** The adapter for one platform, or `undefined` when the platform is not registered. */
  readonly adapterFor: (platform: string) => PlatformAdapter | undefined
  /** The static declaration — the ceiling that evidence may lift but never edit. */
  readonly declaredState: (platform: string, capability: CapabilityName) => CapabilityState
  /** The account the owner configured as this platform's posting identity. */
  readonly configuredAccountId: (platform: string) => string | undefined
  /** The live session's account, read fresh each attempt. */
  readonly liveAccountId: (platform: string) => Promise<string | undefined>
  /** Durable records. */
  readonly records: VerificationRecordStore
  /** ISO clock. */
  readonly now: () => string
}

/** Why a verification could not even be attempted, distinct from a platform refusal. */
export interface VerificationUnavailable {
  readonly ok: false
  readonly code: 'unknown_platform' | 'no_adapter' | 'no_account'
  readonly message: string
}

export interface VerificationService {
  /** The account + adapter version this deployment would verify against. */
  describe(platform: string): {
    accountId: string | undefined
    adapterVersion: string | undefined
    capability: Record<CapabilityName, { declared: CapabilityState; effective: CapabilityState; reason: string }>
  }
  /** Records, for the diagnostics panel and the machine-readable report. */
  history(): readonly VerificationRecord[]
  /** Run exactly one attempt. Returns rather than throwing for every expected refusal. */
  verify(
    authorization: VerificationAuthorization,
    signal?: AbortSignal,
  ): Promise<VerificationRunResult | VerificationUnavailable>
  /** The evidence rows `capability-evidence.ts` joins with the declaration. */
  evidenceFor(platform: string, capability: CapabilityName, accountId: string, adapterVersion: string): readonly CapabilityEvidenceRecord[]
}

/**
 * Build the service.
 *
 * Deliberately stateless apart from what `deps` owns: every call re-reads the store and the
 * adapter, because both can change (a reload, a cookie update) between the page rendering and
 * the owner pressing the button.
 */
export function buildVerificationService(deps: VerificationServiceDeps): VerificationService {
  const verifyCapabilities: readonly CapabilityName[] = ['comment.publish', 'comment.reply']

  function evidenceFor(
    platform: string,
    capability: CapabilityName,
    accountId: string,
    adapterVersion: string,
  ): readonly CapabilityEvidenceRecord[] {
    return deps.records
      .all()
      .filter((record) => record.outcome === 'succeeded')
      .map(
        (record): CapabilityEvidenceRecord => ({
          platform: record.platform,
          capability: record.capability,
          accountId: record.authorizedAccountId,
          // The version the attempt **actually ran against**, stamped when it ran. Reading the
          // current build here instead would let a rewritten publish method inherit the old
          // evidence — the one thing §三.9 forbids.
          adapterVersion: record.adapterVersion ?? '',
          verifiedAt: record.startedAt,
          method: 'live' as const,
          readBackComplete:
            record.readBack !== undefined &&
            record.readBack.postFound &&
            record.readBack.authorMatched &&
            record.readBack.textMatched &&
            record.readBack.parentMatched,
        }),
      )
      .filter(
        (row) =>
          row.platform === platform &&
          row.capability === capability &&
          row.accountId === accountId &&
          row.adapterVersion === adapterVersion,
      )
  }

  return {
    describe(platform) {
      const adapter = deps.adapterFor(platform)
      const accountId = deps.configuredAccountId(platform)
      const adapterVersion = adapter === undefined ? undefined : adapterVersionOfAdapter(adapter)
      const capability = {} as Record<
        CapabilityName,
        { declared: CapabilityState; effective: CapabilityState; reason: string }
      >
      for (const name of verifyCapabilities) {
        const declared = deps.declaredState(platform, name)
        const rows =
          accountId === undefined || adapterVersion === undefined
            ? []
            : evidenceFor(platform, name, accountId, adapterVersion)
        const decision = effectiveCapability(declared, { platform, capability: name, accountId: accountId ?? '', adapterVersion: adapterVersion ?? '' }, rows)
        capability[name] = { declared, effective: decision.effective, reason: decision.reason }
      }
      return { accountId, adapterVersion, capability }
    },

    history() {
      return deps.records.all()
    },

    async verify(authorization, signal) {
      const adapter = deps.adapterFor(authorization.platform)
      if (adapter === undefined) {
        return {
          ok: false,
          code: 'no_adapter',
          message: `平台 ${authorization.platform} 没有可用的适配器（未注册，或凭据尚未加载完成）`,
        }
      }
      const liveAccountId = await deps.liveAccountId(authorization.platform)
      return runVerification(authorization, {
        adapter,
        capabilityState: () => deps.declaredState(authorization.platform, authorization.capability),
        liveAccountId: async () => liveAccountId,
        records: deps.records,
        now: deps.now,
        adapterVersion: adapterVersionOfAdapter(adapter),
        ...(signal !== undefined ? { signal } : {}),
      })
    },

    evidenceFor,
  }
}
