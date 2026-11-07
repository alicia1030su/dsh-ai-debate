/**
 * 剪贴板失败路径专项（v0.2.32 §二「剪贴板专项」）。
 *
 * ## 为什么必须在真 Desktop 里跑
 *
 * `copyNow` 的兜底逻辑是这样的（`client.cjs`）：
 *
 *     const written = clipboard === undefined || typeof clipboard.writeText !== 'function'
 *       ? false
 *       : await Promise.race([
 *           clipboard.writeText(text).then(() => true).catch(() => false),
 *           new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
 *         ])
 *     setCopied(written ? t('manualCopied') : `${t('manualCopyManual')}\n${text}`)
 *
 * 四个分支里，正常成功那条是**唯一**在 Edge 里能走到的。另外三条
 * （不存在 / 拒绝 / 挂起）在普通浏览器里一次都碰不到——而当年那个
 * 「点了复制，页面什么也不显示」的 bug 恰恰是在桌面 webview 里撞出来的。
 *
 * 所以在 Edge 里测剪贴板，测的是「运气好的那条路」。这份文件专门踩另外三条。
 *
 * ## 怎么构造失败
 *
 * 不改产品代码。在渲染进程里**替换 `navigator.clipboard`**，
 * 让页面自己以为环境坏了——它走的还是生产分支，只是环境的回答变了。
 * 每次替换前先备份，测完恢复，保证后续阶段看到的是真实环境。
 *
 * ## 判定原则
 *
 * 关键不是「复制成功」，而是**页面必须给出可读反馈且不卡住**：
 *   - 拿不到剪贴板 → 必须把正文摆出来让人手动复制（`manualCopyManual`）
 *   - 挂起 → 必须在 1.5 秒左右放弃，而不是一直等
 *   - 任何情况下都不能显示「已复制」
 */

import { mkdirSync, writeFileSync } from 'node:fs'

import { EvidenceCollector } from './evidence.ts'

import {
  dismissOnboarding,
  openPluginPage,
  openSettings,
  type ShellCtx,
} from './desktop-shell.ts'

const cdpPort = Number(process.env.DSH_E2E_CDP_PORT ?? '9330')
const outDir = process.env.DSH_E2E_OUT_DIR ?? 'tmp/desk-clip'

interface Stage {
  readonly name: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly detail: string
}

