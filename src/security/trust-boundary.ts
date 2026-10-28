/**
 * Trust boundaries: what may influence what.
 *
 * ## The one rule that matters
 *
 * Text from a stranger must never become an instruction to this program. That
 * sounds obvious, but every step of a useful pipeline is an opportunity to break
 * it:
 *
 * - the compressor flattens forum posts into a model prompt, so a comment sits in
 *   the same message as the task;
 * - the generator asks the model for JSON, so a comment containing `{"status":
 *   "ok", "response_target_id": "..."}` looks like output;
 * - the analyzer derives a `DebateBrief` *from* those comments, so the derived
 *   data inherits their trust even though it now looks structured;
 * - the publisher trusts the stored candidate, which was written by that chain.
 *
 * A boundary that is only checked at one of those points is decorative. This
 * module defines the levels once, and every consumer asks it rather than deciding
 * for itself.
 *
 * ## Why four levels and not two
 *
 * "Trusted / untrusted" cannot express the case that actually causes trouble: a
 * *derived* value. A summary of an attacker's comment is not attacker text — it
 * is our own output — yet it is contaminated, and treating it as trusted is how a
 * second-order injection gets through. Level 2 exists to say "we produced this,
 * and it is still not authority".
 *
 * ## What is *not* here
 *
 * No detection logic. This module answers only "where did this come from and what
 * may it do"; recognising an attack is `injection-detector.ts`'s job. Keeping them
 * apart matters because the boundary check must hold even when detection fails.
 */

import type { PlatformId } from '../types.js'

/**
 * Where a piece of text came from, and what it is allowed to influence.
 *
 * Ordering is meaningful: a lower number is more trusted. Code should compare
 * levels rather than matching on names, so adding a level later does not require
 * touching every call site.
 */
export enum TrustLevel {
  /**
   * Policy compiled into the plugin: capability gate, publish rules, credential
   * namespacing, owner binding requirements.
   *
   * Nothing at runtime may produce this level. A comment claiming to *be* policy
   * is still a comment.
   */
  SystemPolicy = 0,

  /**
   * An action the owner explicitly authorized: choosing a thread, approving a
   * candidate text, binding an account through the settings page.
   *
   * **A model's tool-call arguments are not this level.** When the model asks to
   * publish, that is a request, and the application decides whether the owner
   * authorized the exact thing being requested. Treating model output as
   * authorization is the single easiest way to lose the whole boundary, because
   * the model's output is exactly what an injection tries to control.
   */
  OwnerGranted = 1,

  /**
   * Values this plugin computed from the conversation: the graph, the brief, the
   * compressor's chunks, fact-check results.
   *
   * Derived, therefore *contaminated by construction*. A brief built from a
   * malicious comment can contain a malicious "argument". Level 2 may inform what
   * we show the owner and what we send as context; it may not grant permission.
   */
  Derived = 2,

  /**
   * Everything a stranger wrote or that came off the network: post bodies,
   * comments, nested replies, nicknames, bios, image OCR, video transcripts,
   * quotes, search results, third-party pages, tool output holding external data.
   *
   * Data only. Never an instruction, never an identity, never a permission.
   */
  ExternalUntrusted = 3,
}

/** Which kinds of external content a value can be. Recorded for reporting. */
export type ExternalSourceType =
  | 'thread_title'
  | 'thread_body'
  | 'comment'
  | 'nested_reply'
  | 'user_name'
  | 'user_bio'
  | 'image_ocr'
  | 'video_transcript'
  | 'quote'
  | 'search_result'
  | 'third_party_page'
  | 'tool_output'

