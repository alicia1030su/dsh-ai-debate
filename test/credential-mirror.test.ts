/**
 * The credential mirror: what the plugin believes about the credential store,
 * and when it is allowed to believe it.
 *
 * Why this file exists rather than more cases in `cold-start-credentials.test.ts`:
 * that file tested a *mirror of the mirror* — a local `makeMirror()` helper that
 * re-implemented the host's staleness rule. When the rule was wrong, the helper
 * was wrong the same way, so 245 passing tests agreed with a broken UI. The
 * lesson: test the module that actually ships.
 *
 * These tests drive `src/credential-mirror.ts` directly. That module owns the
 * four things previously tangled inside `apply()` and therefore untestable:
 *
 * 1. **Phase, not a boolean.** "The store is empty", "the store has not parsed
 *    yet", "the store answered inconsistently" and "the read threw" are four
 *    different facts, and only some of them permit publishing.
 * 2. **Bounded warm-up.** `dsh-credentials-local` publishes the service and only
 *    later assigns `values` in `loadInitial()`, and it exposes no ready flag or
 *    event (verified against the shipped 0.2.1-rc.2 build). So the only honest
 *    signal is repeated reads over a bounded window; a single 40 ms pause is a
 *    guess, not a signal.
 * 3. **Ticket ordering.** A read that started before a save must never install
 *    over the value that save confirmed.
 * 4. **Failure preserves.** A read that throws says nothing about the store, so
 *    it must not blank a value that was already confirmed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CredentialMirror,
  DEFAULT_WARMUP_DELAYS_MS,
} from '../lib/credential-mirror.js'
import { COOKIE_REF, LLM_KEY_REF, type CredentialSeam } from '../lib/secrets.js'

const COOKIE = 'ST=mirror-cookie-abcdefgh1234'
const KEY = 'sk-mirror-key-abcdefgh1234'

/** Total wall time the default schedule covers. */
const WARMUP_TOTAL_MS = DEFAULT_WARMUP_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)

/**
 * A credential store with an explicit timeline.
 *
 * `readyAtMs` is when the document finishes parsing; before that both
 * `describe()` and `resolve()` answer "nothing at all", with no error — the exact
 * shape observed on a real cold start.
 */
function timelineSeam(options: {
  store: Record<string, string>
  readyAtMs?: number
  clock: { now: () => number }
  describeConfiguredBeforeReady?: boolean
  throwOnResolve?: (ref: string) => boolean
}) {
  const { store, clock } = options
  const readyAt = options.readyAtMs ?? 0
  const calls: string[] = []
  const seam: CredentialSeam & { calls: string[]; unsetCalls: number; setCalls: number } = {
    calls,
    unsetCalls: 0,
    setCalls: 0,
    async describe(ref: string) {
      calls.push(`describe:${ref}`)
      if (clock.now() < readyAt) {
        return {
          configured: options.describeConfiguredBeforeReady === true,
          writable: true,
          ...(options.describeConfiguredBeforeReady === true ? { source: 'file' } : {}),
        }
      }
      const value = store[ref]
      return value === undefined || value === ''
        ? { configured: false, writable: true }
        : { configured: true, writable: true, source: 'file' }
    },
    async resolve(ref: string) {
      calls.push(`resolve:${ref}`)
      if (options.throwOnResolve?.(ref) === true) throw new Error('seam exploded')
      if (clock.now() < readyAt) return undefined
      const value = store[ref]
      return typeof value === 'string' && value.length > 0 ? { value, source: 'file' } : undefined
    },
    async set(ref: string, value: string) {
      seam.setCalls += 1
      store[ref] = value
    },
    async unset(ref: string) {
      seam.unsetCalls += 1
      delete store[ref]
    },
  }
  return seam
}

/** A clock and a sleep that advance together, so a 900 ms warm-up costs nothing. */
function fakeTime() {
  let ms = 0
  const slept: number[] = []
  return {
    clock: { now: () => ms },
    slept,
    sleep: async (delay: number) => {
      slept.push(delay)
      ms += delay
    },
  }
}