const stages: Stage[] = []
function stage(name: string, status: Stage['status'], detail: string): void {
  stages.push({ name, status, detail })
  const mark = status === 'passed' ? '✔' : status === 'failed' ? '✘' : '·'
  process.stdout.write(`${mark} ${name} — ${detail}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const startedAt = new Date().toISOString()
/** 脚本版本。改动断言时要一起改它，否则结果里无法区分「同一份脚本的两次改动」。 */
const CLIPBOARD_SCRIPT_VERSION = '2026-11-07.1'

let nextId = 1
const pending = new Map<number, (v: unknown) => void>()
let ws: WebSocket

async function connect(): Promise<void> {
  const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  const page = list.find((t) => t.type === 'page' && /dsh-app:\/\//.test(t.url)) ?? list.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('没找到渲染页面')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = (): void => resolve()
    ws.onerror = (): void => reject(new Error('CDP 连接失败'))
  })
  ws.onmessage = (e): void => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
    if (m.id !== undefined) {
      pending.get(m.id)?.(m.result)
      pending.delete(m.id)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
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

async function clickAt(x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(1200)
}

async function clickByText(label: string): Promise<boolean> {
  const pos = await evaluate<string>(`(() => {
    for (const n of document.querySelectorAll('button,[role=button],[role=tab],[tabindex]')) {
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

/** 把 `navigator.clipboard` 换成指定的坏实现，返回恢复函数。 */
async function installBrokenClipboard(mode: 'missing' | 'denied' | 'hang' | 'reject-late'): Promise<void> {
  await evaluate<string>(`(() => {
    // 备份原实现，只在第一次替换时存
    if (window.__clipBackup === undefined) {
      window.__clipBackup = {
        has: 'clipboard' in navigator,
        value: navigator.clipboard,
        descriptor: Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard'),
      }
    }
    const mode = ${JSON.stringify(mode)}
    if (mode === 'missing') {
      // 整个属性都拿掉：非安全上下文 / 老 webview 的真实形态
      try { delete navigator.clipboard } catch {}
      Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => undefined })
      return 'missing'
    }
    if (mode === 'denied') {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: () => ({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }),
      })
      return 'denied'
    }
    if (mode === 'hang') {
      // 永不 resolve、永不 reject——就是当年那个场景
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: () => ({ writeText: () => new Promise(() => {}) }),
      })
      return 'hang'
    }
    // reject-late：先挂 800ms 再拒——检验它不是靠「早失败」蒙对
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: () => new Promise((_res, rej) => setTimeout(() => rej(new DOMException('late', 'NotAllowedError')), 800)),
      }),
    })
    return 'rejectLate'
  })()`)
}

async function restoreClipboard(): Promise<void> {
  await evaluate<string>(`(() => {
    const b = window.__clipBackup
    if (b === undefined) return 'no-backup'
    if (b.descriptor !== undefined) Object.defineProperty(Navigator.prototype, 'clipboard', b.descriptor)
    else if (b.has) Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => b.value })
    else { try { delete Navigator.prototype.clipboard } catch {} }
    return 'restored'
  })()`)
}

/** 读页面上与复制有关的那句反馈。 */
/**
 * 读复制反馈。
 *
 * ## 这里踩过一个坑：整页搜「剪贴板」会读到一段**静态说明**
 *
 * 页面顶部有一句固定文案：「…内容来自剪贴板，未经平台核验。」它永远在，
 * 于是整页搜「剪贴板」时第一次轮询就命中，四条用例全部报
 * 「1206ms 后反馈：官方接口读不到时…」——那段话跟复制毫无关系。
 *
 * 一个把静态说明当成操作反馈的探针，会让**所有**失败路径都看起来像通过
 * （因为它「有反馈」），恰恰废掉了这组用例的意义。
 *
 * 所以判据必须是**这两句之一**，而且只能来自复制按钮下面那个 `p.dsd-hint`：
 *
 *   - 成功：已复制到剪贴板
 *   - 兜底：这个环境不允许插件直接写剪贴板。以下是服务端给的那一段…
 *
 * 其余一律返回空串，让调用方继续等超时。
 */
async function copyFeedback(): Promise<string> {
  return evaluate<string>(`(() => {
    const nodes = [...document.querySelectorAll('p.dsd-hint, .dsd-hint')]
    for (const node of nodes) {
      const t = (node.innerText || '').trim()
      if (/^已复制到剪贴板/.test(t)) return t
      if (/^这个环境不允许插件直接写剪贴板/.test(t)) return t
    }
    return ''
  })()`)
}

async function main(): Promise<void> {
  await connect()
  await sleep(2500)

  const url = await evaluate<string>('location.href')
  const ua = await evaluate<string>('navigator.userAgent')
  stage(
    '画布是 Desktop（不是 Edge）',
    /^dsh-app:\/\//.test(url) && /Electron/.test(ua) ? 'passed' : 'failed',
    `${url} | ${ua.slice(0, 60)}`,
  )

  // 进设置 → 插件页（共用 desktop-shell，与 desktop-acceptance 同一份实现）
  //
  // 先等界面真的渲染出来：桌面端冷启动要好几秒，固定 sleep 会在慢的时候
  // 拿到一个「按钮还没画出来」的页面，然后报「进不到配置页」——一个看起来
  // 像产品问题的假失败。
  let ready = false
  const bootDeadline = Date.now() + 60_000
  while (Date.now() < bootDeadline) {
    const hasMenu = await evaluate<boolean>(`(() => {
      return [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '账号菜单')
    })()`)
    if (hasMenu) {
      ready = true
      break
    }
    await sleep(800)
  }
  stage('桌面界面已就绪（账号菜单可点）', ready ? 'passed' : 'failed', ready ? '找到账号菜单' : '60 秒内没渲染出账号菜单')

  const shell: ShellCtx = {
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

  const onboarding = await dismissOnboarding(shell)
  stage('启动引导已处理', /^clean/.test(onboarding) ? 'passed' : 'failed', onboarding)

  const settings = await openSettings(shell)
  stage('设置面板打得开', settings.ok ? 'passed' : 'failed', settings.how)

  const plugin = await openPluginPage(shell)
  stage('进到了插件配置页', plugin.mounted ? 'passed' : 'failed', plugin.detail)

  /**
   * 找「复制回复」按钮，并**滚到视口内再量坐标**。
   *
   * ## 这一条几乎是这份文件最贵的一个坑
   *
   * 插件页是一条纵向长表单，实测高度上万像素，复制按钮在 y≈5600 的位置。
   * `getBoundingClientRect()` 给的是**相对视口**的坐标，于是：
   *
   *   - 量出来的 y=5600 落在 672 高的窗口外面；
   *   - `Input.dispatchMouseEvent` 发过去，浏览器把视口外的坐标当空气，
   *     什么都没点中；
   *   - 页面因此没有任何反馈，而脚本把这读成「点了没反应 = 页面卡住」。
   *
   * 四条用例全部报「卡住」，看起来像产品彻底坏了——实际上一次都没点中。
   * 所以这里先 `scrollIntoView`，再**重新量一次**坐标（滚动会改变读数）。
   */
  const scrollToCopyButton = async (): Promise<void> => {
    await evaluate<string>(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^复制回复/.test((x.innerText || '').trim()))
      if (b) b.scrollIntoView({ block: 'center' })
      return 'ok'
    })()`)
    await sleep(900)
  }

  const readCopyButton = async (): Promise<string> =>
    evaluate<string>(`(() => {
      for (const b of document.querySelectorAll('button')) {
        const t = (b.innerText || '').trim()
        if (/^复制回复|^已复制/.test(t)) {
          const r = b.getBoundingClientRect()
          if (r.width < 2) continue
          return JSON.stringify({
            text: t, disabled: b.disabled,
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
            inView: r.y > 0 && r.y < window.innerHeight,
          })
        }
      }
      return 'not-found'
    })()`)

  await scrollToCopyButton()
  const copyButton = await readCopyButton()

  if (copyButton === 'not-found') {
    stage('找到「复制回复」按钮', 'skipped', '页面上没有已确认的候选——本文件不造候选，请先跑 full 流程')
    process.exitCode = 1
  } else {
    const btn = JSON.parse(copyButton) as { text: string; disabled: boolean; x: number; y: number; inView: boolean }
    stage(
      '找到「复制回复」按钮',
      btn.disabled ? 'failed' : 'passed',
      `文字=「${btn.text}」disabled=${String(btn.disabled)} 在视口内=${String(btn.inView)}`,
    )
    if (!btn.inView) {
      // 滚了还在视口外，说明页面结构变了——继续点只会得到一堆假失败
      stage('复制按钮可点', 'failed', `滚动之后按钮仍在视口外（y=${btn.y}）`)
      process.exitCode = 1
      throw new Error('复制按钮不在视口内，后续用例无法进行')
    }

    /**
     * ## 先验「正常路径」，否则后面四条失败路径没有对照
     *
     * 只测失败会漏掉最基础的一件事：**剪贴板好使的时候，它是不是真的写了。**
     * 页面显示「已复制到剪贴板」是一句话，不是证据。所以这里写完立刻用
     * `readText()` 读回来比对——读不回来就如实记「无法读回校验」，
     * 绝不把「页面说成功」当成「真的成功」。
     */
    await scrollToCopyButton()
    const okSpot = JSON.parse(await readCopyButton()) as { x: number; y: number; inView: boolean }
    if (okSpot.inView) {
      const startedOk = Date.now()
      await clickAt(okSpot.x, okSpot.y)
      let okFeedback = ''
      const okDeadline = Date.now() + 5000
      while (Date.now() < okDeadline) {
        okFeedback = await copyFeedback()
        if (okFeedback !== '') break
        await sleep(200)
      }
      const okElapsed = Date.now() - startedOk
      const saidCopied = /^已复制到剪贴板/.test(okFeedback)
      stage(
        '正常路径：真实剪贴板下显示已复制',
        saidCopied ? 'passed' : 'failed',
        saidCopied ? `${okElapsed}ms 后显示「已复制到剪贴板」` : `${okElapsed}ms 后：${okFeedback.slice(0, 80) || '没有任何反馈'}`,
      )

      const readBack = await evaluate<string>(`(async () => {
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return 'no-read-api'
          const text = await Promise.race([
            navigator.clipboard.readText(),
            new Promise((r) => setTimeout(() => r('__timeout__'), 1500)),
          ])
          return typeof text === 'string' ? 'text:' + text : 'not-string'
        } catch (e) {
          return 'error:' + (e && e.name ? e.name : String(e))
        }
      })()`)

      if (readBack === 'no-read-api') {
        stage('正常路径：剪贴板内容能读回校验', 'skipped', '这个 webview 没提供 readText，无法读回——「已复制」这句话因此只有页面自述')
      } else if (readBack === '__timeout__') {
        stage('正常路径：剪贴板内容能读回校验', 'failed', 'readText 1.5 秒内没返回')
      } else if (readBack.startsWith('text:')) {
        const got = readBack.slice(5)
        const nonEmpty = got.trim().length > 0
        stage(
          '正常路径：剪贴板内容能读回校验',
          nonEmpty ? 'passed' : 'failed',
          nonEmpty ? `读回 ${got.length} 字符：${got.slice(0, 40).replace(/\n/g, ' ')}` : '读回来是空的——页面的「已复制」不成立',
        )
      } else {
        stage('正常路径：剪贴板内容能读回校验', 'skipped', `读回被拒绝（${readBack.slice(0, 60)}）`)
      }
      await sleep(500)
    }

    /**
     * ## 逐条构造失败
     *    /**
     * ## 逐条构造失败
     *
     * 每条都是：装坏实现 → 点复制 → 读反馈 → 恢复。
     *
     * 关键判据是**时间**：挂起那条如果 3 秒还没反馈，说明 1.5 秒超时没生效，
     * 页面卡住了——那正是当年那个 bug。
     */
    const cases: { mode: 'missing' | 'denied' | 'hang' | 'reject-late'; name: string; expectManual: boolean }[] = [
      { mode: 'missing', name: '剪贴板不存在（老 webview / 非安全上下文）', expectManual: true },
      { mode: 'denied', name: '剪贴板拒绝权限', expectManual: true },
      { mode: 'hang', name: 'writeText 永不返回（当年那个 bug）', expectManual: true },
      { mode: 'reject-late', name: 'writeText 延迟 800ms 才拒绝', expectManual: true },
    ]

    for (const c of cases) {
      await installBrokenClipboard(c.mode)
      // 上一条用例会在按钮下面插入整段正文（兜底文案），按钮位置被推下去，
      // 所以每条都要重新滚、重新量。用第一次的坐标会在第 2 条开始全空。
      await scrollToCopyButton()
      const fresh = await readCopyButton()
      if (fresh === 'not-found') {
        stage(c.name, 'failed', '找不到复制按钮了')
        continue
      }
      const spot = JSON.parse(fresh) as { x: number; y: number; inView: boolean }
      if (!spot.inView) {
        stage(c.name, 'failed', `按钮跑到视口外（y=${spot.y}）`)
        continue
      }
      const started = Date.now()
      await clickAt(spot.x, spot.y)

      // 最多等 5 秒；1.5 秒超时应该在 2 秒内就有反馈
      let feedback = ''
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        feedback = await copyFeedback()
        if (feedback !== '') break
        await sleep(200)
      }
      const elapsed = Date.now() - started

      const saysCopied = /^已复制到剪贴板/.test(feedback)
      const offersManual = /^这个环境不允许插件直接写剪贴板/.test(feedback)
      const hung = feedback === ''

      stage(
        c.name,
        !hung && !saysCopied && (c.expectManual ? offersManual : true) ? 'passed' : 'failed',
        hung
          ? `${elapsed}ms 内复制按钮下什么也没出现——页面没有给出任何反馈，等于卡住`
          : saysCopied
            ? `${elapsed}ms 后显示「已复制」——但剪贴板根本没写成功，这是谎话`
            : offersManual
              ? `${elapsed}ms 后给出手动复制兜底`
              : `${elapsed}ms 后出现了别的文案：${feedback.slice(0, 80)}`,
      )

      await restoreClipboard()
      await sleep(600)
      // 复位按钮状态：再点一次让 setCopied 清空（或重新读一次）
      await evaluate<string>(`(() => { window.scrollTo(0, 0); return 'ok' })()`)
    }

    // 恢复后必须回到可用状态——证明上面那些替换没有污染页面
    const styleStillThere = await evaluate<boolean>(`document.querySelector('style[data-plugin-css="dsh-ai-debate/card.css"]') !== null`)
    stage('测完之后插件仍完好', styleStillThere ? 'passed' : 'failed', styleStillThere ? '样式标签还在，页面没被替换搞坏' : '插件样式丢了')
  }

  const failed = stages.filter((s) => s.status === 'failed')
  const skipped = stages.filter((s) => s.status === 'skipped')

  /**
   * 落盘时一并记下「这是在哪份代码上跑的」。
   *
   * ## 没有这一段的后果
   *
   * 这份文件的 `clipboard-result.json` 原来只有阶段与时间。于是「13 项全过」
   * 这句话**没有主语**：过的是哪一版？如果之后 src 改了再没重跑，这份结果
   * 会一直躺在目录里，谁看到都会以为它还是有效的。
   *
   * 与 `e2e-manual-import` 用同一套 `headOf`：同一份代码树在两个脚本里必须
   * 算出同一个值，否则「绑定」这件事就只是各自的说法。
   */
  const head = EvidenceCollector.headOf('.')

  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    `${outDir}/clipboard-result.json`,
    JSON.stringify(
      {
        script: 'desktop-clipboard.ts',
        scriptVersion: CLIPBOARD_SCRIPT_VERSION,
        headSha: head.sha,
        testedTreeSha: head.tree,
        headDirty: head.dirty,
        startedAt,
        finishedAt: new Date().toISOString(),
        stages,
        verdict: failed.length === 0 && skipped.length === 0 ? 'passed' : 'failed',
      },
      null,
      2,
    ),
  )

  process.stdout.write(`\n结论：${failed.length === 0 && skipped.length === 0 ? 'passed' : 'failed'}（失败 ${failed.length}，跳过 ${skipped.length}）\n`)
  process.exitCode = failed.length === 0 && skipped.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  process.stdout.write(`✘ 探针自身出错：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
