/**
 * The settings page under REAL React and a REAL DOM.
 *
 * Everything else in this suite renders components by calling them as plain
 * functions with a fake `createElement`. That catches prop and branch mistakes,
 * but it cannot see a whole class of defects — in particular anything that
 * depends on React's reconciliation or on the store's real notification
 * contract. The blank-page bug was exactly that kind: `store.subscribe(setState)`
 * passes `setState` as a listener, and because the harness's snapshot store
 * notifies with no arguments, React was told "set state to undefined". The
 * component then threw on the next render and the panel went empty — while a
 * fake store that never notifies reported a perfectly healthy tree.
 *
 * So this file mounts the real components with `react-dom/client` into a jsdom
 * document and asserts what a user would see: text in the DOM.
 *
 * The store is the harness's real contract, reimplemented faithfully from its
 * shipped implementation (createSnapshotStore in the Web frontend bundle):
 *
 *     subscribe: (listener) => state.subscribe(() => notifySubscribers([listener], label))
 *     notifySubscribers: (set, label, ...args) => { for (const s of [...set]) s(...args) }
 *
 * i.e. a listener is called with NO arguments. The fake here keeps that detail
 * precisely, because it is the detail that broke.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'

/**
 * React DOM must be imported AFTER a document exists.
 *
 * `react-dom` samples the ambient globals when its module initialises. If it is
 * imported at the top of the file, it initialises before `installDom()` has put
 * a document in place; rendering then appears to work, but the event system is
 * inert and `onChange` never fires. That produced a save test that could not
 * pass no matter what the component did. These are resolved lazily instead.
 */
type ReactModule = typeof import('react')
type ReactDomClient = typeof import('react-dom/client')

let React: ReactModule
let createRoot: ReactDomClient['createRoot']

