/**
 * Route registration against a webserver that arrives late.
 *
 * The bug this file pins: resolving `webServer` once with `ctx.get` at mount time
 * answers a question about one instant. In a profile where the webserver activates
 * *after* this plugin, that instant predates the service, and a one-shot probe
 * loses the routes for the whole process lifetime. Nothing throws, the tools keep
 * working, and only the configuration page 404s — which is precisely the kind of
 * failure that survives a green test suite and reaches a user.
 *
 * Cordis' answer is `ctx.inject(deps, fn)`: run `fn` when the service is active,
 * again if it is replaced, and scope the cleanup. These tests drive that contract
 * with a fake context that can activate `webServer` late, drop it, and restart it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** A context whose `inject` callbacks are held until the test activates the service. */
interface Harness {
  ctx: Record<string, unknown>
  /** Services currently active, by name. */
  active: Map<string, unknown>
  /** Run every queued injection whose deps are now satisfied. */
  activate(): number
  /** Registered routes, in registration order. */
  routes: { kind: string; path: string }[]
  /** Labels of the effects the injected scopes created. */
  effectLabels: string[]
  /** Drop the service and run the scope disposers, as Cordis does on unload. */
  deactivate(): void
  /** How many injection callbacks have run so far. */
  runs(): number
}

function makeHarness(options: { registerThrows?: boolean } = {}): Harness {
  const active = new Map<string, unknown>()
  const routes: { kind: string; path: string }[] = []
  const effectLabels: string[] = []
  let runs = 0
  const pending: { deps: string[]; fn: (scope: unknown) => void; disposers: (() => void)[] }[] = []

  const webServer = {
    register(route: { kind: string; path: string }) {
      if (options.registerThrows === true) throw new Error('duplicate route path')
      routes.push({ kind: route.kind, path: route.path })
      return () => {
        const index = routes.findIndex((row) => row.path === route.path)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const ctx: Record<string, unknown> = {
    tools: { register: () => () => undefined },
    systemPrompt: { section: () => () => undefined },
    logger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }),
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
    get: (name: string) => active.get(name),
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      const slot = { deps, fn, disposers: [] as (() => void)[] }
      pending.push(slot)
      // Cordis runs the callback immediately when the dependency is already
      // active; otherwise it waits. Both branches must be exercised, so the
      // decision is made here rather than at registration time.
      if (deps.every((dep) => active.has(dep))) run(slot)
    },
  }

  function run(slot: { deps: string[]; fn: (scope: unknown) => void; disposers: (() => void)[] }): void {
    runs += 1
    const scope = {
      get: (name: string) => active.get(name),
      effect: (callback: () => (() => void) | void, label?: string) => {
        if (label !== undefined) effectLabels.push(label)
        const dispose = callback()
        const disposer = typeof dispose === 'function' ? dispose : () => undefined
        slot.disposers.push(disposer)
        return disposer
      },
    }
    slot.fn(scope)
  }

  return {
    ctx,
    active,
    routes,
    effectLabels,
    runs: () => runs,
    activate() {
      let started = 0
      for (const slot of pending) {
        if (slot.disposers.length > 0) continue
        if (!slot.deps.every((dep) => active.has(dep))) continue
        run(slot)
        started += 1
      }
      return started
    },
    deactivate() {
      for (const slot of pending) {
        for (const dispose of slot.disposers.splice(0)) dispose()
      }
    },
  }
}

/** Mount the plugin against a harness and return the disposer for the whole plugin. */
async function mount(harness: Harness): Promise<() => void> {
  const module = (await import('../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): void | (() => void)
  }
  const config = {
    enabled: true,
    ownerUserName: '',
    ownerUserId: '',
    aiAccountName: '',
    aiAccountUserId: '',
    storeDir: '',
  }
  // The real entry point; a returned function is the plugin's own disposer.
  const dispose = module.apply(harness.ctx as never, config as never)
  return typeof dispose === 'function' ? dispose : () => undefined
}

test('routes register immediately when the webserver is already active', async () => {
  const harness = makeHarness()
  harness.active.set('webServer', { register: () => () => undefined })
  // Replace with the recording server, still active before mount.
  harness.active.set('webServer', {
    register(route: { kind: string; path: string }) {
      harness.routes.push({ kind: route.kind, path: route.path })
      return () => undefined
    },
  })
  const dispose = await mount(harness)
  assert.ok(harness.routes.length >= 4, `expected the route family, got ${harness.routes.length}`)
  const paths = harness.routes.map((row) => row.path)
  assert.ok(paths.includes('/api/dsh-ai-debate/settings'))
  assert.ok(paths.includes('/api/dsh-ai-debate/status'))
  dispose()
})

test('routes register when the webserver appears after mount', async () => {
  const harness = makeHarness()
  // The webserver is NOT active at mount time: exactly the composition where a
  // one-shot `ctx.get` would silently give up.
  assert.equal(harness.active.has('webServer'), false)
  const dispose = await mount(harness)
  assert.equal(harness.routes.length, 0, 'nothing can register before the service exists')

  // Now the service activates.
  harness.active.set('webServer', {
    register(route: { kind: string; path: string }) {
      harness.routes.push({ kind: route.kind, path: route.path })
      return () => undefined
    },
  })
  const started = harness.activate()
  assert.ok(started >= 1, 'the injection must run when the service arrives')
  assert.ok(
    harness.routes.length >= 4,
    `routes must appear for a late service, got ${harness.routes.length}`,
  )
  dispose()
})

test('a service restart re-registers and unload removes the routes', async () => {
  const harness = makeHarness()
  const server = {
    register(route: { kind: string; path: string }) {
      harness.routes.push({ kind: route.kind, path: route.path })
      return () => {
        const index = harness.routes.findIndex((row) => row.path === route.path)
        if (index >= 0) harness.routes.splice(index, 1)
      }
    },
  }
  harness.active.set('webServer', server)
  const dispose = await mount(harness)
  const initial = harness.routes.length
  assert.ok(initial >= 4)

  // The service goes away: the injected scope's disposer must remove the routes,
  // otherwise the next registration collides on the same paths.
  harness.deactivate()
  assert.equal(harness.routes.length, 0, 'unloading the service must release the routes')

  // It comes back: a fresh injection registers them again.
  harness.active.set('webServer', server)
  harness.activate()
  assert.equal(harness.routes.length, initial, 'a restart must restore the whole family')
  dispose()
})

test('a host without the injectable contract still registers through ctx.get', async () => {
  const harness = makeHarness()
  const routes: string[] = []
  harness.active.set('webServer', {
    register(route: { path: string }) {
      routes.push(route.path)
      return () => undefined
    },
  })
  // Remove `inject` entirely: the older contract.
  delete (harness.ctx as Record<string, unknown>)['inject']

  const module = (await import('../lib/index.js')) as { apply(ctx: unknown, config: unknown): void }
  module.apply(harness.ctx as never, {
    enabled: true,
    ownerUserName: '',
    ownerUserId: '',
    storeDir: '',
  } as never)

  assert.ok(routes.length >= 4, `the fallback probe must still register, got ${routes.length}`)
  assert.ok(routes.includes('/api/dsh-ai-debate/settings'))
})
