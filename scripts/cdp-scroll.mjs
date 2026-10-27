/**
 * Scroll the main scroll container and capture a full-page-ish sequence.
 *
 *   node scripts/cdp-scroll.mjs <cdpPort> <outDir> <prefix> <count> <px>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2]
const outDir = process.argv[3]
const prefix = process.argv[4] ?? 'scroll'
const count = Number(process.argv[5] ?? 4)
const px = Number(process.argv[6] ?? 800)

mkdirSync(outDir, { recursive: true })

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.filter((t) => t.type === 'page').find((t) => !t.url.startsWith('devtools://'))
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
  await send('Runtime.enable')
  await send('Page.enable')
  return { send, ws }
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  const { send, ws } = await connect()
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })

  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      // Scroll whatever actually scrolls: the deepest element with room to scroll.
      const moved = await evaluate(
        send,
        `(() => {
          const candidates = [...document.querySelectorAll('div,main,section')].filter((el) => {
            const style = getComputedStyle(el)
            return (
              (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
              el.scrollHeight > el.clientHeight + 40
            )
          })
          candidates.sort((a, b) => b.clientHeight - a.clientHeight)
          const target = candidates[0]
          if (!target) { window.scrollBy(0, ${px}); return { scrolled: 'window' } }
          target.scrollTop += ${px}
          return { scrolled: target.className ? String(target.className).slice(0, 50) : target.tagName, top: target.scrollTop }
        })()`,
      )
      process.stdout.write(JSON.stringify(moved) + '\n')
      await sleep(1200)
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `${prefix}-${String(index).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'))
  }

  const text = await evaluate(send, 'document.body.innerText')
  writeFileSync(join(outDir, `${prefix}.txt`), String(text), 'utf8')
  process.stdout.write(`shots: ${count}, text bytes: ${String(text).length}\n`)
  ws.close()
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