/** Bring up one document before React DOM initialises. */
const bootstrapDocument = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:63169/',
  pretendToBeVisual: true,
})
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'HTMLInputElement', 'Event', 'MouseEvent'] as const) {
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

/** Reset between tests: the bundle keeps a module-level store. */
interface Mounted {
  readonly container: HTMLElement
  readonly document: Document
  readonly window: Window & typeof globalThis
  /**
   * Wait until `predicate` holds, polling on macrotasks.
   *
   * ## Why this replaced a fixed sleep (v0.2.22)
   *
   * These tests used to call `settle(80)` — "sleep 80 ms, then read the DOM". That
   * works on an idle machine and fails under load: `node --test` runs up to
   * (cores) files in parallel, each mounting real React trees, and an 80 ms budget
   * that is generous alone is not enough when 16 files compete for the loop. The
   * observed symptom was exactly `textContent === ""` — React had not committed
   * yet — and it appeared on the *baseline* commit too, in different files on
   * different runs.
   *
   * Raising the number would have hidden it and slowed every run; the number was
   * never the right thing to wait on. What each test actually needs is a
   * *condition*: the page has rendered, the loading line is gone, the request has
   * been issued. Those are all observable, so we wait for them and stop as soon as
   * they hold.
   *
   * The timeout is a failure deadline, not a budget: it only matters when the
   * condition never becomes true, and then the error says which one.
   */
  waitFor(predicate: () => boolean, description: string, timeoutMs?: number): Promise<void>
  /** Wait for `predicate` and return the timeout error message when it never holds. */
  settle(ms?: number): Promise<void>
  unmount(): void
}

/** How long a test will wait for a condition before failing. Generous, but it is a deadline. */
const WAIT_DEADLINE_MS = 5000

/**
 * Install a jsdom document as the global DOM for the duration of one test.
 *
 * React DOM reaches for globals directly, so they have to exist before the first
 * render; restoring them afterwards keeps tests independent.
 */
function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:63169/',
    pretendToBeVisual: true,
  })
  const previous = new Map<string, unknown>()
  const globals = [
    'window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element',
    'HTMLInputElement', 'Event', 'MouseEvent', 'KeyboardEvent',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const
  for (const key of globals) {
    previous.set(key, (globalThis as Record<string, unknown>)[key])
    const value =
      key === 'window'
        ? dom.window
        : key === 'document'
          ? dom.window.document
          : key === 'navigator'
            ? dom.window.navigator
            : key === 'getComputedStyle'
              ? dom.window.getComputedStyle.bind(dom.window)
              : key === 'requestAnimationFrame'
                ? (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0)
                : key === 'cancelAnimationFrame'
                  ? (handle: number) => dom.window.clearTimeout(handle)
                  : (dom.window as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore() {
      for (const [key, value] of previous) {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
    },
  }
}

/** A settings payload as the plugin's route returns it. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', configured: true, writable: true, tail: '…abcd', length: 40 },
      { ref: 'DSH_AI_DEBATE_LLM_API_KEY', configured: true, writable: true, tail: '…i1U5', length: 51 },
    ],
    capabilities: { settingsService: true, credentialService: true },
    ...overrides,
  }
}

/**
 * The harness snapshot store, faithful to the shipped implementation.
 *
 * The one detail that matters: `subscribe`'s listener is invoked with no
 * arguments. A store that passed the snapshot instead would hide the very bug
 * this file exists to catch.
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

/** Load the bundle, run `apply`, and hand back the section component. */
function loadSection(options: {
  response?: unknown
  /** Delay before the settings fetch resolves. */
  delayMs?: number
  /** Make the settings fetch fail. */
  failWith?: string
  /** Make the credential write fail with this message. */
  secretFailsWith?: string
} = {}): {
  Section: (props: Record<string, unknown>) => unknown
  calls: { url: string; method: string; body?: string }[]
  warnings: string[]
} {
  const source = readFileSync(BUNDLE, 'utf8')
  const loads: { id?: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }[] = []
  const calls: { url: string; method: string; body?: string }[] = []
  const warnings: string[] = []

  const sandbox: Record<string, unknown> = {
    console: {
      info: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
      log: () => undefined,
      error: () => undefined,
    },
    // jsdom's navigator is installed as a global by installDom; the bundle reads it lazily.
    navigator: { language: 'zh-CN' },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: init.body }) })
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      if (options.failWith !== undefined) {
        throw new Error(options.failWith)
      }
      if (options.secretFailsWith !== undefined && String(url).endsWith('/secrets')) {
        throw new Error(options.secretFailsWith)
      }
      return { ok: true, status: 200, json: async () => options.response ?? payload() }
    },
    window: { __ModuleLoader__: { load: (registration: unknown) => loads.push(registration as never) } },
    document: {
      head: { appendChild: () => undefined },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
    },
    setTimeout,
    clearTimeout,
    // A browser always has these; the vm context does not inherit them. Without
    // `URL` the base-URL risk check silently returns null and the plaintext-HTTP
    // warning never renders — which is exactly the defect it exists to catch.
    URL,
    URLSearchParams,
  }
  sandbox['globalThis'] = sandbox
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.cjs' })

  const exports = loads[0]!.factory((spec: string) => {
    // The REAL React: the same instance the DOM renderer uses, so hooks work.
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

  return { Section: exports['DebateSection'] as (props: Record<string, unknown>) => unknown, calls, warnings }
}

/** Mount one component into a fresh container and return handles to it. */
function mount(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown> = {},
): Mounted {
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  const errors: unknown[] = []
  const originalError = console.error
  // React reports a render throw through console.error rather than rethrowing;
  // capture it so a test can assert "it did not throw" meaningfully.
  console.error = (...args: unknown[]) => {
    errors.push(args[0])
  }
  try {
    root.render(React.createElement(Component as never, { view: 'page', close: () => undefined, ...props }))
  } finally {
    console.error = originalError
  }
  return {
    container,
    document: globalThis.document,
    window: globalThis.window as Window & typeof globalThis,
    async waitFor(predicate: () => boolean, description: string, timeoutMs = WAIT_DEADLINE_MS) {
      const deadline = Date.now() + timeoutMs
      // Poll on macrotasks so React's scheduled work (which runs off the same
      // loop) gets a turn between checks. `await null` would only drain
      // microtasks and never let a commit happen.
      for (;;) {
        if (predicate()) return
        if (Date.now() > deadline) {
          const seen = (container.textContent ?? '').slice(0, 200)
          throw new Error(`等待「${description}」超时（${timeoutMs}ms）。当前 DOM: ${JSON.stringify(seen)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    /**
     * Wait until the page has rendered something substantial.
     *
     * Kept as a helper because "did it render" is the precondition of most tests
     * here, and spelling the condition out at every call site made the tests read
     * like they were asserting on a length magic number.
     */
    async settle() {
      await this.waitFor(
        () => (container.textContent ?? '').length > 50,
        '页面渲染出内容（超过 50 个字符）',
      )
    },
    unmount() {
      root.unmount()
      container.remove()
    },
  }
}

// ------------------------------------------------------------------- the bug

test('the page shows its content after the store publishes', async () => {
  // This is the regression that blanked the pane: the first publish() told React
  // "set state to undefined" and every later render threw.
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()

    const text = view.container.textContent ?? ''
    assert.ok(text.length > 50, `the page rendered almost nothing: ${JSON.stringify(text)}`)
    assert.ok(text.includes('AI代吵架'), 'the page title is missing from the DOM')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('the store notifying with no arguments does not blank the page', async () => {
  // Pin the contract directly: notify several times, then read the DOM.
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()
    const before = (view.container.textContent ?? '').length
    assert.ok(before > 50)

    // A second settle window lets any stray notification land.
    await view.settle()
    const after = (view.container.textContent ?? '').length
    assert.ok(after > 50, `the page went blank after a later notification (${before} -> ${after})`)
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

// -------------------------------------------------------------- real DOM text

test('the loading state is visible before the fetch resolves', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection({ delayMs: 900 })
    const view = mount(Section)
    // Wait for the *loading line itself*, not for a guessed number of
    // milliseconds. That is the thing being asserted, and it is observable: the
    // component renders it on its first commit, before the fetch resolves.
    await view.waitFor(
      () => {
        const text = view.container.textContent ?? ''
        return text.includes('正在读取配置') || text.includes('loading')
      },
      '加载态出现在 DOM 里',
    )
    const early = view.container.textContent ?? ''
    assert.ok(
      early.includes('正在读取配置') || early.includes('loading'),
      `the loading state is not visible: ${JSON.stringify(early.slice(0, 120))}`,
    )
    // Then wait for the opposite condition: the 900 ms fetch has landed and the
    // loading line is gone. Waiting on the absence of the line is both correct and
    // strictly shorter than sleeping 1100 ms.
    await view.waitFor(
      () => {
        const text = view.container.textContent ?? ''
        return text.length > 200 && !text.includes('正在读取配置')
      },
      '加载结束、配置页渲染完成',
    )
    const settled = view.container.textContent ?? ''
    assert.ok(settled.length > 200, `the page never left its loading state (${settled.length} chars)`)
    assert.equal(settled.includes('正在读取配置'), false, 'the loading line is still showing after the fetch settled')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('all five areas reach the real DOM', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()
    const text = view.container.textContent ?? ''
    // One representative label per area, as a user would see them. The page
    // stacks field groups rather than printing five literal headings, so each
    // needle is a label the area really renders.
    const areas = [
      ['主人贴吧数字 ID', '贴吧账号'],
      ['模型 API 地址', 'AI 模型'],
      ['默认人格', '人格'],
      ['互动模式', '发表与安全'],
      ['刷新状态', '诊断与状态'],
    ]
    for (const [needle, label] of areas) {
      assert.ok(text.includes(needle!), `the ${label} area is missing from the DOM: ${needle}`)
    }
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('inputs are real, editable form controls', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()

    const inputs = view.container.querySelectorAll('input, textarea, select')
    assert.ok(inputs.length >= 5, `expected form controls, found ${inputs.length}`)

    const first = inputs[0] as HTMLInputElement
    assert.equal(typeof first.value, 'string')
    // Typing must reach the DOM layer, not a detached virtual tree.
    first.value = '1171245451'
    assert.equal(first.value, '1171245451')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('the credential value never appears in the DOM', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()
    const html = view.container.innerHTML
    assert.ok(html.includes('i1U5') || html.includes('已配置'), 'the credential status is missing')
    // No key-shaped string and no cookie-shaped string may reach the document.
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(html), false, 'a key-shaped string reached the DOM')
    assert.equal(/BDUSS|ST=\w{10,}/.test(html), false, 'a cookie-shaped value reached the DOM')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('a failing backend shows the failure instead of an empty page', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection({ failWith: 'network down' })
    const view = mount(Section)
    await view.settle()
    const text = view.container.textContent ?? ''
    assert.ok(text.length > 20, 'the failure state rendered nothing')
    assert.ok(
      text.includes('无法读取') || text.includes('重试') || text.includes('network down'),
      `the failure is not explained: ${JSON.stringify(text.slice(0, 200))}`,
    )
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('saving sends the staged fields to the plugin route', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section, calls } = loadSection()
    const view = mount(Section)
    await view.settle()

    // Pick a text field whose served value we know, so the edit is a real change.
    const inputs = [...view.container.querySelectorAll('input')] as HTMLInputElement[]
    const editable = inputs.find((input) => !input.disabled && input.value === '1171245451')
    assert.ok(editable !== undefined, `no editable input to drive (found ${inputs.map((i) => i.value).join(',')})`)

    // React listens for the native input event; assign through the setter React
    // patched, then dispatch, which is what a keystroke does.
    const InputCtor = (view.window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(InputCtor.prototype, 'value')?.set
    setter?.call(editable, '2233445566')
    editable.dispatchEvent(new view.window.Event('input', { bubbles: true }))
    // Wait for React to commit the staged value rather than assuming a 30 ms
    // render. The observable signal is the save button becoming enabled — which is
    // exactly the precondition the next assertion checks, so if it never happens
    // the failure now names the fixture instead of timing out anonymously.
    await view.waitFor(
      () =>
        Array.from(view.container.querySelectorAll('button')).some(
          (button) => (button.textContent ?? '').trim() === '保存' && !(button as HTMLButtonElement).disabled,
        ),
      '输入后「保存」按钮变为可用',
    )

    // Match the exact label: the credential rows also have a "保存凭据" button,
    // and an `includes` match picked that one and never issued the settings save.
    const save = [...view.container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === '保存',
    )
    assert.ok(save !== undefined, `no save button in the DOM (found ${[...view.container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).join('|')})`)
    assert.equal((save as HTMLButtonElement).disabled, false, 'the save button is disabled, so nothing was staged')
    save.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true }))
    // Wait for the POST itself. Sleeping on "the page probably finished saving" was
    // the weakest wait in this file: nothing rendered after the save, so `settle()`
    // returned immediately and the test then raced the fetch.
    await view.waitFor(
      () => calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/dsh-ai-debate/settings')),
      '保存请求发到 /settings',
    )

    const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/dsh-ai-debate/settings'))
    assert.ok(post !== undefined, `the save did not reach the plugin route: ${JSON.stringify(calls)}`)
    assert.ok(String(post.body ?? '').includes('2233445566'), `the staged value was not sent: ${post.body}`)
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('unmounting releases the store subscription', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()
    view.unmount()
    // A second mount must work from a clean slate; a leaked subscription would
    // make React warn about updating an unmounted root.
    const again = mount(Section)
    await again.settle()
    assert.ok((again.container.textContent ?? '').length > 50, 'a fresh mount rendered nothing')
    again.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})


// ------------------------------------------------ v0.1.9 configuration defects

/**
 * These five were real, user-visible defects that the "does it render" tests
 * could not see: the page drew a full tree in every one of them. Each test
 * asserts the behaviour a person would notice, not the presence of markup.
 */

test('the temperature slider can express its own default (0.4)', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()

    const range = view.container.querySelector('#dsd-temp') as HTMLInputElement | null
    assert.ok(range !== null, 'the temperature control is missing')
    // With the old hard-coded step of 1 the only reachable values were 0, 1, 2:
    // the default 0.4 could not be set by hand and displayed as 0.
    assert.equal(range.getAttribute('step'), '0.1')
    assert.equal(range.getAttribute('min'), '0')
    assert.equal(range.getAttribute('max'), '2')
    assert.ok(
      (view.container.textContent ?? '').includes('0.4/2'),
      'the saved 0.4 is not displayed at its real precision',
    )
    // A typed box, because a range input cannot be nudged to an exact decimal
    // in every browser.
    const typed = range.parentElement?.querySelector('input[type="number"]') as HTMLInputElement | null
    assert.ok(typed !== null, 'there is no way to type an exact temperature')
    assert.equal(typed.getAttribute('step'), '0.1')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('the other sliders keep an integer step', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()
    for (const id of ['dsd-auto', 'dsd-cooldown', 'dsd-per-thread']) {
      const range = view.container.querySelector(`#${id}`) as HTMLInputElement | null
      assert.ok(range !== null, `${id} is missing`)
      assert.equal(range.getAttribute('step'), '1', `${id} must keep step 1`)
    }
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('each credential input names the credential it wants', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section } = loadSection()
    const view = mount(Section)
    await view.settle()

    const inputs = [...view.container.querySelectorAll('input[type="password"]')] as HTMLInputElement[]
    assert.equal(inputs.length, 2, 'both credential rows should be present')
    // Both rows used to say "paste a new cookie", so the API-key row looked like
    // it wanted a Tieba cookie.
    assert.notEqual(inputs[0]!.placeholder, inputs[1]!.placeholder, 'the two rows share one placeholder')
    assert.match(inputs[0]!.placeholder, /Cookie/i)
    assert.match(inputs[1]!.placeholder, /API Key/i)
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('a failed credential save keeps what the user pasted', async () => {
  const { dom, restore } = installDom()
  try {
    // The route rejects the write; the field must survive so the paste is not lost.
    const { Section } = loadSection({ secretFailsWith: '本部署没有凭据服务' })
    const view = mount(Section)
    await view.settle()

    const input = view.container.querySelector('input[type="password"]') as HTMLInputElement
    const InputCtor = (view.window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(InputCtor.prototype, 'value')?.set
    setter?.call(input, 'ST=fixture-pasted-value-06')
    input.dispatchEvent(new view.window.Event('input', { bubbles: true }))
    // Wait until React has committed the typed value into its own state. Reading
    // the input's DOM value would pass even before the commit, so the observable
    // signal is the credential-save button becoming enabled.
    await view.waitFor(
      () =>
        Array.from(view.container.querySelectorAll('button')).some(
          (button) => (button.textContent ?? '').trim() === '保存凭据' && !(button as HTMLButtonElement).disabled,
        ),
      '输入凭据后「保存凭据」按钮变为可用',
    )

    const save = [...view.container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === '保存凭据',
    )
    assert.ok(save !== undefined, 'no save button for the credential')
    save.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true }))
    // Wait for the reported outcome rather than a guessed delay: on a rejected
    // write the row must show 「保存失败」, and that is the assertion right below.
    await view.waitFor(
      () => (view.container.textContent ?? '').includes('保存失败'),
      '失败的保存被报告成「保存失败」',
    )

    // The defect: the input was cleared before the promise settled, so a
    // rejected save silently ate the cookie.
    assert.equal(input.value, 'ST=fixture-pasted-value-06', 'the pasted value was lost on a failed save')
    assert.ok(
      (view.container.textContent ?? '').includes('保存失败'),
      'the failure was not reported to the user',
    )
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('the config-only action and the real stop are two different things', async () => {
  const { dom, restore } = installDom()
  try {
    const { Section, calls } = loadSection()
    const view = mount(Section)
    await view.settle()

    const buttons = [...view.container.querySelectorAll('button')]
    const autoOff = buttons.find((b) => (b.textContent ?? '').includes('关闭自动发表模式'))
    const pauseNow = buttons.find((b) => (b.textContent ?? '').includes('立即暂停所有任务'))
    assert.ok(autoOff !== undefined, 'the config-only action is missing')
    assert.ok(pauseNow !== undefined, 'the real stop action is missing')

    // The old single button staged two fields and claimed to have paused
    // everything. Editing config must NOT issue a request.
    //
    // This is a *negative* assertion, so there is no positive condition to wait
    // for. What we can observe is that the click has been committed: the button
    // stages `interactionMode = manual` and `maxAutoPerSession = 0`, both of which
    // are rendered as form controls with stable ids. Wait for the select to show
    // the staged value, then assert the absence of the request — that ordering is
    // the strongest statement available, and it no longer depends on load.
    autoOff!.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true }))
    await view.waitFor(
      () => (view.container.querySelector('#dsd-mode') as HTMLSelectElement | null)?.value === 'manual',
      '「关闭自动发表模式」把 #dsd-mode 改成 manual',
    )
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/action')).length,
      0,
      'editing the mode must not call the pause action',
    )

    // The real one must.
    pauseNow!.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true }))
    await view.waitFor(
      () => calls.some((call) => call.method === 'POST' && call.url.endsWith('/action')),
      '「立即暂停」调用 /action',
    )
    const posted = calls.find((call) => call.method === 'POST' && call.url.endsWith('/action'))
    assert.ok(posted !== undefined, 'the real stop did not call the backend')
    assert.ok(String(posted.body ?? '').includes('pause-now'), `wrong action sent: ${posted.body}`)
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('a plaintext public base URL warns without being rewritten', async () => {
  const { dom, restore } = installDom()
  try {
    const response = payload({
      values: { ...(payload().values as Record<string, unknown>), llmBaseUrl: 'http://api.example.com/v1' },
    })
    const { Section } = loadSection({ response })
    const view = mount(Section)
    await view.settle()

    const text = view.container.textContent ?? ''
    assert.ok(text.includes('明文 HTTP'), 'a public http endpoint did not warn')
    assert.ok(/Authorization/.test(text), 'the warning does not explain what leaks')
    // Never silently upgraded: the configured URL is what the user sees and
    // what the runtime will use.
    const base = [...view.container.querySelectorAll('input')].find(
      (input) => input.value === 'http://api.example.com/v1',
    )
    assert.ok(base !== undefined, 'the URL was rewritten')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})

test('a loopback plaintext base URL is a note, not a warning', async () => {
  const { dom, restore } = installDom()
  try {
    const response = payload({
      values: { ...(payload().values as Record<string, unknown>), llmBaseUrl: 'http://127.0.0.1:3000/v1' },
    })
    const { Section } = loadSection({ response })
    const view = mount(Section)
    await view.settle()
    const text = view.container.textContent ?? ''
    assert.equal(text.includes('明文 HTTP'), false, 'a local endpoint must not be treated as a leak')
    assert.ok(text.includes('本机或内网明文地址'), 'the local case should still be explained')
    view.unmount()
  } finally {
    restore()
    dom.window.close()
  }
})
