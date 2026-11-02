/**
 * The verification panel (v0.2.21 §三/§四), rendered for real.
 *
 * ## What this test is actually guarding
 *
 * Three sentences that look identical when the panel is empty, and mean different things:
 *
 * 1. "we have not looked yet" — `verificationState: idle`
 * 2. "we could not find out" — `verificationState: failed` (must be an error, never a blank list)
 * 3. "there is nothing recorded" — `ready` with `records: []`
 *
 * Collapsing any two of them is how a panel tells an owner "nothing is verified, everything is
 * fine" when the read actually blew up. That is the same class of bug as v0.2.14's missing
 * platform blocks, and it is why this renders through React instead of asserting on source text.
 *
 * The second thing it guards: the panel must never draw a retry affordance. One authorisation
 * publishes once; a button labelled "try again" is the interface promising something the
 * runner refuses.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// jsdom ships no declaration file in this repo; the client tests next door carry the same
// suppression. Silence it here rather than adding a baseline entry, because a *new* error in a
// new test should be fixed, not budgeted.
// @ts-expect-error -- no declaration file for jsdom
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = readFileSync(join(ROOT, 'client', 'client.cjs'), 'utf8')

/** Minimal jsdom environment: this panel never touches layout, only the DOM tree. */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
// `navigator` (and `window`) are getter-only on newer Node, so assign through defineProperty
// rather than plain assignment — a plain `g['navigator'] = …` throws before any test runs.
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
;(dom.window as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

interface Panel {
  readonly VerifySection: (props: Record<string, unknown>) => unknown
  readonly calls: { url: string; method: string; body?: string }[]
}

function loadPanel(): Panel {
  const loads: unknown[] = []
  const calls: Panel['calls'] = []
  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      const payload = String(url).includes('/verification')
        ? { ok: true, capabilities: [], records: [], blockers: [], report: null }
        : {}
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
    VerifySection: exports['VerifySection'] as Panel['VerifySection'],
    calls,
  }
}

async function render(props: Record<string, unknown>): Promise<{ text: string; buttons: string[]; unmount: () => void }> {
  const panel = loadPanel()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  const originalError = console.error
  console.error = () => undefined
  try {
    root.render(
      React.createElement(
        panel.VerifySection as never,
        {
          t: (key: string) => key,
          state: props,
          store: { runVerification: async () => undefined, loadVerification: async () => undefined },
          ...props,
        } as never,
      ),
    )
  } finally {
    console.error = originalError
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  return {
    text: container.textContent ?? '',
    buttons: [...container.querySelectorAll('button')].map((button) => button.textContent ?? ''),
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const READY_EMPTY = {
  verificationState: { state: 'ready' },
  verification: {
    ok: true,
    liveAccountId: '42',
    adapterVersion: 'abcd1234',
    capabilities: [
      { capability: 'comment.publish', declared: 'unverified', effective: 'unverified', reason: '还没验证过' },
    ],
    records: [],
    blockers: [],
    report: {
      platform: 'tieba',
      generatedAt: '2026-10-31T12:00:00.000Z',
      capabilities: [{ name: 'comment.publish', declared: 'unverified', effective: 'unverified', evidence: [] }],
    },
  },
  verificationRun: null,
}

test('读失败渲染成错误，不是「还没有记录」', async () => {
  const { text, unmount } = await render({
    verificationState: { state: 'failed', reason: 'HTTP 500' },
    verification: null,
    verificationRun: null,
  })
  try {
    assert.match(text, /HTTP 500/, '失败原因必须显示出来，否则读者以为是干净的')
    assert.doesNotMatch(text, /verifyNoRecords/, '读失败却显示「还没有验收过」，这是本轮要消灭的那类错误')
  } finally {
    unmount()
  }
})

test('从没读过时不假装读过', async () => {
  const { text, unmount } = await render({
    verificationState: { state: 'idle' },
    verification: null,
    verificationRun: null,
  })
  try {
    assert.match(text, /verifyHint/, '未读状态应当解释这个区块做什么，而不是给一个空列表')
    assert.doesNotMatch(text, /verifyNoRecords/)
  } finally {
    unmount()
  }
})

test('读成功但确实没有记录时，才说「还没有验收过」', async () => {
  const { text, unmount } = await render(READY_EMPTY)
  try {
    assert.match(text, /verifyNoRecords/)
    assert.match(text, /verifyNoEvidence/, '没有证据要明确说，而不是留白')
    assert.match(text, /abcd1234/, '适配器版本必须显示：换了实现旧证据就失效，藏起来等于骗人')
  } finally {
    unmount()
  }
})

test('阻断项显示在表单之前，并解释为什么不能验', async () => {
  const { text, unmount } = await render({
    ...READY_EMPTY,
    verification: {
      ...READY_EMPTY.verification,
      ok: false,
      blockers: ['还没有配置 tieba 的发帖账号 id'],
    },
  })
  try {
    assert.match(text, /还没有配置 tieba 的发帖账号 id/)
    assert.match(text, /verifyBlocked/)
  } finally {
    unmount()
  }
})

test('发表成功但回读不全时，四要素逐项显示，且不宣称验证通过', async () => {
  const { text, unmount } = await render({
    ...READY_EMPTY,
    verificationRun: {
      state: 'done',
      result: {
        ok: true,
        upgraded: false,
        message: '已发表，但回读证据不完整：正文不符',
        publishedPostId: 'p-1',
        readBack: { postFound: true, authorMatched: true, textMatched: false, parentMatched: true, notes: ['正文不符'] },
      },
    },
  })
  try {
    assert.match(text, /verifyDoneNotUpgraded/, '回读不全必须是「没通过」的措辞')
    assert.doesNotMatch(text, /verifyDoneUpgraded/, '回读不全却显示验证通过，等于伪造证据')
    assert.match(text, /verifyReadbackText/, '四项都要列出来，读者才知道缺哪一项')
  } finally {
    unmount()
  }
})

test('四要素齐全时才显示验证通过', async () => {
  const { text, unmount } = await render({
    ...READY_EMPTY,
    verificationRun: {
      state: 'done',
      result: {
        ok: true,
        upgraded: true,
        message: '已发表并回读确认（post id p-1）',
        publishedPostId: 'p-1',
        readBack: { postFound: true, authorMatched: true, textMatched: true, parentMatched: true, notes: [] },
      },
    },
  })
  try {
    assert.match(text, /verifyDoneUpgraded/)
  } finally {
    unmount()
  }
})

test('面板上只有一个按钮，没有「重试」', async () => {
  const { buttons, unmount } = await render(READY_EMPTY)
  try {
    assert.equal(buttons.length, 1, `只该有一个提交按钮，实际：${buttons.join(' / ')}`)
    assert.equal(buttons[0], 'verifySubmit')
    for (const label of buttons) {
      assert.doesNotMatch(label, /retry|重试|again/i, '一次授权只能发一次，界面上不能留重试的路')
    }
  } finally {
    unmount()
  }
})

test('验收在平台之后有自己的标签页，不是藏在平台列表里', async () => {
  // Reading the source for the tab id is enough here: the tab array is data, and rendering the
  // whole card to find a tab label would test React more than the decision.
  assert.match(SOURCE, /\{ id: 'verify', label: 'tabVerify' \}/, '验收必须是独立标签页')
  assert.match(SOURCE, /tabVerify: '验收'/, '中文标签要存在')
  assert.match(SOURCE, /tabVerify: 'Verification'/, '英文标签要存在')
})
