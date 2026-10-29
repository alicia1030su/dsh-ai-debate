/**
 * The approval panel, rendered from a real Host payload through the real bundle.
 *
 * ## The seam this file guards
 *
 * v0.2.4 shipped a security panel that could not work, for a reason invisible from
 * either side: `normalizeView()` is a **whitelist**, and `security` was not on the list,
 * so the Host built a complete state that the page dropped between fetch and store. The
 * panel then reported "this Host does not provide a security state" for every deployment
 * — including the ones where protection was off.
 *
 * `pendingApprovals` is the same kind of field and would fail the same way. So these
 * tests run the whole path —
 *
 *     Host JSON → real fetch → real normalizeView → real store → real React DOM
 *
 * — and assert on text a user would see. A test that rendered `ApproveSection` with
 * hand-built props would pass even if the field were dropped, which is precisely the
 * defect the sibling file documents.
 *
 * ## What the panel must never do
 *
 * Approve something the owner did not see. Every assertion is about the body being on
 * screen next to the button, because the approval is bound to that body's hash: a panel
 * that showed a truncated preview and approved the full text would be approving blind.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'

type ReactModule = typeof import('react')
type ReactDomClient = typeof import('react-dom/client')

let React: ReactModule
let createRoot: ReactDomClient['createRoot']

const bootstrapDocument = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:51271/',
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

/** One pending candidate, shaped exactly as `listPendingApprovals` returns it. */
const PENDING = {
  sessionId: 's-1',
  candidateId: 's-1-c1',
  platform: 'tieba',
  threadTitle: '某个争论帖',
  threadUrl: 'https://tieba.baidu.com/p/1',
  targetPostId: 'n5',
  // Deliberately contains a newline: the body must render as it would be posted.
  text: '你这条论据没有出处。\n请拿出同型号的价格再来反驳。',
  candidateVersion: 2,
  verdict: 'review',
  createdAt: '2026-10-28T09:00:00.000Z',
  reason: '安全闸门把它标记为「需要人工确认」。',
  assessmentFingerprint: 'fp-abc',
  // v0.2.7: the Host sends the whole expectation and the page echoes it back. A row
  // without it renders a disabled button rather than a request that would be refused.
  expected: {
    sessionId: 's-1',
    candidateId: 's-1-c1',
    candidateVersion: 2,
    platform: 'tieba',
    targetPostId: 'n5',
    publishingAccount: '900',
    textHash: 'a'.repeat(64),
    assessmentFingerprint: 'fp-abc',
  },
}

