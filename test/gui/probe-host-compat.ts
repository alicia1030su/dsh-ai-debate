/**
 * 宿主升级兼容性探针（DSH 0.2.2-rc.1 起）。
 *
 * ## 它回答什么问题
 *
 * 「DSH 更新之后，这个插件还能不能用。」
 *
 * 这是一个**只在换宿主时跑一次**的检查，不是回归测试。它不进 `npm test`，
 * 因为它的前提是「有一个真宿主在跑」，而绝大多数测试不该依赖那个。
 *
 * ## 为什么分两层
 *
 * **第一层：运行时。** 不看界面也能验——插件 `apply()` 跑过就会注入
 * `<style data-plugin-css="dsh-ai-debate/card.css">`，会在 console 打
 * `[dsh-ai-debate] apply() running`，HTTP 路由会返回 200。这三条任何一条断，
 * 都说明插件根本没起来，后面看界面就没意义。
 *
 * **第二层：入口。** 用户能不能找到配置页。新版壳子把设置从侧栏搬进了
 * 「账号菜单 → 设置」（快捷键 `Ctrl+Alt+,`），这个改动会让**所有按旧位置写的
 * 选择器失效**——而失效的方式是「找不到」，不是报错。
 *
 * ## 用法
 *
 *   DSH_HOME=<隔离目录> dsh --profile <p> --host 127.0.0.1 --port <port> --no-open
 *   <Edge> --remote-debugging-port=<cdp> <URL>
 *   DSH_E2E_CDP_PORT=<cdp> DSH_E2E_OUT_DIR=<out> node --experimental-transform-types \
 *     test/gui/probe-host-compat.ts
 *
 * 现成的封装：`tmp/probe-test.sh`（起宿主 + 起浏览器 + 跑本文件）。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = Number(process.env.DSH_E2E_CDP_PORT ?? '9296')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/ui-compat'

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}
const checks: Check[] = []

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? '✔' : '✘'} ${name} — ${detail}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let nextId = 1
const pending = new Map<number, (value: unknown) => void>()
let ws: WebSocket

const pluginLogs: string[] = []
const exceptions: string[] = []
const consoleErrors: string[] = []

async function connect(): Promise<void> {
  const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url))
  if (page === undefined) throw new Error(`没有找到宿主页面：${JSON.stringify(list.map((t) => t.url))}`)
  ws = new WebSocket(page.webSocketDebuggerUrl)
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
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args ?? []).map((a) => String(a.value ?? '')).join(' ')
      if (/\[dsh-ai-debate\]/.test(text)) pluginLogs.push(text)
      if (/error/i.test(text)) consoleErrors.push(text.slice(0, 160))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(JSON.stringify(msg.params).slice(0, 200))
    }
  }
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
  await sleep(1400)
}

/**
 * 关掉启动引导层。
 *
 * 这里用**坐标**而不是 `el.click()`，原因是实测的：新版壳子的引导层
 * （「开始使用」/「预览版说明」）里的按钮，`document.querySelectorAll('*')`
 * 按文本找不到，`el.click()` 也点不动。它不在常规查询范围内。
 *
 * 关闭叉的位置按视口比例算，不写死像素——写死会在换分辨率时点空，而点空
 * 的表现是「后面所有检查都失败」，看起来像产品坏了。
 */
async function dismissOnboarding(): Promise<string> {
  for (let round = 0; round < 3; round += 1) {
    const text = await evaluate<string>('document.body.innerText')
    if (!/开始使用|预览版说明/.test(text)) return `clean (${round} 轮)`
    if (!/关闭|添加 API Key|登录|继续/.test(text)) return `有弹窗但找不到关法 (${round} 轮)`

    const m = (await send('Page.getLayoutMetrics')) as {
      cssLayoutViewport?: { clientWidth: number; clientHeight: number }
    }
    const vw = m.cssLayoutViewport?.clientWidth ?? 1275
    const vh = m.cssLayoutViewport?.clientHeight ?? 646
    // 关闭叉实测落在 (0.63·vw, 0.35·vh) 附近
    await clickAt(Math.round(vw * 0.5 + 0.13 * vw), Math.round(vh * 0.35))
  }
  const remaining = await evaluate<string>('document.body.innerText')
  return /开始使用|预览版说明/.test(remaining) ? '关不掉' : '关掉了（第三轮）'
}

