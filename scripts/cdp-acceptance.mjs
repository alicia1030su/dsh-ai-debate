/**
 * Acceptance driver: walk the real DSH Web UI to the plugin's config page and
 * capture each step.
 *
 * Everything here reads the live DOM. Nothing asserts a shape it was told to
 * expect — the point is to find out what the page actually renders.
 *
 *   node scripts/cdp-acceptance.mjs <cdpPort> <outDir> <url> <step...>
 *
 * Steps are executed in order; each is one of:
 *   click:<text>      click the element whose trimmed text equals <text>
 *   clickContains:<t> click the element whose text contains <t>
 *   wait:<ms>         sleep
 *   shot:<name>       capture a screenshot
 *   text:<name>       dump document.body.innerText
 *   probe:<name>      dump a JSON summary of what is on screen
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2]
const outDir = process.argv[3]
const target = process.argv[4]
const steps = process.argv.slice(5)

mkdirSync(outDir, { recursive: true })

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const candidates = list.filter((t) => t.type === 'page')
  const page = candidates.find((t) => !t.url.startsWith('devtools://')) ?? candidates[0]
  if (!page) throw new Error('没有可用的 page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (m, p = {}) =>
    new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method: m, params: p }))
    })
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.rej(new Error(JSON.stringify(m.error)))
      else p.res(m.result)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  return { send, ws }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error('页面求值失败：' + JSON.stringify(result.exceptionDetails))
  }
  return result.result.value
}

/** Click helper injected into the page: clicks the deepest matching element. */
function clickScript(mode, needle) {
  return `(() => {
    const mode = ${JSON.stringify(mode)}
    const needle = ${JSON.stringify(needle)}
    const nodes = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],li,div,span,p')]
    const matches = nodes.filter((el) => {
      const text = (el.textContent || '').trim()
      if (!text) return false
      return mode === 'exact' ? text === needle : text.includes(needle)
    })
    if (matches.length === 0) return { clicked: null, tried: needle }
    // Prefer the smallest node that still matches: the outermost one would be body.
    matches.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)
    const el = matches[0]
    el.scrollIntoView({ block: 'center' })
    el.click()
    return {
      clicked: (el.textContent || '').trim().slice(0, 60),
      tag: el.tagName,
      cls: el.className && String(el.className).slice(0, 60),
    }
  })()`
}

async function main() {
  const { send, ws } = await connect()
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.enable')

  const log = []
  for (const step of steps) {
    const [kind, ...rest] = step.split(':')
    const arg = rest.join(':')
    if (kind === 'navigate') {
      await send('Page.navigate', { url: arg })
      await sleep(4000)
      log.push({ step, ok: true })
    } else if (kind === 'click') {
      const result = await evaluate(send, clickScript('exact', arg))
      await sleep(1800)
      log.push({ step, result })
    } else if (kind === 'clickContains') {
      const result = await evaluate(send, clickScript('contains', arg))
      await sleep(1800)
      log.push({ step, result })
    } else if (kind === 'wait') {
      await sleep(Number(arg) || 1000)
      log.push({ step, ok: true })
    } else if (kind === 'shot') {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(outDir, `${arg}.png`), Buffer.from(shot.data, 'base64'))
      log.push({ step, file: `${arg}.png` })
    } else if (kind === 'text') {
      const text = await evaluate(send, 'document.body.innerText')
      writeFileSync(join(outDir, `${arg}.txt`), String(text), 'utf8')
      log.push({ step, bytes: String(text).length })
    } else if (kind === 'probe') {
      const probe = await evaluate(
        send,
        `(() => {
          const tabs = [...document.querySelectorAll('[role="tab"],button')]
            .map((el) => (el.textContent || '').trim())
            .filter((t) => t && t.length < 20)
          const badges = [...document.querySelectorAll('.dsd-badge')]
            .map((el) => (el.textContent || '').trim())
          return {
            tabs,
            badges: [...new Set(badges)],
            sections: [...document.querySelectorAll('.dsd-block, .dsd-sect')].length,
            hasPlatformsIntro: document.body.innerText.includes('已接入'),
            bodyLen: document.body.innerText.length,
          }
        })()`,
      )
      writeFileSync(join(outDir, `${arg}.json`), JSON.stringify(probe, null, 2), 'utf8')
      log.push({ step, probe })
    } else {
      log.push({ step, skipped: 'unknown step' })
    }
  }

  writeFileSync(join(outDir, 'steps.json'), JSON.stringify(log, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(log, null, 2) + '\n')
  ws.close()
}

main().catch((error) => {
  process.stderr.write(String(error) + '\n')
  process.exit(1)
})