/** One value with its provenance attached. */
export interface TrustedText {
  readonly level: TrustLevel
  /** The text itself. Never mutated; a normalised copy is produced separately. */
  readonly text: string
  /** Set when `level === ExternalUntrusted`, so reports can say what was attacked. */
  readonly sourceType?: ExternalSourceType
  readonly platform?: PlatformId
  readonly threadId?: string
  readonly postId?: string
  readonly authorId?: string
  /** For a reply: the post it answers, as far as the platform stated. */
  readonly replyToId?: string
  /** For a comment: the floor/comment it hangs under. */
  readonly parentId?: string
}

/**
 * The promotion this whole module exists to forbid.
 *
 * Any attempt to treat external or derived text as policy or authorization is a
 * bug in the caller, so it throws rather than returning a boolean: a silent
 * `false` would let the caller continue with the untrusted value and produce a
 * subtler version of the same problem.
 */
export function assertNoPromotion(from: TrustLevel, to: TrustLevel, what: string): void {
  if (to >= from) return
  throw new Error(
    `拒绝把「${what}」从 ${{ 0: '系统策略', 1: '主人授权', 2: '派生数据', 3: '外部不可信' }[from]} ` +
      `提升为 ${{ 0: '系统策略', 1: '主人授权', 2: '派生数据', 3: '外部不可信' }[to]}：` +
      '外部文本只能作为数据参与分析，不能变成指令、身份或权限',
  )
}

/** True when text at this level may be used as an instruction. */
export function mayInstruct(level: TrustLevel): boolean {
  return level === TrustLevel.SystemPolicy || level === TrustLevel.OwnerGranted
}

/** True when text at this level may be asserted to the model as fact. */
export function mayAssertAsFact(level: TrustLevel): boolean {
  // Only policy and explicit owner statements. Derived data may be presented as
  // *analysis* but not as fact, because it was computed from untrusted input.
  return level === TrustLevel.SystemPolicy || level === TrustLevel.OwnerGranted
}

/** Describe a level for a user-facing message. */
export function describeLevel(level: TrustLevel): string {
  switch (level) {
    case TrustLevel.SystemPolicy:
      return '系统策略'
    case TrustLevel.OwnerGranted:
      return '主人授权'
    case TrustLevel.Derived:
      return '程序派生数据'
    case TrustLevel.ExternalUntrusted:
      return '外部不可信内容'
  }
}

/** Wrap external text, which is the only level most callers ever create. */
export function externalText(
  text: string,
  sourceType: ExternalSourceType,
  origin: {
    platform?: PlatformId
    threadId?: string
    postId?: string
    authorId?: string
    replyToId?: string
    parentId?: string
  } = {},
): TrustedText {
  return {
    level: TrustLevel.ExternalUntrusted,
    text,
    sourceType,
    ...origin,
  }
}

/** Wrap text this plugin computed from the conversation. */
export function derivedText(
  text: string,
  origin: { platform?: PlatformId; threadId?: string; postId?: string } = {},
): TrustedText {
  return { level: TrustLevel.Derived, text, ...origin }
}

/**
 * Check a whole batch for promotion attempts before it reaches the model.
 *
 * Returns the offending entries rather than throwing, so a caller can report
 * "three of these 40 values claim to be policy" instead of dying on the first.
 */
export function findPromotions(items: readonly TrustedText[]): readonly string[] {
  const problems: string[] = []
  for (const item of items) {
    // Nothing forbids an external value from *existing*; the danger is a caller
    // that places it where an instruction is expected. That decision is made at
    // the assembly site, so all this can check is the value's own claim.
    if (item.level === TrustLevel.ExternalUntrusted && item.sourceType === undefined) {
      problems.push(
        `外部内容缺少来源类型（postId=${item.postId ?? '未知'}）：无法在报告里说明它是什么`,
      )
    }
    if (item.level === TrustLevel.Derived && item.postId !== undefined) {
      // Derived data that claims a single post id is suspicious: a summary spans
      // several posts, so a lone id usually means a raw comment was relabelled.
      problems.push(`派生数据声称来自单一帖子 ${item.postId}，可能是原始评论被当成了摘要`)
    }
  }
  return problems
}