/** The payload a v0.2.5 Host sends. */
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
      securityProtection: true,
      securityStrictness: 'standard',
      securityEventLimit: 50,
    },
    secrets: [],
    pendingApprovals: [PENDING],
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
function loadBundle(responses: {
  settings?: unknown
  approve?: unknown
}): {
  Card: (props: Record<string, unknown>) => unknown
  Section: (props: Record<string, unknown>) => unknown
  ApproveSection: (props: Record<string, unknown>) => unknown
  calls: { url: string; method: string; body?: string }[]
} {
  const source = readFileSync(BUNDLE, 'utf8')
  const loads: {
    id?: string
    factory: (require: (spec: string) => unknown) => Record<string, unknown>
  }[] = []
  const calls: { url: string; method: string; body?: string }[] = []

  const sandbox: Record<string, unknown> = {
    console: { info: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined },
    navigator: { language: 'zh-CN' },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const target = String(url)
      calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
      // The approve endpoint answers with its own shape; everything else is the
      // settings view. Keeping them apart is what lets a test see which URL was hit.
      const body = target.endsWith('/approve') ? responses.approve : responses.settings
      const ok = !(target.endsWith('/approve') && body && (body as { error?: string }).error !== undefined)
      return { ok, status: ok ? 200 : 409, json: async () => body }
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
    ApproveSection: exports['ApproveSection'] as (props: Record<string, unknown>) => unknown,
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
    async settle(ms = 60) {
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
    unmount() {
      root.unmount()
      container.remove()
    },
  }
}

/** Every visible string under an element. */
function textOf(element: Element): string {
  return element.textContent ?? ''
}

// ---------------------------------------------------------------------------
// The panel reaches the DOM through the real pipeline
// ---------------------------------------------------------------------------

test('待批准候选经 Host → normalizeView → store → DOM 真的显示出来', async () => {
  // The whole point of running the pipeline: a hand-built props test would pass even if
  // `pendingApprovals` were missing from `normalizeView`, which is the v0.2.4 failure mode.
  const bundle = loadBundle({ settings: payload() })
  const Card = bundle.Card
  const view = mount(Card)
  try {
    await view.settle()
    // Open the approval tab.
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    assert.ok(tab !== undefined, `没有找到「发表授权」页签：${textOf(view.container).slice(0, 400)}`)
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const text = textOf(view.container)
    assert.match(text, /某个争论帖/, '列表里应出现帖子标题')
    assert.match(text, /你这条论据没有出处/, '候选正文必须显示出来')
    assert.match(text, /请拿出同型号的价格再来反驳/, '正文的全部内容都要在，不能截断')
    assert.match(text, /n5/, '回复目标要显示')
  } finally {
    view.unmount()
  }
})

test('候选正文按原样换行显示，不是压成一段', async () => {
  // The approval binds to the text hash, so the panel must show the thing that will be
  // posted. A reply whose newlines are collapsed here reads differently on the platform.
  const bundle = loadBundle({ settings: payload() })
  const view = mount(bundle.ApproveSection, {
    t: (key: string) => key,
    store: { approve: async () => ({ approved: true }), load: () => undefined },
    state: {
      tab: 'approve',
      view: { status: 'ready', pendingApprovals: [PENDING] },
    },
  })
  try {
    await view.settle()
    const body = view.container.querySelector('.dsd-approve-text')
    assert.ok(body !== null, '找不到正文节点')
    // `pre-wrap` is what preserves the newlines; asserting the class is asserting the
    // behaviour, because the CSS rule is what does the work.
    assert.equal(body!.className, 'dsd-approve-text')
    assert.match(textOf(body!), /\n/, '正文里的换行必须保留')
  } finally {
    view.unmount()
  }
})

test('Host 不提供待批准列表时说的是「不提供」，不是「没有待批准」', async () => {
  // Those are different facts and the owner acts on them differently: one means "upgrade
  // or this build cannot help", the other means "generate something and come back".
  const bundle = loadBundle({
    settings: payload({ pendingApprovals: undefined }),
  })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    assert.ok(tab !== undefined)
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const text = textOf(view.container)
    // `unavailable` is the key whose text says "this Host version does not provide…".
    assert.doesNotMatch(text, /暂无记录。/, '不能把「不提供」说成「没有」')
  } finally {
    view.unmount()
  }
})

test('没有待批准候选时给的是「先生成一条」的指引', async () => {
  const bundle = loadBundle({ settings: payload({ pendingApprovals: [] }) })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    assert.ok(tab !== undefined)
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const text = textOf(view.container)
    assert.match(text, /先让 Agent 生成|generate one/, `空列表要有指引：${text.slice(0, 300)}`)
  } finally {
    view.unmount()
  }
})

// ---------------------------------------------------------------------------
// The click does the right thing
// ---------------------------------------------------------------------------

test('点「批准这一条」会 POST 到 /approve，并把页面看到的快照原样带上', async () => {
  // The request body is part of the security story, in both directions.
  //
  // v0.2.5 sent only the two ids and the Host bound the approval to *whatever was
  // stored at that moment*. That let a page which had not been reloaded approve a
  // candidate the owner never read: the record was internally consistent, so
  // nothing downstream could notice. v0.2.7 requires the expectation, and the page
  // must echo the Host's own data rather than invent any of it.
  const bundle = loadBundle({
    settings: payload(),
    approve: { approved: true, approvalId: 'ap-1', expiresAt: '2026-10-28T09:30:00.000Z' },
  })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const approveButton = [...view.container.querySelectorAll('button')].find((button) =>
      /批准这一条|Approve this reply/.test(textOf(button)),
    )
    assert.ok(approveButton !== undefined, '找不到批准按钮')
    ;(approveButton as HTMLButtonElement).click()
    await view.settle(120)

    const call = bundle.calls.find((entry) => entry.url.endsWith('/approve'))
    assert.ok(call !== undefined, '没有发出批准请求')
    assert.equal(call!.method, 'POST')
    const body = JSON.parse(call!.body ?? '{}') as {
      sessionId?: string
      candidateId?: string
      expected?: Record<string, unknown>
      text?: unknown
      publishingAccount?: unknown
    }
    assert.equal(body.sessionId, 's-1')
    assert.equal(body.candidateId, 's-1-c1')

    // The expectation is required and must be the Host's data, field for field.
    assert.ok(body.expected !== undefined, '请求必须带 expected 快照')
    assert.deepEqual(body.expected, PENDING.expected)

    // And it must not smuggle in anything the Host did not hand the page. The body
    // is still just ids plus the echo: a page cannot assert its own text or account.
    assert.equal(body.text, undefined, '页面不能自己编正文')
    assert.equal(body.publishingAccount, undefined, '页面不能自己编发帖账号')
  } finally {
    view.unmount()
  }
})

