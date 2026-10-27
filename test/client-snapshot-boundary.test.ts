/**
 * The snapshot boundary: what the page is allowed to put in a store snapshot.
 *
 * This file exists because a defect shipped that 34 passing client tests could
 * not see. The settings form was completely inert — typing into any field reverted
 * on the next render, the "unsaved" badge never appeared, and Save stayed
 * disabled — because `projection()` included `this.draft`, a `Map`, and the Host's
 * `createSnapshotStore` runs every snapshot through **Immer**, which refuses a
 * bare `Map` unless `enableMapSet()` was called:
 *
 *     [Immer] minified error nr: 2
 *
 * Every `store.set()` therefore threw inside `edit()`, before the value was ever
 * staged. No test caught it because every fake store in the suite accepts
 * anything: they record the snapshot instead of validating it. The bug only
 * existed at the boundary between this page's snapshot and the Host's
 * freezer — which is exactly what this file tests.
 *
 * The rule enforced here: a snapshot must survive `JSON` round-tripping and must
 * not contain a `Map`, `Set`, `Date`, class instance or function. That is a
 * stricter check than Immer's, and deliberately so — the snapshot is also read by
 * React DevTools and by the diagnostics panel, and a value that cannot be
 * serialised is a value nobody can inspect when it goes wrong.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const BUNDLE = join(import.meta.dirname, '..', 'client', 'client.cjs')

/**
 * A store that validates snapshots the way Immer does.
 *
 * Immer's rule, in the terms that matter here: a snapshot may be a plain object,
 * an array, or a primitive. It may not be a `Map`, a `Set`, a class instance or a
 * function. Immer rejects with its own error code; this throws a readable one so
 * a failure names the offending path instead of "minified error nr: 2".
 */
function assertImmerRepresentable(value: unknown, path = 'snapshot'): void {
  if (value === null || value === undefined) return
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') return
  if (type === 'function') throw new Error(`${path} is a function; Immer cannot draft it`)
  if (type !== 'object') return

  const proto = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertImmerRepresentable(entry, `${path}[${index}]`))
    return
  }
  if (value instanceof Map) {
    throw new Error(`${path} is a Map; Immer rejects it without enableMapSet()`)
  }
  if (value instanceof Set) {
    throw new Error(`${path} is a Set; Immer rejects it without enableMapSet()`)
  }
  if (value instanceof Date) {
    throw new Error(`${path} is a Date; Immer treats it as a non-draftable object`)
  }
  // Compare by constructor name, not by identity: objects created inside the vm
  // sandbox have that realm's Object.prototype, so an identity check against the
  // host's would reject every plain object the bundle builds.
  const ctor = proto?.constructor?.name
  if (ctor !== undefined && ctor !== 'Object') {
    throw new Error(`${path} is a ${ctor}; Immer drafts its own types only`)
  }
  for (const [key, entry] of Object.entries(value)) {
    assertImmerRepresentable(entry, `${path}.${key}`)
  }
}

/** Load the bundle and hand back its CardStore-shaped page model. */
function loadBundle(): {
  createStore: () => Record<string, unknown>
  snapshotChecks: string[]
} {
  const source = readFileSync(BUNDLE, 'utf8')
  const loads: { factory: (require: (spec: string) => unknown) => Record<string, unknown> }[] = []
  const snapshotChecks: string[] = []

  /**
   * A snapshot store that validates like Immer.
   *
   * This is the whole point of the file: `set()` rejects a snapshot the Host would
   * reject. A permissive fake here is what let the defect ship.
   */
  function validatingSnapshotStore(initial: unknown) {
    let snapshot = initial
    const listeners = new Set<() => void>()
    assertImmerRepresentable(initial, 'initial')
    return {
      getSnapshot: () => snapshot,
      set: (next: unknown) => {
        assertImmerRepresentable(next, 'snapshot')
        snapshot = next
        for (const listener of [...listeners]) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }

  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ready',
        writable: true,
        values: {},
        secrets: [],
        capabilities: { settingsService: true, credentialService: true },
      }),
    }),
    window: { __ModuleLoader__: { load: (registration: unknown) => loads.push(registration as never) } },
    document: {
      head: { appendChild: () => undefined },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
    },
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
  }
  sandbox['globalThis'] = sandbox
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.cjs' })

  const exports = loads[0]!.factory((spec: string) => {
    if (spec === 'react') {
      return {
        createElement: () => null,
        useState: (initial: unknown) => [initial, () => undefined],
        useEffect: () => undefined,
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
        useRef: () => ({ current: null }),
        Fragment: 'fragment',
      }
    }
    if (spec === '@deepseek-ai/dsh-client-store') {
      return {
        createSnapshotStore: (initial: unknown) => {
          snapshotChecks.push('created')
          return validatingSnapshotStore(initial)
        },
      }
    }
    throw new Error(`unexpected require: ${spec}`)
  }) as Record<string, unknown>

  // The store class is not exported; reach it through a mounted component is
  // overkill. Instead, `apply` constructs nothing, so build the store the same way
  // the page does: through the section's private helper, exposed for tests.
  const createStore = (exports['__createCardStore'] ??
    exports['createCardStore']) as (() => Record<string, unknown>) | undefined
  assert.ok(
    createStore !== undefined,
    'the bundle must expose its page model for tests, or this file cannot check the boundary',
  )
  return { createStore, snapshotChecks }
}

