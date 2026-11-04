/**
 * The tabs whose content is a *read*, and the trigger none of them had (v0.2.26).
 *
 * ## The bug this file exists for
 *
 * Two sections in this page show the answer to a question that only the Host can answer:
 * the verification panel (`GET /verification?platform=…`) and the workbench
 * (`GET /workbench`). Both were written correctly as "render whatever the last read
 * returned, and say `not read yet` when there is nothing".
 *
 * Neither was ever read on entry.
 *
 * - `loadVerification` had exactly one caller: the run handler, whose 「发表并回读」 button
 *   only renders once a view exists. A cycle with no entry point, so the panel showed a
 *   heading and one sentence — forever. The v0.2.25 GUI run ended here and the report
 *   guessed "the settings shell is blocking navigation", which was wrong; the sentence
 *   under the heading was the `!view` branch.
 * - `loadWorkbench` was called from `load()`, before any session could exist, and from the
 *   write handlers. After a page reload nothing re-read it, so the workbench offered
 *   「粘贴链接」 while the store held an approved, already-published reply — on a page that
 *   says, in as many words, that reloading returns you to the same place.
 *
 * ## What is asserted
 *
 * Not the rendering — `v0221-verify-panel.test.ts` and the workbench DOM tests cover that.
 * What is asserted is the *call*: switching to the tab must ask the Host. A test that
 * checked the section's text again would pass even with the trigger deleted, which is
 * exactly how this shipped.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// @ts-expect-error -- no declaration file for jsdom
import { JSDOM } from 'jsdom'
import React from 'react'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = readFileSync(join(ROOT, 'client', 'client.cjs'), 'utf8')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const [key, value] of [
  ['window', dom.window],
  ['document', dom.window.document],
  ['navigator', dom.window.navigator],
  ['HTMLElement', dom.window.HTMLElement],
  ['Node', dom.window.Node],
  ['Event', dom.window.Event],
] as const) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

/** The card store, with every network call recorded instead of performed. */
interface Harness {
  readonly store: Record<string, unknown>
  readonly calls: { url: string; method: string }[]
}

function loadStore(settings: Record<string, unknown> = {}): Harness {
  const loads: unknown[] = []
  const calls: Harness['calls'] = []
  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      const payload = String(url).includes('/verification')
        ? { ok: true, capabilities: [], records: [], blockers: [], report: { platform: 'tieba', capabilities: [] } }
        : { ok: true, ...settings }
      return { ok: true, status: 200, json: async () => payload }
    },
    window: { __ModuleLoader__: { load: (registration: unknown) => loads.push(registration) } },
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
  vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: 'client.cjs' })
  const registration = loads[0] as { factory: (req: (spec: string) => unknown) => Record<string, unknown> }
  const exports = registration.factory((spec: string) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-store') {
      return {
        createSnapshotStore: (initial: unknown) => {
          let snapshot = initial
          return {
            getSnapshot: () => snapshot,
            set: (next: unknown) => {
              snapshot = next
            },
            subscribe: () => () => undefined,
          }
        },
      }
    }
    throw new Error(`unexpected require: ${spec}`)
  })
  return {
    store: (exports['__createCardStore'] as () => Record<string, unknown>)(),
    calls,
  }
}

/** The Host's settings payload, including the platform list the panel picks from. */
const SETTINGS = {
  status: 'ready',
  writable: true,
  values: {},
  secrets: [],
  capabilities: { settingsService: true, credentialService: true },
  platforms: [
    { id: 'tieba', displayName: '贴吧', shape: 'forum', implemented: true, active: true, capabilities: [] },
    { id: 'weibo', displayName: '微博', shape: 'feed', implemented: false, active: false, capabilities: [] },
  ],
}

test('切到验收页签必须真的读一次，而不是停在永远不来的空视图上', async () => {
  const { store, calls } = loadStore(SETTINGS)
  // The platform list arrives with the settings read, which the real page performs on
  // mount. Installing it here is what makes "which platform" answerable at all.
  ;(store as { install: (view: unknown) => void }).install({
    status: 'ready',
    writable: true,
    values: {},
    secrets: [],
    capabilities: { settingsService: true, credentialService: true },
    platforms: SETTINGS.platforms,
  })
  calls.length = 0
  await (store as { setTab: (tab: string) => void }).setTab('verify')
  await new Promise((resolve) => setTimeout(resolve, 30))

  const verificationCalls = calls.filter((call) => call.url.includes('/verification'))
  assert.equal(
    verificationCalls.length,
    1,
    `切到验收页必须问一次 Host，实际调用了 ${verificationCalls.length} 次（全部请求：${calls.map((c) => c.url).join(', ')}）`,
  )
  assert.match(
    verificationCalls[0]!.url,
    /platform=tieba/,
    '要读的必须是当前真正在用的那个平台，不能是空平台名——空平台名的回答是「你还没选平台」，那不是用户问的问题',
  )
})

test('切到工作台页签必须重读一次，否则刷新后页面会忘记已经发表过', async () => {
  // The sentence on this page is 「刷新页面会回到同一个位置」. With no read on entry that
  // sentence was false: a reload showed 「粘贴链接」 over a store holding a published reply.
  const { store, calls } = loadStore(SETTINGS)
  calls.length = 0
  await (store as { setTab: (tab: string) => void }).setTab('workbench')
  await new Promise((resolve) => setTimeout(resolve, 30))

  const workbenchCalls = calls.filter((call) => call.url.includes('/workbench'))
  assert.equal(
    workbenchCalls.length,
    1,
    `切到工作台页必须重读一次，实际 ${workbenchCalls.length} 次（全部请求：${calls.map((c) => c.url).join(', ')}）`,
  )
})

test('打开别的页签时不去打扰 Host', async () => {
  // The two reads above are deliberate. Firing them on every tab would turn a settings
  // page into a polling client, and would also make "we could not read" flicker whenever
  // someone looked at an unrelated section.
  const { store, calls } = loadStore(SETTINGS)
  calls.length = 0
  await (store as { setTab: (tab: string) => void }).setTab('persona')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(
    calls.map((call) => call.url),
    [],
    `只切页签不该产生请求，实际：${calls.map((c) => c.url).join(', ')}`,
  )
})
