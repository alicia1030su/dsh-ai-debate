/**
 * JSON safety tests.
 *
 * These exist because a real install failed with "value is not lossless JSON"
 * while every unit test passed: the Host boundary rejects `undefined` object
 * properties, which TypeScript happily allows. The fix is `jsonSafe` applied at
 * the tool boundary, and this file pins its behaviour.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { jsonSafe } from '../lib/render.js'
import { buildTools } from '../lib/tools.js'
import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { FakeAdapter, threePartyThread } from './helpers.ts'
import type { Runtime } from '../lib/runtime.js'

/** A runtime over a throwaway store, enough to construct the tools. */
function makeRuntimeStub(): { runtime: Runtime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'debate-tools-'))
  const fixture = threePartyThread()
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  const runtime: Runtime = {
    adapter: new FakeAdapter(fixture),
    store: new DebateStore({ dir }),
    policy: {
      mode: 'manual',
      maxAutoPublishesPerSession: 0,
      cooldownMs: 0,
      maxPublishesPerThread: 10,
      stopOnChallenge: true,
    },
    config: () => config,
    llm: () => new ScriptedLlmClient([]),
    log: () => undefined,
  }
  return { runtime, dir }
}

/** The smallest context `buildTools` needs. */
function fakeContext() {
  return {
    tools: { register: () => () => undefined },
    systemPrompt: { section: () => () => undefined },
  } as never
}

/** Assert a value survives `JSON.stringify`/`parse` unchanged. */
function assertLossless(value: unknown, label: string): void {
  const safe = jsonSafe(value)
  const roundTripped = JSON.parse(JSON.stringify(safe))
  assert.deepEqual(roundTripped, safe, `${label} 不是无损 JSON`)
}

test('an undefined object property is dropped, not serialized as null', () => {
  const safe = jsonSafe({ a: 1, b: undefined, c: 'x' }) as Record<string, unknown>
  assert.deepEqual(Object.keys(safe).sort(), ['a', 'c'])
  assertLossless({ a: 1, b: undefined, c: 'x' }, '带 undefined 的对象')
})

test('an undefined array entry becomes null so indices stay stable', () => {
  const safe = jsonSafe([1, undefined, 3]) as unknown[]
  assert.deepEqual(safe, [1, null, 3])
})

test('nested undefined properties are dropped at every depth', () => {
  const input = {
    ok: true,
    dispute: { owner: { name: 'a', id: undefined }, opponent: null },
    list: [{ x: undefined, y: 2 }],
  }
  const safe = jsonSafe(input) as Record<string, unknown>
  assertLossless(input, '嵌套 undefined')
  const dispute = safe.dispute as Record<string, unknown>
  assert.deepEqual(Object.keys(dispute.owner as object), ['name'])
  assert.deepEqual(safe.list, [{ y: 2 }])
})

test('NaN and Infinity become null instead of invalid JSON', () => {
  const safe = jsonSafe({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 1.5 }) as Record<string, unknown>
  assert.deepEqual(safe, { a: null, b: null, c: 1.5 })
})

test('a Date becomes an ISO string', () => {
  const date = new Date('2026-10-26T00:00:00.000Z')
  assert.equal(jsonSafe({ at: date }).at, '2026-10-26T00:00:00.000Z')
})

test('a cycle is replaced by a marker instead of throwing', () => {
  const node = { name: 'a' } as { name: string; self?: unknown }
  node.self = node
  const safe = jsonSafe(node) as Record<string, unknown>
  assert.equal(safe.name, 'a')
  assert.equal(safe.self, '[circular]')
})

test('functions and symbols become null rather than breaking serialization', () => {
  const safe = jsonSafe({ fn: () => 1, sym: Symbol('x'), keep: 'yes' }) as Record<string, unknown>
  assert.deepEqual(safe, { fn: null, sym: null, keep: 'yes' })
})

test('bigint becomes a string', () => {
  assert.equal(jsonSafe({ big: 123n }).big, '123')
})

test('primitives pass through unchanged', () => {
  for (const value of ['text', 0, -1, true, false, null]) {
    assert.deepEqual(jsonSafe(value), value)
  }
})

test('a realistic analysis payload is lossless', () => {
  // The shape that actually failed: nested optional fields left undefined.
  const payload = {
    ok: true,
    sessionId: 's1',
    thread: { title: '', forumName: '吧', declaredReplyCount: 240, url: 'u' },
    dispute: {
      floorNumber: 1,
      needsConfirmation: false,
      owner: { name: 'a', key: 'k', posts: 3 },
      opponent: { name: 'b', key: 'b', posts: 2, lastPostId: 'p2' },
      evidence: { exchanges: 4, ownerRepliesTo: 2, repliesToOwner: 2, lastSpokeIndex: 5, otherActiveParticipants: [] },
      exchange: [{ postId: 'p', author: 'a', floor: 1, text: 't' }],
      openQuestions: [],
    },
    ownerClaims: ['claim'],
    participants: [{ displayName: 'a', postCount: 3, isOwner: true, isOpponent: false }],
    issues: [],
    securityNotes: [],
    // These are the fields that were undefined in the failing call.
    hint: undefined,
    error: undefined,
  }
  assertLossless(payload, '分析结果')
  const safe = jsonSafe(payload) as Record<string, unknown>
  assert.ok(!('hint' in safe))
  assert.ok(!('error' in safe))
})

test('the binding and persona tools say plainly that they did not persist anything', async () => {
  // The defect this guards: a tool that reads like "binding succeeded" while the
  // next run keeps using the old settings. Saying "preview, not saved" is the fix.
  const { runtime } = makeRuntimeStub()
  const tools = buildTools(runtime, fakeContext())
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const bind = await byName.get('debate_bind_owner')!.execute(
    { ownerUserId: '123456', aiAccountUserId: '654321' },
    {},
  )
  const bindValue = bind as { persisted?: boolean; settingsPath?: string; lines: string[] }
  assert.equal(bindValue.persisted, false, 'binding must not claim to have persisted')
  assert.ok(bindValue.settingsPath, 'it must name where to persist instead')
  assert.ok(
    bindValue.lines.some((line) => line.includes('没有写入配置')),
    `expected an explicit not-saved notice, got: ${bindValue.lines.join(' | ')}`,
  )
  assert.ok(bindValue.lines.some((line) => line.includes('ownerUserId = 123456')))

  const persona = await byName.get('debate_set_personality')!.execute({ style: 'aloof' }, {})
  const personaValue = persona as { persisted?: boolean; lines: string[] }
  assert.equal(personaValue.persisted, false)
  assert.ok(
    personaValue.lines.some((line) => line.includes('没有写入配置')),
    `expected a not-saved notice, got: ${personaValue.lines.join(' | ')}`,
  )
  assert.ok(personaValue.lines.some((line) => line.includes('personaStyle = aloof')))
})