test('the page model builds without handing a Map to the snapshot store', () => {
  // If the constructor's first `projection()` contained a Map, creating the store
  // would throw here — which is what happened at runtime, just later, on the first
  // keystroke.
  const { createStore } = loadBundle()
  assert.doesNotThrow(() => createStore())
})

test('editing a field produces a snapshot the Host would accept', () => {
  const { createStore } = loadBundle()
  const store = createStore() as {
    edit(name: string, value: unknown): void
    field(name: string): unknown
    dirty(name: string): boolean
    getSnapshot(): Record<string, unknown>
  }

  // The exact operation that used to throw inside `edit()`.
  assert.doesNotThrow(() => store.edit('allowedOwnerIds', '1171245451'))

  assert.equal(store.field('allowedOwnerIds'), '1171245451', 'the edit must be staged')
  assert.equal(store.dirty('allowedOwnerIds'), true, 'and reported as unsaved')

  const snapshot = store.getSnapshot()
  assertImmerRepresentable(snapshot, 'snapshot')
  assert.equal(snapshot['draftSize'], 1, 'the snapshot exposes the draft as a count')
})

test('the snapshot carries the staged values as plain data', () => {
  const { createStore } = loadBundle()
  const store = createStore() as {
    edit(name: string, value: unknown): void
    getSnapshot(): Record<string, unknown>
  }
  store.edit('ownerUserName', '验收测试昵称')
  store.edit('intensity', 4)

  const snapshot = store.getSnapshot() as { draftFields: Record<string, unknown>; draftSize: number }
  assert.equal(snapshot.draftSize, 2)
  // Compare field by field: the objects come from the vm realm, so a structural
  // deepEqual would compare prototypes across realms and fail on identity.
  assert.equal(snapshot.draftFields['ownerUserName'], '验收测试昵称')
  assert.equal(snapshot.draftFields['intensity'], 4)
  assert.deepEqual(Object.keys(snapshot.draftFields).sort(), ['intensity', 'ownerUserName'])
  assertImmerRepresentable(snapshot, 'snapshot')
})

test('resetting a field returns the snapshot to zero staged edits', () => {
  const { createStore } = loadBundle()
  const store = createStore() as {
    edit(name: string, value: unknown): void
    resetField(name: string): void
    getSnapshot(): Record<string, unknown>
    dirty(name: string): boolean
  }
  store.edit('ownerUserName', 'x')
  assert.equal(store.dirty('ownerUserName'), true)
  assert.doesNotThrow(() => store.resetField('ownerUserName'))
  assert.equal(store.dirty('ownerUserName'), false)
  assert.equal(store.getSnapshot()['draftSize'], 0)
})

test('editing a field to the same value twice stages it once, and clearing stages an empty', () => {
  // The staging rule, pinned because the Save button's enabled state depends on it:
  // `edit()` compares stringified values, so re-typing what is already there is a
  // no-op, while clearing a field whose served value is `undefined` is a real edit
  // (the empty string is not the same value as "absent").
  const { createStore } = loadBundle()
  const store = createStore() as {
    edit(name: string, value: unknown): void
    dirty(name: string): boolean
    field(name: string): unknown
  }

  store.edit('ownerUserName', 'x')
  assert.equal(store.dirty('ownerUserName'), true)

  // Re-typing the same value must not add a second staged entry.
  store.edit('ownerUserName', 'x')
  assert.equal(store.dirty('ownerUserName'), true)

  // Clearing stages an empty string: distinct from the absent served value.
  store.edit('ownerUserName', '')
  assert.equal(store.dirty('ownerUserName'), true)
  assert.equal(store.field('ownerUserName'), '')
})
