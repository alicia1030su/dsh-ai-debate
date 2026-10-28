/**
 * The security panel, rendered from a real Host payload through the real bundle.
 *
 * ## Why this file exists
 *
 * v0.2.3 shipped a security panel that could not work, for two independent
 * reasons, and neither was visible from the Host side:
 *
 * 1. `normalizeView()` is a **whitelist**. It copies named fields out of the raw
 *    payload, and `security` was not on the list — so the field the Host had just
 *    built was dropped between the fetch and the store. The panel then reported
 *    「这个 Host 版本没有提供安全状态。」for every deployment, including the ones
 *    where protection was *off*. A security panel that cannot see the truth always
 *    picks the safe-looking answer, which here was the false one.
 *
 * 2. `DebateSection` — the `settings.section` face — stacks seven areas and listed
 *    five. `SecuritySection` and `PlatformsSection` were written, exported, and
 *    never mounted. A component that exists but is never rendered is
 *    indistinguishable from one that was never written.
 *
 * Every existing test missed both for the same reason: they exercised one half of
 * the pipeline. They called `viewOfSettings()` (the Host, which was correct) or
 * rendered a component with hand-built props (which never went through
 * `normalizeView`). The defects lived in the seams.
 *
 * So each test here runs the whole path —
 *
 *     Host JSON → real fetch → real normalizeView → real store → real React DOM
 *
 * — and asserts on **text a user would see**, through **both** registration faces,
 * because a user reaches the panel through either.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'

// React DOM samples globals at import time; see client-react-dom.test.ts for why
// these imports are sequenced the way they are.
type ReactModule = typeof import('react')
type ReactDomClient = typeof import('react-dom/client')

let React: ReactModule
let createRoot: ReactDomClient['createRoot']

const bootstrapDocument = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:63169/',
  pretendToBeVisual: true,
})
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Element',
  'HTMLInputElement',
  'Event',
  'MouseEvent',
] as const) {
  const value =
    key === 'window'
      ? bootstrapDocument.window
      : key === 'document'
        ? bootstrapDocument.window.document
        : key === 'navigator'
          ? bootstrapDocument.window.navigator
          : (bootstrapDocument.window as unknown as Record<string, unknown>)[key]
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
React = (await import('react')).default as unknown as ReactModule
createRoot = (await import('react-dom/client')).createRoot

const BUNDLE = join(import.meta.dirname, '..', 'client', 'client.cjs')

/** A healthy security state, close to what a real Host sends. */
const HEALTHY_SECURITY = {
  protectionEnabled: true,
  strictness: 'standard',
  hardRulesEnforced: true,
  inputScanning: true,
  outputGate: true,
  stanceGuard: true,
  semanticReview: false,
  counters: { last24h: 9, blocked: 5, reviewerUnavailable: 2 },
  recent: [
    {
      at: '2026-10-28T09:00:00.000Z',
      summary: '回复攻击主人',
      severity: 'critical',
      decision: 'block',
    },
  ],
}

/** The payload a v0.2.3+ Host sends, including the full security state. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      // The Host mirrors the security trio into `values` as well. The panel must
      // read the *effective* state from `security`, not the configured default
      // here — that difference is what the "must not fake on" test pins down.
      securityProtection: true,
      securityStrictness: 'standard',
      securityEventLimit: 50,
    },
    secrets: [
      { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', configured: true, writable: true, tail: '…abcd', length: 40 },
      { ref: 'DSH_AI_DEBATE_LLM_API_KEY', configured: true, writable: true, tail: '…i1U5', length: 51 },
    ],
    security: HEALTHY_SECURITY,
    capabilities: { settingsService: true, credentialService: true },
    ...overrides,
  }
}

/** The harness snapshot store: its listener is called with no arguments. */
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

/** Load the bundle through the vm sandbox and run `apply`. */
function loadBundle(response: unknown): {
  /** The `plugins.row.config` face: tabbed card. */
  Card: (props: Record<string, unknown>) => unknown
  /** The `settings.section` face: every area stacked in one page. */
  Section: (props: Record<string, unknown>) => unknown
  calls: { url: string; method: string }[]
} {
  const source = readFileSync(BUNDLE, 'utf8')
  const loads: {
    id?: string
    factory: (require: (spec: string) => unknown) => Record<string, unknown>
  }[] = []
  const calls: { url: string; method: string }[] = []

  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return { ok: true, status: 200, json: async () => response }
    },
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

  return {
    Card: exports['DebateCard'] as (props: Record<string, unknown>) => unknown,
    Section: exports['DebateSection'] as (props: Record<string, unknown>) => unknown,
    calls,
  }
}