async function main(): Promise<void> {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')

  // ── 第一层：运行时 ────────────────────────────────────────────────────────
  let text = ''
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    text = await evaluate<string>('document.body ? document.body.innerText : ""').catch(() => '')
    if (text.length > 40) break
    await sleep(700)
  }
  check('宿主主界面渲染出来了', text.length > 40, `${text.length} 字符`)

  const styleState = JSON.parse(
    await evaluate<string>(`(() => {
      const el = document.querySelector('style[data-plugin-css="dsh-ai-debate/card.css"]')
      if (el) return JSON.stringify({ found: true, len: (el.textContent || '').length })
      const others = [...document.querySelectorAll('style[data-plugin]')].map(e => e.getAttribute('data-plugin'))
      return JSON.stringify({ found: false, others: others.slice(0, 6) })
    })()`),
  ) as { found: boolean; len?: number; others?: string[] }

  check(
    '插件执行了自己的 apply()（注入了样式）',
    styleState.found,
    styleState.found
      ? `<style data-plugin-css> 存在，${styleState.len} 字符`
      : `没有；页面上其它插件样式：${(styleState.others ?? []).join(',') || '（一个都没有）'}`,
  )

  check(
    '插件打了装载日志',
    pluginLogs.length > 0,
    pluginLogs.length > 0 ? pluginLogs.slice(0, 2).join(' | ').slice(0, 160) : '没抓到（console 级别可能过滤，不单独定罪）',
  )

  const api = await evaluate<string>(`(async () => {
    const out = []
    for (const p of ['/api/dsh-ai-debate/workbench', '/api/dsh-ai-debate/settings']) {
      try { const r = await fetch(p, { credentials: 'same-origin' }); out.push(p.replace('/api/dsh-ai-debate/', '') + '=' + r.status) }
      catch { out.push(p + '=ERR') }
    }
    return out.join(' ')
  })()`)
  check('插件的 HTTP 路由可用', !/401|403|ERR/.test(api), api)

  // ── 第二层：入口 ──────────────────────────────────────────────────────────
  const dismissed = await dismissOnboarding()
  check('启动引导层已处理', !/关不掉/.test(dismissed), dismissed)
  await screenshot('01-dismissed')

  // 新版：账号菜单 → 设置（旧版是侧栏直接一个「设置」）
  const opened = await evaluate<string>(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const clickable = () => [...document.querySelectorAll('button,[role=button],[role=menuitem],a,[tabindex]')]
    const account = clickable().find((el) => el.getAttribute('aria-label') === '账号菜单')
    if (account) {
      account.click()
      await wait(900)
      const settings = clickable().find((el) => /^设置|^Settings/.test((el.textContent || '').trim()))
      if (settings) { settings.click(); return 'via-account-menu' }
    }
    const direct = clickable().find((el) => /^设置$|^Settings$/i.test((el.textContent || '').trim()))
    if (direct) { direct.click(); return 'direct' }
    return 'not-found'
  })()`)
  await sleep(2500)
  check('设置面板打得开', opened !== 'not-found', opened)
  await screenshot('02-settings')

  const navs = await evaluate<string[]>(`(() => {
    return [...document.querySelectorAll('button,[role=tab],[role=button]')]
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t.length > 0 && t.length <= 14)
  })()`)
  const navHas = navs.some((t) => /AI代吵架|dsh-ai-debate|离线/.test(t))
  check(
    '设置导航里有插件那一项',
    navHas,
    navHas ? `导航：${navs.filter((t) => t.length <= 8).slice(0, 12).join(' / ')}` : `只有：${navs.slice(0, 12).join(' / ')}`,
  )

  if (navHas) {
    const pos = await evaluate<string>(`(() => {
      const el = [...document.querySelectorAll('button,[role=tab],[role=button]')]
        .find(e => /AI代吵架|dsh-ai-debate/.test((e.textContent || '').trim()))
      if (!el) return 'not-found'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`)
    if (pos !== 'not-found') {
      const { x, y } = JSON.parse(pos) as { x: number; y: number }
      await clickAt(x, y)
      await sleep(2000)
    }
    await screenshot('03-plugin-page')

    const page = await evaluate<string>('document.body.innerText')
    const mounted = /离线讨论导入|主人贴吧数字 ID|当前步骤|还没有导入|登录凭据/.test(page)
    check(
      '插件配置页挂载了',
      mounted,
      mounted
        ? (page.split('\n').find((l) => /离线|贴吧数字|当前步骤|登录凭据/.test(l)) ?? '').slice(0, 100)
        : page.slice(0, 180).replace(/\n/g, ' / '),
    )
  }

  check('全程 0 未捕获异常', exceptions.length === 0, exceptions.length === 0 ? '0 个' : exceptions[0]!.slice(0, 160))
  check(
    '全程 0 console.error',
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? '0 条' : consoleErrors[0]!.slice(0, 160),
  )

  writeFileSync(join(outDir, 'compat-result.json'), JSON.stringify({ checks, pluginLogs, exceptions, consoleErrors }, null, 2))

  const failed = checks.filter((c) => !c.ok)
  process.stdout.write(`\n结果：${checks.length - failed.length}/${checks.length} 通过\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  process.stdout.write(`✘ 探针自身出错：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
