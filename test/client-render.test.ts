/**
 * Render both surfaces against a fabricated ready state.
 *
 * The slot tests prove the seats are taken; these prove the component in each
 * seat produces a tree instead of throwing. That distinction matters because the
 * failure mode is different: an unregistered seat means nothing renders, while a
 * throwing component blanks the panel *and* is invisible to apply's own try
 * (which has already returned by the time the shell renders).
 *
 * The contract tested here is the one the shell actually uses: NO injected
 * props. The settings shell renders a section component directly, so a
 * component written against props.useDebateCard renders nothing at all - and
 * fails silently, with the sidebar entry looking perfectly healthy. Both
 * components therefore read a shared module-level store through React state.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const BUNDLE = join(import.meta.dirname, '..', 'client', 'client.cjs')

/** A settings payload as the plugin's own route returns it. */
function readyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ready',
    writable: true,
    revision: 3,
    values: {
      enabled: true,
      ownerUserId: '1171245451',
      ownerUserName: '似水蓝蝶',
      aiAccountName: '小号',
      aiAccountUserId: '900',
      allowedOwnerIds: '',
      personaStyle: 'tieba_veteran',
      intensity: 3,
      maxLength: 150,
      emojiLevel: 0,
      sarcasmLevel: 2,
      directness: 4,
      llmBaseUrl: 'http://model.example/v1',
      llmModel: 'a-model',
      llmTimeoutMs: 120000,
      llmTemperature: 0.4,
      llmMaxOutputTokens: 0,
      contextPreset: 'small',
      contextTokens: 0,
      interactionMode: 'manual',
      maxAutoPerSession: 0,
      cooldownSeconds: 60,
      maxPerThread: 10,
      maxFloorPages: 60,
      pageDelayMs: 400,
      requestTimeoutMs: 20000,
      requestRetries: 2,
      sessionTtlDays: 7,
      announceToAgent: true,
      logLevel: 'info',
    },
    secrets: [
      { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', configured: true, writable: true, tail: '…abcd', length: 40 },
      { ref: 'DSH_AI_DEBATE_LLM_API_KEY', configured: true, writable: true, tail: '…i1U5', length: 51 },
    ],
    capabilities: { settingsService: true, credentialService: true },
    ...overrides,
  }
}

interface Loaded {
  readonly exports: Record<string, (props: Record<string, unknown>) => unknown>
  /** Every URL the bundle fetched, in order. */
  readonly fetches: string[]
}

/**
 * Evaluate the bundle the way the loader does, run apply against a fake client
 * context, and return its components bound to their own store.
 */
function loadBundle(payload: unknown = readyPayload()): Loaded {
  const source = readFileSync(BUNDLE, 'utf8')
  const loads: { id?: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }[] = []
  const fetches: string[] = []

  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
    useEffect: () => undefined,
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
    Fragment: 'fragment',
  }
  const storeModule = {
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

  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async (url: string) => {
      fetches.push(String(url))
      return { ok: true, status: 200, json: async () => payload }
    },
    window: { __ModuleLoader__: { load: (registration: unknown) => loads.push(registration as never) } },
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

  const exports = loads[0]!.factory((spec: string) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-store') return storeModule
    throw new Error(`unexpected require: ${spec}`)
  }) as Record<string, unknown>

  ;(exports['apply'] as (ctx: unknown) => void)({
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        callback()
        return () => undefined
      },
      register: () => () => undefined,
    },
    locale: { register: () => () => undefined },
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
  })

  return { exports: exports as Loaded['exports'], fetches }
}

/**
 * Render a component the way its shell does: page view, no injected face.
 *
 * The first call seeds the module store (which starts a fetch); awaiting a tick
 * lets that promise settle, and the second call reads the settled snapshot - the
 * same sequence the shell goes through when the store notifies.
 */
async function renderSettled(
  componentName: 'DebateSection' | 'DebateCard',
  payload: unknown = readyPayload(),
): Promise<string> {
  const bundle = loadBundle(payload)
  const component = bundle.exports[componentName]
  assert.equal(typeof component, 'function', `${componentName} must be exported`)
  component!({ view: 'page', close: () => undefined })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const tree = component!({ view: 'page', close: () => undefined })
  assert.notEqual(tree, undefined, 'the component returned nothing')
  assert.notEqual(tree, null, 'the component returned null')
  const html = JSON.stringify(tree)
  assert.equal(
    html.includes('RENDER-ERROR'),
    false,
    `the component trapped an internal error:\n${html.slice(0, 1500)}`,
  )
  return html
}

// --------------------------------------------------------------- rendering

test('the settings section renders every area without injected props', async () => {
  const html = await renderSettled('DebateSection')
  // One page, five stacked areas: each area's own field must reach the tree.
  for (const field of [
    'ownerUserId',
    'aiAccountUserId',
    'llmBaseUrl',
    'llmModel',
    'personaStyle',
    'interactionMode',
    'maxPerThread',
  ]) {
    assert.ok(html.includes(field), `the section page did not render the ${field} field`)
  }
})

test('the section reads settings once and status once per load', () => {
  const bundle = loadBundle()
  const component = bundle.exports['DebateSection']!
  component({ view: 'page', close: () => undefined })
  // v0.2.14 §九: the page now also reads `/status`, because the platform panel needs the live
  // diagnostics on first open. Before this the blocks were fetched only when the owner pressed
  // 重新探测, so every platform rendered as "no live diagnostic" until then.
  //
  // Both routes are asserted, in order: a duplicate would mean the page re-fetches on every
  // render rather than once per load.
  assert.deepEqual(bundle.fetches, [
    '/api/dsh-ai-debate/settings',
    '/api/dsh-ai-debate/status',
  ])
})

test('the section shows the saved credential status without its value', async () => {
  const html = await renderSettled('DebateSection')
  // The tail is what the host sends; the value never is.
  assert.ok(html.includes('i1U5'), 'the credential tail is missing')
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(html), false, 'the tree must not carry a key-shaped string')
})

test('the row card renders content without injected props', async () => {
  const html = await renderSettled('DebateCard')
  assert.ok(html.length > 1500, `the card rendered almost nothing (${html.length} bytes)`)
  assert.ok(html.includes('ownerUserId'), 'the card did not render its first tab')
})

test('the row card answers the summary view with text', () => {
  const bundle = loadBundle()
  const card = bundle.exports['DebateCard']!
  const summary = card({ view: 'summary' })
  // summary is asked for inline inside the row's description; returning the
  // form there would render controls where there is no save affordance.
  const text = JSON.stringify(summary)
  assert.ok(text.length < 400, `the summary view is a whole form (${text.length} bytes)`)
})

test('a loading view says so instead of rendering empty fields', () => {
  const bundle = loadBundle()
  const section = bundle.exports['DebateSection']!
  const html = JSON.stringify(section({ view: 'page', close: () => undefined }))
  assert.ok(
    html.includes('正在读取配置') || html.includes('loading'),
    'the loading state must name itself',
  )
})

test('an unavailable backend renders a retry, not a blank page', async () => {
  const html = await renderSettled(
    'DebateSection',
    readyPayload({ status: 'unavailable', writable: false, values: {}, secrets: [] }),
  )
  assert.ok(html.length > 200, 'the unavailable state rendered an empty tree')
  // A dead end with no way back is a bug, so the retry control must exist.
  assert.ok(html.includes('dsd-btn'), 'the retry control is missing')
})

test('a read-only deployment still renders its fields', async () => {
  const html = await renderSettled('DebateSection', readyPayload({ writable: false }))
  assert.ok(html.includes('ownerUserId'), 'a read-only page must still show the values')
})