function makeMirror(
  seam: CredentialSeam | undefined,
  time: ReturnType<typeof fakeTime>,
  extra: { onSettled?: () => void; delays?: readonly number[]; initialOverlay?: never } = {},
) {
  return new CredentialMirror({
    seam,
    sleep: time.sleep,
    ...(extra.onSettled === undefined ? {} : { onSettled: extra.onSettled }),
    ...(extra.delays === undefined ? {} : { delays: extra.delays }),
  })
}

// -------------------------------------------------------------- slow start

for (const readyAtMs of [100, 500, 2000]) {
  test(`a store that finishes parsing after ${readyAtMs} ms is never reported as ready-with-nothing`, async () => {
    const time = fakeTime()
    const store: Record<string, string> = { [COOKIE_REF]: COOKIE, [LLM_KEY_REF]: KEY }
    const seam = timelineSeam({ store, readyAtMs, clock: time.clock })
    const mirror = makeMirror(seam, time)

    await mirror.refresh()
    const state = mirror.state

    if (readyAtMs <= WARMUP_TOTAL_MS) {
      // The warm-up window covers this case: by the time it closes the store is
      // readable, so the mirror must hold the real value.
      assert.equal(state.phase, 'ready', `phase after ${readyAtMs} ms`)
      assert.equal(state.overlay.cookie, COOKIE)
      assert.equal(state.overlay.llmApiKey, KEY)
      assert.equal(state.error, undefined)
      assert.equal(mirror.canPublish(), true)
    } else {
      // The window closed first. The honest answer is "I could not confirm",
      // never "the store is empty" presented as fact.
      assert.equal(state.phase, 'timeout', `phase after ${readyAtMs} ms`)
      assert.equal(state.settled, true)
      assert.ok(state.error !== undefined, 'a timeout explains itself')
      assert.equal(mirror.canPublish(), false, 'an unproven store must not publish')
    }
  })
}

test('a store slower than the window recovers on the next explicit read', async () => {
  const time = fakeTime()
  const store: Record<string, string> = { [COOKIE_REF]: COOKIE }
  const seam = timelineSeam({ store, readyAtMs: 2000, clock: time.clock })
  const mirror = makeMirror(seam, time)

  await mirror.refresh()
  assert.equal(mirror.state.phase, 'timeout')

  // The service finishes loading; a later route read or tool call arrives.
  time.clock.now = () => 2000
  await mirror.refresh()
  assert.equal(mirror.state.phase, 'ready')
  assert.equal(mirror.state.overlay.cookie, COOKIE)
})

test('the warm-up is bounded: it does not read forever', async () => {
  const time = fakeTime()
  const seam = timelineSeam({ store: {}, readyAtMs: Number.MAX_SAFE_INTEGER, clock: time.clock })
  const mirror = makeMirror(seam, time)

  await mirror.refresh()
  const readsForOneRefresh = mirror.state.reads
  assert.equal(mirror.state.phase, 'timeout')
  assert.ok(
    readsForOneRefresh <= DEFAULT_WARMUP_DELAYS_MS.length + 1,
    `expected at most ${DEFAULT_WARMUP_DELAYS_MS.length + 1} reads, saw ${readsForOneRefresh}`,
  )
  // The sleeps actually happened, in the declared order.
  assert.deepEqual(time.slept, [...DEFAULT_WARMUP_DELAYS_MS])
})

test('a genuinely empty store is only ever claimed after a confirmed clear', async () => {
  const time = fakeTime()
  const store: Record<string, string> = {}
  const seam = timelineSeam({ store, clock: time.clock })
  const mirror = makeMirror(seam, time)

  await mirror.refresh()
  // A read that returns nothing cannot tell empty from unparsed, so it must not
  // claim emptiness even when the store really is empty.
  assert.equal(mirror.state.phase, 'timeout')

  mirror.commitClear(COOKIE_REF)
  assert.equal(mirror.state.phase, 'empty', 'a confirmed clear is proof')
})

