/**
 * The store must not silently drop fields it does not know about.
 *
 * ## The defect these lock down
 *
 * `prune()` builds a *new* document by hand:
 *
 * ```ts
 * return { version: 1, sessions, dedupe, usage }   // v0.2.4
 * ```
 *
 * Any field missing from that literal is erased by the very next write. `approvals`
 * was added in v0.2.5 and not carried over, so:
 *
 * 1. the settings page would create an approval record,
 * 2. the first `mutate()` after it — which includes `grantApproval` itself and every
 *    ledger write — replaced the document with one that had no `approvals`,
 * 3. and the publish path then looked for a record that demonstrably existed a
 *    moment earlier and found nothing.
 *
 * The symptom was a refusal saying "没有人工批准记录", which is *true of the document*
 * and false of what happened, so it sent the investigation after the approval logic
 * instead of after the persistence layer. `security` had the same bug since v0.2.3,
 * unnoticed because the panel re-reads from disk.
 *
 * ## Why this file exists separately
 *
 * These are not publisher tests and not settings tests: they are about the store
 * contract, and they have to keep passing whatever the two callers do. The
 * `PRESERVED_FIELDS` check is the part that prevents a *future* field from repeating
 * the mistake, which no behavioural test can do.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DebateStore, PRESERVED_FIELDS, emptyStore, type StoreData } from '../lib/store.js'
import type { ApprovalRecord } from '../lib/security/approvals.js'

/** A store backed by a fresh temporary directory. */
function tempStore(): { store: DebateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-store-fields-'))
  return { store: new DebateStore({ dir }), dir }
}

/** An approval record with the required binding fields and nothing else. */
function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: `ap-${Math.random().toString(36).slice(2)}`,
    sessionId: 's-1',
    candidateId: 's-1-c1',
    platform: 'tieba',
    targetPostId: 'n5',
    publishingAccount: '1001',
    textHash: 'a'.repeat(64),
    candidateVersion: 1,
    assessmentFingerprint: 'allow:aaaaaaaa:10',
    grantedBy: 'owner',
    grantedAt: new Date().toISOString(),
    ...overrides,
  }
}

test('an approval survives the mutate that created it', async () => {
  // The exact shape that failed: the write that adds the record runs `prune()` on the
  // result, and the old `prune()` dropped the field.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    const record = approval()

    await store.mutate((data) => ({ ...data, approvals: [...(data.approvals ?? []), record] }))

    assert.equal(store.getApprovals().length, 1, 'the record must still be in memory after the write')
    assert.equal(store.getApprovals()[0]!.id, record.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an approval survives an unrelated later write', async () => {
  // The second write is what actually erased things in the field: the publish path
  // writes its ledger row before sending, so the record was gone before the check.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    const record = approval()
    await store.mutate((data) => ({ ...data, approvals: [record] }))

    await store.mutate((data) => ({ ...data, usage: [...data.usage] }))

    assert.equal(store.getApprovals().length, 1, 'an unrelated write must not drop the approval')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an approval survives a store reload', async () => {
  // Persistence is the point: the record has to be on disk, not just in memory.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    const record = approval()
    await store.mutate((data) => ({ ...data, approvals: [record] }))

    const reopened = new DebateStore({ dir })
    await reopened.ready()

    assert.equal(reopened.getApprovals().length, 1, 'the reloaded store must still have the approval')
    assert.equal(reopened.getApprovals()[0]!.id, record.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a security event survives the next write', async () => {
  // The same latent bug, present since v0.2.3 and hidden because the settings panel
  // reads through a different path.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    await store.appendSecurityEvent(
      {
        id: 'ev-1',
        at: new Date().toISOString(),
        kind: 'injection',
        severity: 'medium',
        summary: '外部评论试图指示模型发表',
      },
      50,
    )
    assert.equal(store.getSecurityEvents().length, 1, 'appended before the write')

    await store.mutate((data) => ({ ...data, usage: [...data.usage] }))

    assert.equal(store.getSecurityEvents().length, 1, 'an unrelated write must not drop the event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the on-disk document keeps both fields', async () => {
  // Checking the in-memory document is not enough: `prune()` returning the field but
  // `persist()` writing a different object would pass every test above.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    await store.mutate((data) => ({ ...data, approvals: [approval()] }))
    await store.appendSecurityEvent(
      { id: 'ev-2', at: new Date().toISOString(), kind: 'blocked', severity: 'low', summary: '已阻止' },
      50,
    )

    const written = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as StoreData
    assert.equal(written.approvals?.length, 1, 'the file must contain the approval')
    assert.equal(written.security?.length, 1, 'the file must contain the security event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a consumed approval stays consumed across a reload', async () => {
  // Consumption is the one-way ratchet that stops a double post, so it has to be as
  // durable as the record itself.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    const record = approval({ consumedAt: new Date().toISOString() })
    await store.mutate((data) => ({ ...data, approvals: [record] }))
    await store.mutate((data) => ({ ...data, usage: [...data.usage] }))

    const reopened = new DebateStore({ dir })
    await reopened.ready()

    assert.equal(reopened.getApprovals()[0]!.consumedAt, record.consumedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PRESERVED_FIELDS covers every key of a store document', async () => {
  // The guard against the next field. `prune()` has to decide what happens to each
  // field, and this fails when a new one is added to `StoreData` without that
  // decision being recorded — which is exactly the omission that caused the bug.
  const { store, dir } = tempStore()
  try {
    await store.ready()
    const keys = Object.keys(emptyStore()).sort()
    assert.deepEqual(
      [...PRESERVED_FIELDS].sort(),
      keys,
      'PRESERVED_FIELDS must list every StoreData field; add the new one to prune() too',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pruned write keeps approvals even while sessions expire', async () => {
  // Both halves at once: a session old enough to be dropped, and an approval that
  // must outlive it. The approval is not tied to session lifetime — an owner can
  // approve a candidate and the session may be reaped before they publish.
  const dir = mkdtempSync(join(tmpdir(), 'dsd-store-prune-'))
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 1 })
    await store.ready()
    const stale = new Date('2020-01-01T00:00:00Z').toISOString()
    await store.mutate((data) => ({
      ...data,
      sessions: [
        {
          id: 'old',
          platform: 'tieba',
          threadId: 't',
          threadUrl: 'https://tieba.baidu.com/p/t',
          threadTitle: 't',
          forumName: 'f',
          ownerKey: 'o',
          ownerName: '主人',
          opponentKey: 'b',
          opponentName: '对手',
          opponentUserId: 'b',
          disputeFloorPostId: 'n1',
          disputeFloorNumber: 1,
          triggerPostId: 'n7',
          targetKind: 'nested',
          state: 'PUBLISHED',
          statusText: '已发表',
          persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
          candidates: [],
          publishedPostIds: ['p'],
          sentTexts: [],
          createdAt: stale,
          updatedAt: stale,
        },
      ],
      approvals: [approval()],
    }))

    assert.equal(store.snapshot().sessions.length, 0, 'the expired session should be pruned')
    assert.equal(store.getApprovals().length, 1, 'the approval must not be pruned with it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
