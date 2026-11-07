/**
 * 真实 DSH Desktop 验收（v0.2.32 §二）。
 *
 * ## 为什么这个文件与 Edge 版分开
 *
 * v0.2.31 的 98 个 GUI 阶段全绿，但跑在 **Edge + dsh web** 上。那不是 Desktop：
 * Desktop 是 Electron，渲染进程跑 `dsh-app://app/`，剪贴板、文件对话框、
 * WebView 权限、单实例锁全都不一样。
 *
 * 用 Edge 冒充 Desktop 最坏的后果不是「没测到」，而是**测过了却给了错误信心**：
 * `navigator.clipboard` 在 Edge 里一次就成功，而 `copyNow` 里那个 1.5 秒超时
 * 兜底正是当年在桌面 webview 里撞出来的——那个分支在 Edge 里永远走不到。
 *
 * ## 它怎么连上真桌面
 *
 * 桌面端是 Electron，接受标准 Chromium 的 `--remote-debugging-port`。所以：
 *
 *     DSH_HOME=<隔离目录> DeepSeek Harness.exe --remote-debugging-port=<port> \
 *       --user-data-dir=<隔离目录>/userdata
 *
 * 三个坑（都踩过，见 `tmp/launch-desk.sh` 的注释）：
 *   1. 必须清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 退化成 Node，开关被拒；
 *   2. 必须另给 `--user-data-dir`，否则单实例锁让第二个实例直接 quit；
 *   3. `DSH_HOME` 必须是真路径，空字符串会被当成未设置而退回 `~/.dsh`。
 *
 * ## 判定原则
 *
 * 每一项都记录「这一项是自动化验的，还是人看的」。没做到就写 skipped，
 * 而 skipped 在本项目的约定里**不算通过**。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dismissOnboarding as sharedDismiss, openSettings, type ShellCtx } from './desktop-shell.ts'

const cdpPort = Number(process.env.DSH_E2E_CDP_PORT ?? '9310')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/desk-out'
const expectSurface = process.env.DSH_EXPECT_SURFACE ?? ''

mkdirSync(outDir, { recursive: true })

interface Stage {
  readonly name: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly detail: string
  /** 这一项靠什么验的：automation = CDP 自动化；manual = 需要人眼确认。 */
  readonly how: 'automation' | 'manual'
}

const stages: Stage[] = []
function stage(name: string, status: Stage['status'], detail: string, how: Stage['how'] = 'automation'): void {
  stages.push({ name, status, detail, how })
  const mark = status === 'passed' ? '✔' : status === 'failed' ? '✘' : '·'
  process.stdout.write(`${mark} ${name} — ${detail}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let nextId = 1
const pending = new Map<number, (value: unknown) => void>()
let ws: WebSocket

const exceptions: string[] = []
const consoleErrors: string[] = []

async function connect(): Promise<{ url: string; type: string }> {
  const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as {
    id: string
    type: string
    title: string
    url: string
    webSocketDebuggerUrl: string
  }[]

  /**
   * 挑 `dsh-app://` 那个页面，不是 `file://`。
   *
   * Electron 里通常有两个 page：一个是加载 preload/启动画面的本地文件，
   * 一个是真正的应用窗口（自定义协议 `dsh-app://`）。选错了会对着一个
   * 空白页断言「界面没渲染」，然后写一份错误的失败报告。
   */
  const appPage =
    list.find((t) => t.type === 'page' && /^dsh-app:\/\//.test(t.url)) ??
    list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)) ??
    list.find((t) => t.type === 'page')

  if (appPage === undefined) {
    throw new Error(`没找到渲染页面：${JSON.stringify(list.map((t) => `${t.type}:${t.url}`))}`)
  }

  ws = new WebSocket(appPage.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = (): void => resolve()
    ws.onerror = (): void => reject(new Error('CDP 连接失败'))
  })
  ws.onmessage = (event): void => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      method?: string
      params?: { type?: string; args?: { value?: unknown }[] }
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg.result)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(msg.params).slice(0, 240))
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => String(a.value ?? '')).join(' ').slice(0, 200))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  return { url: appPage.url, type: appPage.type }
}

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T> {
  const r = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } }
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.text ?? 'evaluate 失败')
  return r.result?.value as T
}