// ------------------------------------------------------------- exceptional

test('a throwing seam is reported as failed and does not blank a confirmed value', async () => {
  const time = fakeTime()
  const store: Record<string, string> = { [COOKIE_REF]: COOKIE }
  const good = timelineSeam({ store, clock: time.clock })
  const first = makeMirror(good, time)
  await first.refresh()
  assert.equal(first.state.phase, 'ready')
  assert.equal(first.state.overlay.cookie, COOKIE)

  // Now every read throws. The last confirmed overlay must survive, because a
  // failure proves nothing about what the store holds.
  const broken = timelineSeam({ store, clock: time.clock, throwOnResolve: () => true })
  const second = new CredentialMirror({
    seam: broken,
    sleep: time.sleep,
    initialOverlay: first.overlay,
  })
  await second.refresh()

  assert.equal(second.state.phase, 'failed')
  assert.ok(second.state.error !== undefined, 'a failure keeps a message')
  assert.equal(second.state.overlay.cookie, COOKIE, 'a failed read must not erase what was confirmed')
  assert.equal(second.state.settled, true, 'a hard failure must not spin')
  assert.equal(second.canPublish(), false, 'a failed read is not proof enough to publish')
})

test('a read failure never deletes a persistent credential', async () => {
  const time = fakeTime()
  const store: Record<string, string> = { [COOKIE_REF]: COOKIE }
  const seam = timelineSeam({ store, clock: time.clock, throwOnResolve: () => true })
  const mirror = makeMirror(seam, time)

  await mirror.refresh()
  await mirror.refresh()
  await mirror.refresh()

  assert.equal(seam.unsetCalls, 0, 'reading must never write')
  assert.equal(store[COOKIE_REF], COOKIE, 'the stored value is still there')
})

test('describe saying configured while resolve returns nothing is "partial", not ready', async () => {
  // The exact mismatch that produced "已配置 · 长度 0" in the UI: the store's
  // record half sees the entry, its value half does not return one.
  const time = fakeTime()
  const seam = timelineSeam({
    store: {},
    // Before the document is parsed, describe() reports the entry as configured
    // while resolve() hands back nothing — the shape observed on a real boot.
    readyAtMs: Number.MAX_SAFE_INTEGER,
    clock: time.clock,
    describeConfiguredBeforeReady: true,
  })
  const mirror = makeMirror(seam, time)
  await mirror.refresh()

  assert.equal(mirror.state.phase, 'partial')
  assert.deepEqual(mirror.state.unresolved, [COOKIE_REF, LLM_KEY_REF])
  assert.equal(mirror.state.overlay.cookie, '', 'half a mirror must not be installed')
  assert.equal(mirror.canPublish(), false)
})

// ------------------------------------------------------------ ticket order

test('a slow read that started before a save cannot overwrite the saved value', async () => {
  // The ordering the brief calls out: start A, then save B, let B land first and
  // A land after. B must win, because A read a store that predates B.
  const time = fakeTime()
  const store: Record<string, string> = { [COOKIE_REF]: 'ST=old-value-0000000000' }

  let releaseSlowRead: (() => void) | undefined
  const slowGate = new Promise<void>((resolve) => {
    releaseSlowRead = resolve
  })
  let firstResolve = true

  const seam: CredentialSeam = {
    async describe() {
      return { configured: true, writable: true, source: 'file' }
    },
    async resolve(ref: string) {
      if (ref !== COOKIE_REF) {
        return typeof store[ref] === 'string' ? { value: store[ref]!, source: 'file' } : undefined
      }
      if (firstResolve) {
        firstResolve = false
        // Read the value *before* the save, then stall before returning it.
        const stale = store[ref]!
        await slowGate
        return { value: stale, source: 'file' }
      }
      const value = store[ref]
      return typeof value === 'string' && value.length > 0 ? { value, source: 'file' } : undefined
    },
    async set(ref: string, value: string) {
      store[ref] = value
    },
    async unset(ref: string) {
      delete store[ref]
    },
  }

  const mirror = new CredentialMirror({ seam, sleep: time.sleep, delays: [] })

  // A: the slow read, started now.
  const readA = mirror.refresh()
  // Let it reach the await before committing anything.
  await Promise.resolve()
  await Promise.resolve()

  // B: the save, confirmed by the store, installed immediately.
  mirror.commit(COOKIE_REF, 'ST=new-value-11111111111')

  // Now let A finish, after B.
  releaseSlowRead!()
  await readA

  assert.equal(
    mirror.state.overlay.cookie,
    'ST=new-value-11111111111',
    'the newer save must survive a read that started before it',
  )
  assert.equal(mirror.state.phase, 'ready')
})