test('没有快照的候选：按钮禁用，不会发出一个注定被拒的请求', async () => {
  // A row the Host could not snapshot (no AI account bound, or a pre-0.2.3 candidate
  // with no assessment) is still listed so the owner can see it and read why. The
  // failure this guards against is a *live* button that always fails: it looks like
  // a bug in the plugin rather than a missing prerequisite.
  const unsnapshot = { ...PENDING, expected: undefined }
  const bundle = loadBundle({
    settings: payload({ pendingApprovals: [unsnapshot] }),
    approve: { approved: true, approvalId: 'ap-1' },
  })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const text = textOf(view.container)
    assert.match(text, /无法批准|Cannot approve/, '要说明为什么不能批准')
    const anyLiveApprove = [...view.container.querySelectorAll('button')].some(
      (button) =>
        /批准这一条|Approve this reply/.test(textOf(button)) &&
        (button as HTMLButtonElement).disabled === false,
    )
    assert.equal(anyLiveApprove, false, '没有快照时不能留下一个可点的批准按钮')

    const call = bundle.calls.find((entry) => entry.url.endsWith('/approve'))
    assert.equal(call, undefined, '禁用状态下不应发出请求')
  } finally {
    view.unmount()
  }
})

test('批准成功后重新读取设置，让这一行按真实状态消失', async () => {
  // Re-reading is how the row disappears for the right reason: the Host now holds a live
  // approval，which is the same fact the publish path will check. Removing it locally
  // would leave the page disagreeing with the store if the write had actually failed.
  const bundle = loadBundle({
    settings: payload(),
    approve: { approved: true, approvalId: 'ap-1' },
  })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const before = bundle.calls.filter((entry) => entry.url.endsWith('/settings')).length
    const approveButton = [...view.container.querySelectorAll('button')].find((button) =>
      /批准这一条|Approve this reply/.test(textOf(button)),
    )
    ;(approveButton as HTMLButtonElement).click()
    await view.settle(120)

    const after = bundle.calls.filter((entry) => entry.url.endsWith('/settings')).length
    assert.equal(after > before, true, '批准之后必须重新读取设置')
  } finally {
    view.unmount()
  }
})

test('批准被拒绝时把 Host 给的原因显示出来，而不是假装成功', async () => {
  const bundle = loadBundle({
    settings: payload(),
    approve: { error: '这个候选已被安全闸门阻止', code: 'blocked' },
  })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const approveButton = [...view.container.querySelectorAll('button')].find((button) =>
      /批准这一条|Approve this reply/.test(textOf(button)),
    )
    ;(approveButton as HTMLButtonElement).click()
    await view.settle(120)

    const text = textOf(view.container)
    assert.match(text, /安全闸门/, 'Host 的原因要显示出来')
    assert.doesNotMatch(text, /已写入授权记录/, '失败时不能显示成功文案')
  } finally {
    view.unmount()
  }
})