async function screenshot(name: string): Promise<void> {
  const r = (await send('Page.captureScreenshot', { format: 'png' })) as { data?: string }
  if (typeof r.data === 'string' && r.data !== '') {
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
}

async function clickAt(x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(1200)
}

/** 按可见文字点一个按钮，用真实鼠标事件——桌面 webview 里 el.click() 有时不触发合成事件。 */
async function clickByText(label: string): Promise<boolean> {
  const pos = await evaluate<string>(`(() => {
    const nodes = [...document.querySelectorAll('button,[role=button],[role=tab],a,[tabindex]')]
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || '').trim()
      if (t === ${JSON.stringify(label)}) {
        const r = n.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      }
    }
    return 'not-found'
  })()`)
  if (pos === 'not-found') return false
  const { x, y } = JSON.parse(pos) as { x: number; y: number }
  await clickAt(x, y)
  return true
}

/** 共用入口模块需要的那几个原语。 */
function shellCtx(): ShellCtx {
  return {
    evaluate,
    clickAt,
    clickByText,
    sleep,
    viewport: async () => {
      const m = (await send('Page.getLayoutMetrics')) as {
        cssLayoutViewport?: { clientWidth: number; clientHeight: number }
      }
      return {
        vw: m.cssLayoutViewport?.clientWidth ?? 1275,
        vh: m.cssLayoutViewport?.clientHeight ?? 646,
      }
    },
  }
}

/**
 * 关掉启动引导。
 *
 * 实现搬到了 `desktop-shell.ts`：这段逻辑原来在这里和 `desktop-clipboard.ts`
 * 各写一遍，然后**立刻漂移**——一边「取文档序第一个菜单项」，一边「取可见项
 * 里最后一个」，后者当场红。同一台机器、同一个版本，只因为选择器写法不同。
 * 抽成一份之后改一次两个一起变。
 */
const dismissOnboarding = (): Promise<string> => sharedDismiss(shellCtx())

async function main(): Promise<void> {
  const surface = await connect()

  /**
   * 这一条是整个文件的地基：**证明被驱动的是 Desktop，不是浏览器。**
   *
   * `dsh-app://` 是 Electron 自定义协议，Edge 里不存在。所以只要 URL 是这个，
   * 就排除了「拿 Edge 冒充」的可能——这是本轮要解决的核心问题，
   * 必须有一条断言明确钉住它。
   */
  const isDesktopSurface = /^dsh-app:\/\//.test(surface.url)
  stage(
    '被驱动的确实是 Desktop 渲染进程（不是 Edge）',
    isDesktopSurface ? 'passed' : 'failed',
    `URL = ${surface.url}`,
  )

  const ua = await evaluate<string>('navigator.userAgent')
  const isElectron = /Electron/.test(ua)
  stage(
    'userAgent 含 Electron',
    isElectron ? 'passed' : 'failed',
    ua.slice(0, 120),
  )

  // 等界面稳定
  let text = ''
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    text = await evaluate<string>('document.body ? document.body.innerText : ""')
    if (text.length > 40) break
    await sleep(800)
  }
  stage('桌面窗口渲染出了内容', text.length > 40 ? 'passed' : 'failed', `${text.length} 字符`)
  await screenshot('01-launch')

  const dismissed = await dismissOnboarding()
  stage('启动引导层已处理', /关不掉/.test(dismissed) ? 'failed' : 'passed', dismissed)
  await screenshot('02-after-dismiss')

  /**
   * 插件是否装载。
   *
   * 不看界面也能判断：插件 `apply()` 的第一句话会往 `<head>` 插一个
   * `<style data-plugin-css="dsh-ai-debate/card.css">`。这个 dataset 名只有
   * 插件自己知道，宿主不会替它插——所以它是「跑过」的直接物证。
   */
  const styleFound = await evaluate<boolean>(`(() => {
    return document.querySelector('style[data-plugin-css="dsh-ai-debate/card.css"]') !== null
  })()`)
  stage(
    '插件在 Desktop 里执行了 apply()',
    styleFound ? 'passed' : 'failed',
    styleFound ? '<style data-plugin-css> 存在' : '没有这个样式标签——插件没装载',
  )

  // 打开设置：账号菜单 → 设置。实现见 desktop-shell.ts（与剪贴板脚本共用）。
  const settingsOpen = await openSettings(shellCtx())

  stage(
    '设置面板在 Desktop 里打得开',
    settingsOpen.ok ? 'passed' : 'failed',
    settingsOpen.how,
  )
  await screenshot('03-settings')

  // 插件那一项
  const navs = await evaluate<string[]>(`(() => {
    return [...document.querySelectorAll('button,[role=tab],[role=button]')]
      .map(el => (el.textContent || '').trim())
      .filter(t => t.length > 0 && t.length <= 14)
  })()`)
  const hasPluginEntry = navs.some((t) => /AI代吵架|dsh-ai-debate|离线/.test(t))
  stage(
    '设置里有插件那一项',
    hasPluginEntry ? 'passed' : 'failed',
    hasPluginEntry ? '有' : `只有：${navs.slice(0, 14).join(' / ')}`,
  )

  if (hasPluginEntry) {
    await clickByText('AI代吵架')
    await sleep(2500)
    await screenshot('04-plugin-page')
    const pageText = await evaluate<string>('document.body.innerText')
    const mounted = /离线讨论导入|主人贴吧数字 ID|当前步骤|登录凭据/.test(pageText)
    stage(
      '插件配置页在 Desktop 里挂载了',
      mounted ? 'passed' : 'failed',
      mounted
        ? (pageText.split('\n').find((l) => /离线|贴吧数字|当前步骤|登录凭据/.test(l)) ?? '').slice(0, 100)
        : pageText.slice(0, 180).replace(/\n/g, ' / '),
    )

    /**
     * ## 剪贴板专项：这是在 Edge 里永远测不出来的部分
     *
     * `copyNow` 的兜底逻辑是 1.5 秒超时。在普通浏览器里 `navigator.clipboard.writeText`
     * 一次就成功，那个分支一次都不会走。只有桌面 webview 才可能拒绝或挂起。
     *
     * 这里做三件事：
     *   1. 如实记录 `navigator.clipboard` 在当前 webview 里存不存在；
     *   2. 真的调一次 `writeText`，看它是成功、拒绝还是挂起；
     *   3. 用超时包住，证明**页面不会因为剪贴板而无限卡住**。
     *
     * 不写「复制成功」——除非真的在系统剪贴板里读回那段文字。而读回来这件事
     * 在 webview 里需要 `navigator.clipboard.readText` 权限，可能被拒，
     * 那就如实记「无法读回校验」。
     */
    const clipboard = await evaluate<{
      exists: boolean
      secureContext: boolean
      write: 'ok' | 'denied' | 'missing' | 'timeout' | 'error'
      detail: string
    }>(`(async () => {
      const exists = typeof navigator !== 'undefined' && !!navigator.clipboard
      const secureContext = typeof window !== 'undefined' ? !!window.isSecureContext : false
      if (!exists) return { exists, secureContext, write: 'missing', detail: 'navigator.clipboard 不存在' }
      try {
        const p = navigator.clipboard.writeText('dsh-ai-debate clipboard probe')
        const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500))
        const outcome = await Promise.race([p.then(() => 'ok').catch((e) => 'denied:' + (e && e.name)), timeout])
        return { exists, secureContext, write: String(outcome).startsWith('ok') ? 'ok' : String(outcome).startsWith('timeout') ? 'timeout' : 'denied', detail: String(outcome) }
      } catch (e) {
        return { exists, secureContext, write: 'error', detail: String(e) }
      }
    })()`)

    stage(
      '剪贴板 API 在 Desktop webview 里可用',
      clipboard.exists ? 'passed' : 'failed',
      `exists=${String(clipboard.exists)} secureContext=${String(clipboard.secureContext)}`,
    )
    stage(
      '剪贴板写入（1.5 秒超时内）',
      clipboard.write === 'ok' ? 'passed' : 'skipped',
      `${clipboard.write} — ${clipboard.detail}`,
    )
  }

  // 渲染进程是否报错
  stage(
    'Desktop 渲染进程 0 未捕获异常',
    exceptions.length === 0 ? 'passed' : 'failed',
    exceptions.length === 0 ? '0 个' : exceptions[0]!.slice(0, 160),
  )
  stage(
    'Desktop 渲染进程 0 console.error',
    consoleErrors.length === 0 ? 'passed' : 'failed',
    consoleErrors.length === 0 ? '0 条' : consoleErrors[0]!.slice(0, 160),
  )

  const failed = stages.filter((s) => s.status !== 'passed')
  writeFileSync(
    join(outDir, 'desktop-result.json'),
    JSON.stringify(
      {
        surface,
        expectSurface,
        stages,
        exceptions,
        consoleErrors,
        verdict: failed.length === 0 ? 'passed' : 'failed',
      },
      null,
      2,
    ),
  )
  process.stdout.write(`\n结果：${stages.length - failed.length}/${stages.length} 通过\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  process.stdout.write(`✘ 探针自身出错：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