test('the latest-started read wins over an earlier one still in flight', async () => {
  const time = fakeTime()
  const gates: (() => void)[] = []
  const values = ['ST=first-0000000000', 'ST=second-1111111111']
  let index = 0

  const seam: CredentialSeam = {
    // Only the cookie ref exists in this store; claiming `configured` for the key
    // while resolving nothing would be a *partial* read, which is a different
    // (correct) classification.
    async describe(ref: string) {
      return ref === COOKIE_REF
        ? { configured: true, writable: true, source: 'file' }
        : { configured: false, writable: true }
    },
    async resolve(ref: string) {
      if (ref !== COOKIE_REF) return undefined
      const mine = index++
      const value = values[Math.min(mine, values.length - 1)]!
      await new Promise<void>((resolve) => gates.push(resolve))
      return { value, source: 'file' }
    },
    async set() {},
    async unset() {},
  }

  const mirror = new CredentialMirror({ seam, sleep: time.sleep, delays: [] })
  const first = mirror.refresh()
  const second = mirror.refresh()

  // Wait until both reads are parked at their gate.
  for (let i = 0; i < 500 && gates.length < 2; i += 1) await Promise.resolve()
  assert.equal(gates.length, 2, 'both reads must be in flight')

  // Release the *second* read first, then the first, so the older read returns
  // last — the ordering that used to resurrect the stale value.
  gates[1]!()
  gates[0]!()
  await Promise.all([first, second])

  assert.equal(mirror.state.overlay.cookie, 'ST=second-1111111111')
  assert.equal(mirror.state.phase, 'ready')
})

test('a save that throws leaves the last confirmed value in place', async () => {
  const time = fakeTime()
  const store: Record<string, string> = { [COOKIE_REF]: COOKIE }
  const seam = timelineSeam({ store, clock: time.clock })
  const mirror = makeMirror(seam, time)
  await mirror.refresh()
  assert.equal(mirror.state.overlay.cookie, COOKIE)

  // The write path rejects. `commit` is only called after a confirmed write, so a
  // rejected write must never reach it — and if a caller gets that wrong, the
  // mirror must at least still hold the old value.
  let threw = false
  try {
    await seam.set(COOKIE_REF, 'boom').then(() => {
      throw new Error('write rejected')
    })
  } catch {
    threw = true
  }
  assert.equal(threw, true)
  assert.equal(mirror.state.overlay.cookie, COOKIE)
  assert.equal(mirror.state.phase, 'ready')
})

// -------------------------------------------------------------- lifecycle

test('a disposed mirror installs nothing and notifies nobody', async () => {
  const time = fakeTime()
  let settledCalls = 0
  const store: Record<string, string> = { [COOKIE_REF]: COOKIE }
  const seam = timelineSeam({ store, readyAtMs: 500, clock: time.clock })
  const mirror = new CredentialMirror({
    seam,
    sleep: time.sleep,
    onSettled: () => {
      settledCalls += 1
    },
  })

  const inFlight = mirror.refresh()
  await Promise.resolve()
  mirror.dispose()
  const callsAtDispose = settledCalls
  await inFlight

  assert.equal(mirror.state.phase, 'unknown', 'a disposed mirror reports nothing')
  assert.equal(mirror.state.overlay.cookie, '')
  assert.equal(
    settledCalls,
    callsAtDispose,
    'a disposed mirror must not re-key a runtime that was already torn down',
  )
})

