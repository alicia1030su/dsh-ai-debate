/**
 * The browser half, tested as a browser half.
 *
 * `client/client.cjs` is evaluated by DSH's Lazy-CJS loader inside the Web page,
 * so the thing that can actually break is not "does the component look nice" but
 * "does `apply()` take the seats it claims". Every test here drives a fake
 * `__ModuleLoader__`, a fake slot registry and a fake `ctx` — no jsdom, no React
 * renderer — because those are the exact contracts the loader and the slot
 * system hand the plugin at runtime.
 *
 * Two failures this file exists to catch, both of which happened:
 *
 * 1. Registering only `plugins.row.config`, which makes a page reachable *only*
 *    by finding the bundle row and clicking its title. The Settings sidebar is a
 *    different seat (`settings.section`); a plugin that skips it looks absent.
 * 2. A mount error swallowed by the `try` in `apply()`, which keeps the GUI alive
 *    but leaves nothing on screen and no trace in the DOM.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const BUNDLE = join(import.meta.dirname, '..', 'client', 'client.cjs')

/** A minimal React stand-in: enough to evaluate and to call a component shallowly. */
function fakeReact(): Record<string, unknown> {
  const React: Record<string, unknown> = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
    useEffect: () => undefined,
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
    Fragment: 'fragment',
  }
  return React
}

