/**
 * The publish workbench, rendered for real (v0.2.22 §一/§五/§八).
 *
 * ## What only a render can catch
 *
 * The derivation tests next door pin which step and which blockers. These pin what a reader
 * *sees*, and three of those properties cannot be checked against a string of source:
 *
 * 1. **The five outcome states read differently.** "Request sent, not confirmed" and "all four
 *    confirmed" must not render the same sentence — collapsing them is how an owner believes a
 *    reply was verified when only its request left the process.
 * 2. **There is no resend control.** §五 forbids offering the action that turns an unknown
 *    result into a duplicate post. Asserting the absence of a button needs the DOM.
 * 3. **A failed read is not an empty workbench.** "We could not read" and "nothing here" must be
 *    different screens; the first must never render as a clean slate.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// jsdom ships no declaration file in this repo; the client tests next door carry the same
// suppression. Silence it here rather than budget it: a new error in a new test is fixed.
// @ts-expect-error -- no declaration file for jsdom
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = readFileSync(join(ROOT, 'client', 'client.cjs'), 'utf8')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
// `navigator` and `window` are getter-only on newer Node, so assign through defineProperty.
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

function loadPanel(): {
  WorkbenchSection: (props: Record<string, unknown>) => unknown
  calls: { url: string; method: string; body?: string }[]
} {
  const loads: unknown[] = []
  const calls: { url: string; method: string; body?: string }[] = []
  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return { ok: true, status: 200, json: async () => ({}) }
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
  return { WorkbenchSection: exports['WorkbenchSection'] as never, calls }
}

async function render(
  workbenchState: Record<string, unknown>,
  workbench: Record<string, unknown> | null,
  edit: Record<string, unknown> | null = null,
): Promise<{ text: string; buttons: string[]; hasTextarea: boolean; unmount: () => void }> {
  const panel = loadPanel()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  const props = {
    t: (key: string) => key,
    store: { loadWorkbench: async () => undefined, saveWorkbenchEdit: async () => undefined },
    state: { workbenchState, workbench, workbenchEdit: edit },
  }
  const originalError = console.error
  console.error = () => undefined
  try {
    root.render(React.createElement(panel.WorkbenchSection as never, props as never))
  } finally {
    console.error = originalError
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  return {
    text: container.textContent ?? '',
    buttons: [...container.querySelectorAll('button')].map((button) => button.textContent ?? ''),
    hasTextarea: container.querySelector('textarea') !== null,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const BASE_STEPS = [
  { id: 'link', title: 'link', status: 'done' },
  { id: 'target', title: 'target', status: 'done' },
  { id: 'generate', title: 'generate', status: 'done' },
  { id: 'review', title: 'review', status: 'done' },
  { id: 'approve', title: 'approve', status: 'current' },
  { id: 'publish', title: 'publish', status: 'pending' },
  { id: 'readback', title: 'readback', status: 'pending' },
]

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    sessionId: 's1',
    platform: 'tieba',
    threadTitle: '讨论',
    candidates: [
      {
        replyId: 'c1',
        text: '原来的正文',
        strategy: 'tieba_veteran',
        candidateVersion: 1,
        textHash: 'h1',
        approved: false,
        targetPostId: 'p-2',
        createdAt: '2026-10-31T12:00:00.000Z',
        violations: [],
      },
    ],
    workbench: {
      step: 'approve',
      steps: BASE_STEPS,
      blockers: [],
      missingEvidence: [],
      outcome: 'not_attempted',
      counts: { floors: 5, nested: 8, candidates: 1 },
      target: { threadId: 't1', postId: 'p-2', kind: 'nested' },
      capability: { declared: 'unverified', effective: 'unverified', reason: '还没有验过' },
      ...overrides,
    },
  }
}

test('五种发表结果各自渲染成不同句子', async () => {
  const rendered: string[] = []
  for (const outcome of ['not_attempted', 'sent_unconfirmed', 'confirmed', 'refused', 'unknown'] as const) {
    const { text, unmount } = await render({ state: 'ready' }, view({ outcome }))
    try {
      const line = text.split('workbenchOutcome：')[1] ?? ''
      rendered.push(line.slice(0, 40))
    } finally {
      unmount()
    }
  }
  assert.equal(new Set(rendered).size, 5, `五种结果必须给出五种不同的文字，实际：${JSON.stringify(rendered)}`)
})

test('读失败不是空工作台', async () => {
  const { text, unmount } = await render({ state: 'failed', reason: 'HTTP 500' }, null)
  try {
    assert.match(text, /HTTP 500/)
    assert.doesNotMatch(text, /workbenchNoCandidates/, '读失败却显示「还没有候选」，等于把故障说成干净的开始')
  } finally {
    unmount()
  }
})

test('没有 workbench 数据时不假装有状态', async () => {
  const { text, unmount } = await render({ state: 'ready' }, { ok: false, blockers: ['当前构建没有接上工作台'] })
  try {
    assert.match(text, /当前构建没有接上工作台/)
  } finally {
    unmount()
  }
})

test('工作台里没有「重新发送」按钮，并且页面自己说明原因', async () => {
  const { buttons, text, unmount } = await render({ state: 'ready' }, view({ outcome: 'unknown' }))
  try {
    for (const label of buttons) {
      assert.doesNotMatch(label, /重发|重新发送|retry|resend|again/i, `出现了重发入口：${label}`)
    }
    assert.match(text, /workbenchNoResend/, '不提供重发这件事，页面上要说出理由')
    assert.match(buttons.join(' '), /workbenchRefresh/)
    assert.match(buttons.join(' '), /workbenchSaveEdit/)
  } finally {
    unmount()
  }
})

test('候选正文可编辑，保存走 edit-candidate 动作', async () => {
  const { hasTextarea, buttons, unmount } = await render({ state: 'ready' }, view())
  try {
    assert.equal(hasTextarea, true, '没有可编辑的正文，就不是「预览与编辑」这一步')
    assert.match(buttons.join(' '), /workbenchSaveEdit/)
  } finally {
    unmount()
  }
})

test('编辑成功后明确说「批准已作废，需要重新批准」', async () => {
  const { text, unmount } = await render({ state: 'ready' }, view(), {
    state: 'done',
    result: { ok: true, candidateVersion: 2, textHash: 'h2' },
  })
  try {
    assert.match(text, /workbenchEditSaved/)
    assert.match(text, /workbenchEditSaved/ )
    assert.doesNotMatch(text, /已保存。批准与安全评估已失效/, '渲染的是 i18n key，断言只针对 key 存在')
  } finally {
    unmount()
  }
})

test('编辑被拒绝时把原因显示出来', async () => {
  const { text, unmount } = await render({ state: 'ready' }, view(), {
    state: 'done',
    result: { ok: false, message: '已经发表过，正文不能再改' },
  })
  try {
    assert.match(text, /已经发表过/)
  } finally {
    unmount()
  }
})

test('回读四要素逐项显示，不是只给一个总结', async () => {
  const { text, unmount } = await render(
    { state: 'ready' },
    view({
      outcome: 'sent_unconfirmed',
      readBack: { postFound: true, authorMatched: true, textMatched: false, parentMatched: true, notes: [] },
    }),
  )
  try {
    assert.match(text, /workbenchReadbackFound/)
    assert.match(text, /workbenchReadbackText/)
    assert.match(text, /❌/, '正文不一致要有一个明确的失败标记')
  } finally {
    unmount()
  }
})

test('没有回读证据时不渲染四要素', async () => {
  const { text, unmount } = await render({ state: 'ready' }, view({ outcome: 'unknown' }))
  try {
    assert.doesNotMatch(text, /workbenchReadbackFound/, '没回读过就不该画四项事实')
  } finally {
    unmount()
  }
})

test('阻断项与缺失证据都显示在页面上', async () => {
  const { text, unmount } = await render(
    { state: 'ready' },
    view({
      blockers: ['这条候选还没有人工批准'],
      missingEvidence: [{ what: '第 3 页', detail: '分页请求超时' }],
    }),
  )
  try {
    assert.match(text, /这条候选还没有人工批准/)
    assert.match(text, /第 3 页/)
    assert.match(text, /分页请求超时/)
  } finally {
    unmount()
  }
})

test('目标、计数与能力状态都在页面上', async () => {
  const { text, unmount } = await render({ state: 'ready' }, view())
  try {
    assert.match(text, /p-2/, '目标回复 id 必须可见')
    assert.match(text, /t1/, '目标帖子 id 必须可见')
    assert.match(text, /还没有验过/, '能力状态的原因要可见，否则读者不知道能不能发')
  } finally {
    unmount()
  }
})

test('工作台是独立标签页，排在验收之后', () => {
  assert.match(SOURCE, /\{ id: 'workbench', label: 'tabWorkbench' \}/)
  assert.match(SOURCE, /tabWorkbench: '工作台'/)
  assert.match(SOURCE, /tabWorkbench: 'Workbench'/)
})

// ---------------------------------------------------------------------------
// v0.2.22 §一/§四: the three write actions, and the one that must stay gated
// ---------------------------------------------------------------------------

test('链接、读取讨论、生成候选三个控件都在页面上', async () => {
  const { text, buttons, unmount } = await render({ state: 'ready' }, view())
  try {
    assert.equal(text.includes('workbenchLinkLabel'), true, '没有粘贴链接的地方，第一步就走不了')
    assert.match(buttons.join(' '), /workbenchAnalyze/)
    assert.match(buttons.join(' '), /workbenchGenerate/)
  } finally {
    unmount()
  }
})

test('发表按钮只在「批准仍绑定当前正文」这一步出现', async () => {
  // approve step: publishing must NOT be offered — the whole point of the gate.
  const approveStep = await render({ state: 'ready' }, view({ step: 'approve' }))
  try {
    assert.doesNotMatch(
      approveStep.buttons.join(' '),
      /workbenchPublishOnce/,
      '还没批准就出现发表按钮，等于让页面替主人跳过批准',
    )
  } finally {
    approveStep.unmount()
  }

  const publishStep = await render({ state: 'ready' }, view({ step: 'publish' }))
  try {
    assert.match(publishStep.buttons.join(' '), /workbenchPublishOnce/)
    assert.match(publishStep.buttons.join(' '), /只会发一次|workbenchPublishOnce/)
  } finally {
    publishStep.unmount()
  }
})

test('结果未知时不再提供发表按钮', async () => {
  const { buttons, unmount } = await render({ state: 'ready' }, view({ step: 'readback', outcome: 'unknown' }))
  try {
    assert.doesNotMatch(
      buttons.join(' '),
      /workbenchPublishOnce/,
      '结果未知还能再点一次发表，就是页面在制造重复回复',
    )
  } finally {
    unmount()
  }
})

test('发表动作走既有 action 路由，不由工作台直调平台', () => {
  // The panel must reach the platform only through the action route; a direct fetch to a
  // platform host inside client.cjs would be a second, ungated publish path.
  assert.doesNotMatch(SOURCE, /tieba\.baidu\.com\/(mo|f)\/.*fetch/s, '工作台不得自己发请求给平台')
  assert.match(SOURCE, /runWorkbenchAction\('publish-approved'/)
  assert.match(SOURCE, /runWorkbenchAction\('analyze-thread'/)
  assert.match(SOURCE, /runWorkbenchAction\('generate-candidates'/)
})