test('批准进行中时按钮禁用并显示进行中文案，双击不会发出两次请求', async () => {
  // A double click would create two records for the same candidate. The Host supersedes
  // the older one, so it is not a security hole — but it is a confusing audit trail, and
  // the disable is one line.
  //
  // ## Why this renders the component directly instead of driving the whole bundle
  //
  // Through the bundle the sandbox's `fetch` resolves immediately, so the in-flight state
  // exists only between two microtasks. Polling for it made the test pass or fail by
  // timing, which is worse than not testing it: a flaky assertion gets deleted, and the
  // behaviour it covered goes with it. A store whose `approve()` never settles makes the
  // busy state the only state, so the assertion is about the component's contract rather
  // than about the scheduler.
  const calls: string[] = []
  const never = new Promise<never>(() => {
    // Deliberately never settles.
  })
  const view = mount(loadBundle({ settings: payload() }).ApproveSection, {
    t: (key: string, values?: Record<string, unknown>) => {
      // A tiny stand-in for the real `t`: the component's default call shape is
      // `t('key')`, and one string uses `{placeholder}` substitution.
      if (values === undefined) return key
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        key,
      )
    },
    store: {
      approve: (sessionId: string, candidateId: string) => {
        calls.push(`${sessionId}/${candidateId}`)
        return never
      },
      load: () => undefined,
    },
    state: { tab: 'approve', view: { status: 'ready', pendingApprovals: [PENDING] } },
  })
  try {
    await view.settle(20)
    // Not `querySelector('button')`: the section header also carries a "reload
    // candidates" button since v0.2.7, and picking the first button would test that
    // one instead of the approval control.
    const button = [...view.container.querySelectorAll('button')].find(
      (element) => (element as HTMLButtonElement).textContent === 'approveAction',
    ) as HTMLButtonElement | undefined
    assert.ok(button !== undefined, '找不到批准按钮')

    button.click()
    await view.settle(20)

    // While the write is in flight the label says so and the button refuses clicks.
    assert.equal(button.disabled, true, '进行中必须禁用，否则双击会写两条记录')
    assert.equal(button.textContent, 'approveWorking', '进行中要显示对应的文案')
    assert.deepEqual(calls, ['s-1/s-1-c1'], '点击只应触发一次批准调用')

    // A second click while disabled must not queue another call.
    button.click()
    await view.settle(10)
    assert.deepEqual(calls, ['s-1/s-1-c1'], '禁用的按钮不能再次调用')
  } finally {
    view.unmount()
  }
})

test('批准请求失败后按钮恢复可用，可以重试', async () => {
  // A button stuck in the busy state after a failure is the difference between "try
  // again" and "reload the page".
  const bundle = loadBundle({ settings: payload(), approve: { error: '暂时失败' } })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    const first = [...view.container.querySelectorAll('button')].find((button) =>
      /批准这一条|Approve this reply/.test(textOf(button)),
    ) as HTMLButtonElement
    first.click()
    await view.settle(120)

    const again = [...view.container.querySelectorAll('button')].find((button) =>
      /批准这一条|Approve this reply/.test(textOf(button)),
    ) as HTMLButtonElement | undefined
    assert.ok(again !== undefined, '失败后按钮应当还在，可以重试')
    assert.equal(again!.disabled, false, '失败后必须解除禁用')
  } finally {
    view.unmount()
  }
})

// ---------------------------------------------------------------------------
// The panel does not leak or overstate
// ---------------------------------------------------------------------------

test('批准页面不显示任何凭据', async () => {
  const bundle = loadBundle({
    settings: payload({
      values: {
        ...(payload().values as Record<string, unknown>),
        tiebaCookie: 'ST=SUPERSECRET',
        llmApiKey: 'sk-SUPERSECRET',
      },
    }),
  })
  const view = mount(bundle.Card)
  try {
    await view.settle()
    const tab = [...view.container.querySelectorAll('button')].find((button) =>
      /发表授权|Authorisation/.test(textOf(button)),
    )
    ;(tab as HTMLButtonElement).click()
    await view.settle()

    assert.equal(textOf(view.container).includes('SUPERSECRET'), false)
  } finally {
    view.unmount()
  }
})

test('页签里同时有两个挂载面：页面堆叠与页签卡片都能到批准区', async () => {
  // `settings.section` stacks every area; `plugins.row.config` shows tabs. A section that
  // is mounted in one and missing from the other is half a feature, and the v0.2.4
  // regression was exactly that shape.
  const bundle = loadBundle({ settings: payload() })

  const sectionView = mount(bundle.Section)
  try {
    await sectionView.settle()
    assert.match(
      textOf(sectionView.container),
      /发表授权/,
      '页面堆叠面必须包含批准区',
    )
  } finally {
    sectionView.unmount()
  }

  const cardView = mount(bundle.Card)
  try {
    await cardView.settle()
    const labels = [...cardView.container.querySelectorAll('button')].map(textOf)
    assert.equal(
      labels.some((label) => /发表授权|Authorisation/.test(label)),
      true,
      `页签卡片面必须有批准页签，实际：${labels.join(' / ')}`,
    )
  } finally {
    cardView.unmount()
  }
})
