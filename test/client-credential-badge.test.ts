/**
 * The credential badge under a real DOM.
 *
 * Why not assert on the string literals instead: the defect this covers was a
 * *rendering* one. v0.1.10 showed "已配置 · 末四位 —" because the badge was built
 * from `configured` and `tail` alone, and no state existed that could have said
 * "the store has not answered yet". A test that reads the locale table back would
 * agree with whatever the table says; a test that reads the DOM sees what the
 * owner sees.
 *
 * The shapes checked here correspond to the phases in `src/credential-mirror.ts`.
 * `credential-mirror.test.ts` proves each phase is *reached* correctly; this file
 * proves each phase is *shown* correctly.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

// This file is ESM, so `require` has to be rebuilt to load React after the DOM
// exists (react-dom samples globals at init time).
const requireCjs = createRequire(import.meta.url)

import { JSDOM } from 'jsdom'

const BUNDLE = join(import.meta.dirname, '..', 'client', 'client.cjs')

/**
 * A document must exist before `react-dom` initialises, so React is imported
 * inside `installDom()` and shared afterwards.
 */
let React: typeof import('react') | undefined
let createRoot: typeof import('react-dom/client').createRoot | undefined

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:1234/',
  })
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle,
  }
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of Object.keys(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: globals[key],
    })
  }
  React = requireCjs('react') as typeof import('react')
  createRoot = (requireCjs('react-dom/client') as typeof import('react-dom/client')).createRoot
  return {
    dom,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
    },
  }
}

/** The default settings payload, with the credential state bolted on. */
function payload(credentials: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    status: 'ready',
    writable: true,
    revision: 7,
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
      {
        ref: 'DSH_AI_DEBATE_TIEBA_COOKIE',
        configured: true,
        writable: true,
        tail: '…abcd',
        length: 40,
      },
      {
        ref: 'DSH_AI_DEBATE_LLM_API_KEY',
        configured: true,
        writable: true,
        tail: '…i1U5',
        length: 51,
      },
    ],
    ...(credentials === undefined ? {} : { credentials }),
    capabilities: { settingsService: true, credentialService: true },
  }
}

/**
 * The harness snapshot store, faithful to the shipped implementation.
 *
 * The one detail that matters: the listener is invoked with NO arguments. A store
 * that passed the snapshot instead would hide the blank-page bug this contract
 * exists to catch.
 */
function snapshotStore(initial: unknown): {
  getSnapshot(): unknown
  set(next: unknown): void
  subscribe(listener: () => void): () => void
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    set: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Mount the real settings section against a stubbed fetch. */
function mountSection(response: Record<string, unknown>) {
  const source = readFileSync(BUNDLE, 'utf8')
  const loads: { factory: (require: (spec: string) => unknown) => Record<string, unknown> }[] = []

  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async () => ({ ok: true, status: 200, json: async () => response }),
    window: {
      __ModuleLoader__: { load: (registration: unknown) => loads.push(registration as never) },
    },
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
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshotStore }
    throw new Error(`unexpected require: ${spec}`)
  }) as { DebateSection?: unknown; apply(ctx: unknown): void }

  exports.apply({
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

  return { Section: exports.DebateSection as (props: Record<string, unknown>) => unknown }
}

/** Render into a container and wait for the fetch to settle. */
async function renderSection(response: Record<string, unknown>) {
  const { dom, restore } = installDom()
  const { Section } = mountSection(response)
  assert.ok(Section !== undefined, 'the section component was not registered')

  const container = dom.window.document.getElementById('root')!
  const root = createRoot!(container)
  root.render(React!.createElement(Section as never, {}))
  await new Promise((resolve) => setTimeout(resolve, 120))
  return {
    text: () => container.textContent ?? '',
    done() {
      root.unmount()
      restore()
      dom.window.close()
    },
  }
}

// --------------------------------------------------------------- assertions

test('a timed-out credential store is never shown as plain "not configured"', async () => {
  const view = await renderSection(
    payload({ phase: 'timeout', settled: true, unresolved: [], canPublish: false }),
  )
  try {
    const text = view.text()
    assert.ok(text.includes('凭据库尚未确认'), `the timeout state is missing: ${JSON.stringify(text.slice(0, 300))}`)
    assert.ok(
      text.includes('这不代表 Cookie 丢了'),
      'the hint that says the data is safe must be rendered, not just the badge',
    )
    // The lie this replaces: a bare "未配置" beside a cookie that is in fact saved.
    assert.equal(
      text.includes('未配置'),
      false,
      'a timeout must not be rendered as "not configured"',
    )
  } finally {
    view.done()
  }
})

test('a load failure says so and says the data is safe', async () => {
  const view = await renderSection(
    payload({
      phase: 'failed',
      settled: true,
      unresolved: [],
      canPublish: false,
      error: '磁盘读取失败',
    }),
  )
  try {
    const text = view.text()
    assert.ok(text.includes('读取凭据库失败'), 'the failure state is missing')
    assert.ok(text.includes('磁盘读取失败'), 'the underlying reason is shown')
    assert.ok(text.includes('已保存的值不会被删除'), 'the reassurance is shown')
  } finally {
    view.done()
  }
})

test('a partial read is shown as its own state rather than as "configured"', async () => {
  const view = await renderSection(
    payload({
      phase: 'partial',
      settled: false,
      unresolved: ['DSH_AI_DEBATE_TIEBA_COOKIE'],
      canPublish: false,
    }),
  )
  try {
    const text = view.text()
    assert.ok(text.includes('凭据库报告有值但没有返回内容'), 'the partial state is missing')
    assert.ok(text.includes('可能仍在初始化'), 'the partial hint is shown')
  } finally {
    view.done()
  }
})

test('an unproven state is flagged as blocking publishing', async () => {
  const view = await renderSection(
    payload({ phase: 'timeout', settled: true, unresolved: [], canPublish: false }),
  )
  try {
    assert.ok(
      view.text().includes('凭据状态未确认，发表会被拒绝'),
      'the page must say that publishing is blocked, not leave it to the tool error',
    )
  } finally {
    view.done()
  }
})

test('a confirmed store adds no scare badge', async () => {
  const view = await renderSection(
    payload({ phase: 'ready', settled: true, unresolved: [], canPublish: true }),
  )
  try {
    const text = view.text()
    assert.ok(text.includes('已配置'), 'the normal configured badge must still render')
    assert.equal(text.includes('凭据状态未确认'), false, 'a healthy store must not warn')
    assert.equal(text.includes('读取凭据库失败'), false)
    assert.equal(text.includes('凭据库尚未确认'), false)
  } finally {
    view.done()
  }
})

test('an older Host without a credential state still renders the plain badge', async () => {
  // Forward compatibility in the other direction: the route may omit
  // `credentials` (older Host build), and the page must not break or invent a
  // phase — it falls back to exactly what it rendered before v0.1.12.
  const view = await renderSection(payload(undefined))
  try {
    const text = view.text()
    assert.ok(text.includes('已配置'), 'the plain badge must still render')
    assert.equal(text.includes('凭据库里'), false, 'no invented phase wording')
    assert.equal(text.includes('读取凭据库失败'), false)
  } finally {
    view.done()
  }
})