/** Mount a component into the live jsdom document. */
function mount(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown> = {},
): { container: HTMLElement; settle(ms?: number): Promise<void>; unmount(): void } {
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  const originalError = console.error
  console.error = () => undefined
  try {
    root.render(
      React.createElement(Component as never, {
        view: 'page',
        close: () => undefined,
        ...props,
      } as never),
    )
  } finally {
    console.error = originalError
  }
  return {
    container,
    async settle(ms = 90) {
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
    unmount() {
      root.unmount()
      container.remove()
    },
  }
}

/** Click a page tab by its visible label. Returns false when it is absent. */
function clickTab(container: HTMLElement, label: string): boolean {
  const button = [...container.querySelectorAll('button')].find(
    (element) => (element.textContent ?? '').trim() === label,
  )
  if (!button) return false
  ;(button as HTMLButtonElement).click()
  return true
}

/** All visible text, with runs of whitespace collapsed. */
function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Open the security panel on the tabbed card and return its text. */
async function openSecurityTab(response: unknown): Promise<string> {
  const { Card } = loadBundle(response)
  const view = mount(Card)
  try {
    await view.settle()
    assert.ok(
      clickTab(view.container, '安全与防注入'),
      `页签卡片上找不到「安全与防注入」；现有按钮：` +
        [...view.container.querySelectorAll('button')]
          .map((b) => (b.textContent ?? '').trim())
          .join(' | '),
    )
    await view.settle()
    return textOf(view.container)
  } finally {
    view.unmount()
  }
}

/** Read the stacked settings section and return its text. */
async function readStackedSection(response: unknown): Promise<string> {
  const { Section } = loadBundle(response)
  const view = mount(Section)
  try {
    await view.settle()
    return textOf(view.container)
  } finally {
    view.unmount()
  }
}

// ---------------------------------------------------------------------------
// 1. The field survives normalizeView
// ---------------------------------------------------------------------------

test('页签卡片：security 透传后不再显示「没有提供安全状态」', async () => {
  // The exact v0.2.3 symptom. Before the fix this text was on screen for every
  // payload, because `normalizeView` dropped the field.
  const text = await openSecurityTab(payload())
  assert.doesNotMatch(
    text,
    /没有提供安全状态/,
    `Host 提供了 security，页面却显示缺少状态：${text.slice(0, 400)}`,
  )
  assert.match(text, /防注入保护已开启/, `没有显示保护开启徽章：${text.slice(0, 400)}`)
})

test('侧栏设置页：堆叠布局里也有安全区（v0.2.3 漏挂载）', async () => {
  // The other registration face. The section is not tabbed — every area is stacked —
  // so the assertion is that the text is present without clicking anything.
  const text = await readStackedSection(payload())
  assert.match(text, /安全与防注入/, `堆叠布局里没有安全区：${text.slice(0, 400)}`)
  assert.match(text, /防注入保护已开启/, `堆叠布局里没有保护状态：${text.slice(0, 400)}`)
})

test('侧栏设置页：平台区也恢复了（同一处漏挂载）', async () => {
  // `PlatformsSection` was dropped by the same omission. Asserting only on the
  // security panel would let a future edit remove it again unnoticed.
  const text = await readStackedSection(
    payload({
      platforms: [
        {
          id: 'tieba',
          displayName: '百度贴吧',
          shape: 'forum',
          implemented: true,
          active: true,
          capabilities: [
            { name: 'thread.read', state: 'supported', mark: '✅', reason: '已验证' },
          ],
        },
      ],
    }),
  )
  assert.match(text, /百度贴吧/, `堆叠布局里没有平台区：${text.slice(0, 500)}`)
})

// ---------------------------------------------------------------------------
// 2. Every reported value reaches the panel
// ---------------------------------------------------------------------------

test('面板显示输入检测、输出校验、立场保护与安全统计', async () => {
  const text = await openSecurityTab(
    payload({
      security: {
        ...HEALTHY_SECURITY,
        counters: { last24h: 9, blocked: 5, reviewerUnavailable: 2 },
      },
    }),
  )
  for (const label of ['输入风险检测', '输出安全审核', '主人立场保护']) {
    assert.match(text, new RegExp(label), `缺少${label}`)
  }
  assert.match(text, /最近 24 小时事件/, '缺少 24 小时统计')
  // The real numbers, not placeholders.
  assert.match(text, /最近 24 小时事件\s*9/, `24 小时计数没有显示 9：${text.slice(0, 500)}`)
  assert.match(text, /被阻止的候选\s*5/, `阻断计数没有显示 5：${text.slice(0, 500)}`)
})

test('语义审核未启用时页面如实说明，不暗示有第二道审核', async () => {
  const text = await openSecurityTab(payload({ security: { ...HEALTHY_SECURITY, semanticReview: false } }))
  assert.match(text, /未启用/, `没有说明语义审核未启用：${text.slice(0, 500)}`)
})

test('安全事件摘要会显示在面板上', async () => {
  const text = await openSecurityTab(payload())
  assert.match(text, /回复攻击主人/, `最近事件没有渲染：${text.slice(0, 500)}`)
})

// ---------------------------------------------------------------------------
// 3. A closed protection must never render as open
// ---------------------------------------------------------------------------

test('保护关闭时必须显示关闭，不能伪造开启', async () => {
  // The one lie a security panel must never tell. `values.securityProtection` still
  // says `true` on purpose: the panel has to read the *effective* state from
  // `security`, not the configured default that happens to sit in `values`.
  const text = await openSecurityTab(
    payload({
      security: {
        ...HEALTHY_SECURITY,
        protectionEnabled: false,
        strictness: 'relaxed',
        inputScanning: false,
        counters: { last24h: 0, blocked: 0, reviewerUnavailable: 0 },
        recent: [],
      },
    }),
  )
  assert.match(text, /防注入保护已关闭/, `保护已关闭但页面没有说：${text.slice(0, 500)}`)
  assert.doesNotMatch(text, /防注入保护已开启/, '保护关闭时绝不能显示已开启')
  assert.match(text, /宽松/, `严格度没有显示 relaxed：${text.slice(0, 500)}`)
})

test('保护关闭时，堆叠布局也不伪造开启', async () => {
  const text = await readStackedSection(
    payload({
      security: { ...HEALTHY_SECURITY, protectionEnabled: false, inputScanning: false },
    }),
  )
  assert.match(text, /防注入保护已关闭/)
  assert.doesNotMatch(text, /防注入保护已开启/)
})

// ---------------------------------------------------------------------------
// 4. Only a genuinely older Host may show the missing-state hint
// ---------------------------------------------------------------------------

test('真正旧的 Host（没有 security 字段）才显示缺少状态提示', async () => {
  const withoutSecurity = payload()
  delete withoutSecurity['security']
  const text = await openSecurityTab(withoutSecurity)
  assert.match(text, /没有提供安全状态/, `旧 Host 应显示缺少状态提示：${text.slice(0, 400)}`)
})

// ---------------------------------------------------------------------------
// 5. A malformed field must be treated as absent, not rendered blindly
// ---------------------------------------------------------------------------

test('security 是数组或字符串时按缺失处理，不渲染出荒谬内容', async () => {
  for (const bad of [[], 'yes', 42]) {
    const text = await openSecurityTab(payload({ security: bad }))
    assert.doesNotMatch(text, /undefined/, `security=${JSON.stringify(bad)} 渲染出了 undefined`)
    assert.match(text, /没有提供安全状态/, `形状不对的 security 应当按缺失处理`)
  }
})

// ---------------------------------------------------------------------------
// 6. No credential may reach the security panel
// ---------------------------------------------------------------------------

test('安全页面不渲染任何凭据或手机号', async () => {
  const text = await openSecurityTab(payload())
  assert.doesNotMatch(text, /sk-|m0sk_|BDUSS|STOKEN/)
  assert.doesNotMatch(text, /1[3-9]\d{9}/, '安全面板不得出现手机号')
})