/** A snapshot store matching the shape `@deepseek-ai/dsh-client-store` exposes. */
function fakeStoreModule(): Record<string, unknown> {
  return {
    createSnapshotStore: (initial: unknown) => {
      let snapshot = initial
      const listeners = new Set<() => void>()
      return {
        getSnapshot: () => snapshot,
        set: (next: unknown) => {
          snapshot = next
          for (const listener of listeners) listener()
        },
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    },
  }
}

/** Everything one load produced. */
interface Loaded {
  readonly exports: {
    apply(ctx: unknown): void
    inject: string[]
    DebateCard?: unknown
    DebateSection?: unknown
  }
  readonly registrations: { options: Record<string, unknown>; component: unknown }[]
  readonly effects: string[]
  readonly warnings: string[]
  readonly infos: string[]
}

/**
 * Evaluate the bundle the way the loader does, then run `apply` against a fake
 * client context whose `slots.register` records the registration.
 */
function loadBundle(options: {
  language?: string
  slotsRegisterThrows?: boolean
  injectThrows?: boolean
} = {}): Loaded {
  const source = readFileSync(BUNDLE, 'utf8')
  const moduleLoads: { id?: string; factory: (require: (spec: string) => unknown) => unknown }[] = []
  const warnings: string[] = []
  const infos: string[] = []

  const sandbox: Record<string, unknown> = {
    console: {
      info: (message: unknown) => infos.push(String(message)),
      warn: (message: unknown) => warnings.push(String(message)),
      log: () => undefined,
      error: () => undefined,
    },
    navigator: { language: options.language ?? 'zh-CN' },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    window: {
      __ModuleLoader__: {
        load: (registration: { id?: string; factory: (require: (spec: string) => unknown) => unknown }) =>
          moduleLoads.push(registration),
      },
    },
    document: {
      head: { appendChild: () => undefined },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
    },
    setTimeout,
    clearTimeout,
  }
  sandbox['globalThis'] = sandbox

  vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.cjs' })

  assert.equal(moduleLoads.length, 1, 'the bundle must register exactly one factory')
  const registration = moduleLoads[0]!
  assert.equal(registration.id, 'dsh-ai-debate', 'the module id must be the package name')

  const exports = registration.factory((spec: string) => {
    if (spec === 'react') return fakeReact()
    if (spec === '@deepseek-ai/dsh-client-store') return fakeStoreModule()
    throw new Error(`unexpected require: ${spec}`)
  }) as Loaded['exports']

  const registrations: { options: Record<string, unknown>; component: unknown }[] = []
  const effects: string[] = []
  const ctx = {
    slots: {
      inject: (name: string, callback: () => () => void) => {
        effects.push(`inject:${name}`)
        if (options.injectThrows === true) throw new Error('slot missing')
        callback()
        return () => undefined
      },
      register: (entryOptions: Record<string, unknown>, component: unknown) => {
        if (options.slotsRegisterThrows === true) throw new Error('register rejected')
        registrations.push({ options: entryOptions, component })
        return () => undefined
      },
    },
    locale: { register: () => () => undefined },
    effect: (callback: () => (() => void) | void, label?: string) => {
      if (label !== undefined) effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
  }

  exports.apply(ctx)
  return { exports, registrations, effects, warnings, infos }
}

// ---------------------------------------------------------------- factory

test('the bundle registers a Lazy-CJS factory under the package name', () => {
  const loaded = loadBundle()
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.ok(Array.isArray(loaded.exports.inject))
  // Both seats need the same two services; `store` is required indirectly by the
  // snapshot store the page keeps its state in.
  assert.deepEqual([...loaded.exports.inject].sort(), ['locale', 'slots'])
})

// ------------------------------------------------------- slot registrations

test('apply registers the Settings sidebar section', () => {
  const loaded = loadBundle()
  const section = loaded.registrations.find((row) => row.options.name === 'settings.section')
  assert.ok(section !== undefined, 'settings.section must be registered or the sidebar never shows the page')
  assert.equal(section.options.id, 'dsh-ai-debate')
  // A fresh id adds a nav row; reusing a shipped id would replace that section.
  assert.equal(typeof section.options.order, 'number')
  assert.equal(typeof section.options.label, 'function')
})

test('the section label follows the active locale', () => {
  const zh = loadBundle({ language: 'zh-CN' })
  const zhSection = zh.registrations.find((row) => row.options.name === 'settings.section')
  const zhLabel = (zhSection!.options.label as () => string)()
  assert.equal(zhLabel, 'AI代吵架')

  const en = loadBundle({ language: 'en-US' })
  const enSection = en.registrations.find((row) => row.options.name === 'settings.section')
  const enLabel = (enSection!.options.label as () => string)()
  assert.equal(enLabel, 'AI Debate')
})

test('apply also registers the bundle row configure view', () => {
  const loaded = loadBundle()
  const row = loaded.registrations.find((opts) => opts.options.name === 'plugins.row.config')
  assert.ok(row !== undefined)
  // `<package name>#<row id>`: both halves come from the same two constants, and
  // a mismatch is silent — the page simply never dispatches.
  assert.equal(row.options.key, 'dsh-ai-debate#dsh-ai-debate')
})

test('the settings section carries NO inject face', () => {
  // The settings shell renders a section component directly; it does not deliver
  // a registration's `inject` face (only slot-rendered children get it). A
  // component written against `props.useDebateCard` therefore renders nothing,
  // silently. This assertion pins the fix: the section owns its state.
  const loaded = loadBundle()
  const section = loaded.registrations.find((row) => row.options.name === 'settings.section')
  assert.ok(section !== undefined)
  assert.equal(section.options.inject, undefined)
})

test('the row card still advertises an inject face', () => {
  const loaded = loadBundle()
  const row = loaded.registrations.find((opts) => opts.options.name === 'plugins.row.config')
  assert.ok(row !== undefined)
  const inject = row.options.inject
  assert.equal(typeof inject, 'function')
  const face = (inject as () => Record<string, unknown>)()
  const hooks = face['hooks'] as Record<string, { getSnapshot?: unknown }> | undefined
  assert.equal(typeof hooks?.['debateCard']?.getSnapshot, 'function')
  const controller = face['controller'] as Record<string, unknown> | undefined
  assert.equal(typeof controller?.['save'], 'function')
})

test('the two seats render different components', () => {
  const loaded = loadBundle()
  const section = loaded.registrations.find((row) => row.options.name === 'settings.section')
  const row = loaded.registrations.find((opts) => opts.options.name === 'plugins.row.config')
  assert.notEqual(section!.component, row!.component)
  assert.equal(typeof loaded.exports.DebateSection, 'function')
  assert.equal(typeof loaded.exports.DebateCard, 'function')
})

// ------------------------------------------------------- failure visibility

test('a registration failure is logged and does not throw out of apply', () => {
  // The Web shell fails the whole boot when a client plugin's apply throws, so
  // the plugin must contain its own failure — but it must not be silent either.
  const loaded = loadBundle({ slotsRegisterThrows: true })
  assert.equal(loaded.registrations.length, 0)
  assert.ok(
    loaded.warnings.some((line) => line.includes('failed to mount')),
    `expected a mount warning, got: ${loaded.warnings.join(' | ')}`,
  )
})

test('a normal mount reports progress, so a blank page is diagnosable', () => {
  const loaded = loadBundle()
  const joined = loaded.infos.join('\n')
  assert.match(joined, /apply\(\) running/)
  assert.match(joined, /registering settings\.section/)
  assert.match(joined, /registering plugins\.row\.config/)
  // Progress lines must never leak a value the page was not given.
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(joined), false)
})

// ------------------------------------------------------------- component shape

test('the row card answers the summary view with text, not a form', () => {
  const loaded = loadBundle()
  const card = loaded.exports.DebateCard as (props: Record<string, unknown>) => unknown
  const summary = card({ view: 'summary', t: (key: string) => key })
  // `summary` is asked for inline inside the row's description; returning a form
  // there would render controls in a place that has no save affordance.
  assert.notEqual(summary, undefined)
  const text = JSON.stringify(summary)
  assert.equal(text.includes('controller'), false)
})