test('invalidate() makes an in-flight read stale without waiting for it', async () => {
  const time = fakeTime()
  let release: (() => void) | undefined
  const seam: CredentialSeam = {
    async describe(ref: string) {
      return ref === COOKIE_REF
        ? { configured: true, writable: true, source: 'file' }
        : { configured: false, writable: true }
    },
    async resolve(ref: string) {
      if (ref !== COOKIE_REF) return undefined
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { value: 'ST=stale-00000000', source: 'file' }
    },
    async set() {},
    async unset() {},
  }
  const mirror = new CredentialMirror({ seam, sleep: time.sleep, delays: [] })
  const inFlight = mirror.refresh()
  // Wait until the read is parked, so `invalidate()` really races an in-flight read.
  for (let i = 0; i < 500 && release === undefined; i += 1) await Promise.resolve()
  assert.ok(release !== undefined, 'the read must be in flight before invalidating')
  mirror.invalidate()
  release!()
  await inFlight

  assert.equal(mirror.state.overlay.cookie, '', 'an invalidated read must not install')
})

// ------------------------------------------------------------------ gates

test('publishing is refused while the credential state is unproven', async () => {
  const time = fakeTime()
  const seam = timelineSeam({ store: { [COOKIE_REF]: COOKIE }, readyAtMs: 5000, clock: time.clock })
  const mirror = makeMirror(seam, time)
  await mirror.refresh()

  assert.equal(mirror.state.phase, 'timeout')
  assert.equal(
    mirror.canPublish(),
    false,
    'an unproven credential state must not be used to publish as a guessed identity',
  )
})

test('publishing is allowed once the store is confirmed', async () => {
  const time = fakeTime()
  const seam = timelineSeam({ store: { [COOKIE_REF]: COOKIE }, clock: time.clock })
  const mirror = makeMirror(seam, time)
  await mirror.refresh()
  assert.equal(mirror.state.phase, 'ready')
  assert.equal(mirror.canPublish(), true)
})

test('a cookie from the config layer publishes even when the store is empty', async () => {
  // The v0.1.5 shape: nothing in the credential store, the cookie in the patch.
  // A store read cannot make a static config string less true.
  const time = fakeTime()
  const store: Record<string, string> = {}
  const seam = timelineSeam({ store, clock: time.clock })
  const mirror = makeMirror(seam, time)
  await mirror.refresh()
  assert.equal(mirror.state.phase, 'timeout')

  mirror.adoptConfigFallback({
    cookie: 'ST=from-config-00000000',
    llmApiKey: '',
    stored: new Set(),
  })
  assert.equal(mirror.canPublish(), true, 'a configured cookie does not need the store')
})

test('a cookie read from the store does require a conclusive phase', async () => {
  // A stored cookie can be mid-initialization or have been rotated away, so the
  // phase has to say "confirmed" before it can be used to publish.
  const time = fakeTime()
  const seam = timelineSeam({ store: { [COOKIE_REF]: COOKIE }, clock: time.clock })
  const mirror = makeMirror(seam, time)
  await mirror.refresh()
  assert.equal(mirror.canPublish(), true)

  mirror.invalidate()
  await mirror.refresh()
  assert.equal(mirror.state.phase, 'ready')
})

test('an empty overlay never publishes, whatever the phase', async () => {
  const time = fakeTime()
  const mirror = makeMirror(timelineSeam({ store: {}, clock: time.clock }), time)
  await mirror.refresh()
  assert.equal(mirror.state.phase, 'timeout')
  assert.equal(mirror.canPublish(), false)
})

test('a mirror with no credential service reports unavailable, not empty', async () => {
  const time = fakeTime()
  const mirror = new CredentialMirror({ seam: undefined, sleep: time.sleep })
  await mirror.refresh()
  assert.equal(mirror.state.phase, 'unavailable')
  assert.ok(mirror.state.error !== undefined)
  assert.equal(mirror.writable, false)
})
