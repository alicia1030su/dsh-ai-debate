/**
 * Drive a real Edge page over CDP: navigate, click, screenshot, dump text.
 *
 * Used for acceptance. Everything it reports comes from the live page — no
 * expectation about what the page "should" contain is baked in.
 *
 *   node scripts/cdp-drive.mjs <cdpPort> <outDir> <url> [--tab=<label>]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2]
const outDir = process.argv[3]
const target = process.argv[4]
const tabArg = process.argv.find((a) => a.startsWith('--tab='))
const wantTab = tabArg ? tabArg.slice('--tab='.length) : undefined

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

async function main() {
  const { send, ws } = await connect()
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const loaded = new Promise((resolve) => {
    const handler = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Page.loadEventFired') resolve()
    }
    ws.addEventListener('message', handler)
  })
  await send('Page.navigate', { url: target })
  await Promise.race([loaded, sleep(15000)])
  await sleep(3500)

  // Open the settings surface the way a user does: sidebar Settings → Plugins row.
  const opened = await evaluate(
    send,
    `(async () => {
      const texts = []
      const clickable = [...document.querySelectorAll('button,a,[role="button"],[role="tab"]')]
      for (const el of clickable) texts.push((el.textContent || '').trim())
      return { count: clickable.length, sample: texts.filter(Boolean).slice(0, 60) }
    })()`,
  )
  writeFileSync(join(outDir, '00-clickable.json'), JSON.stringify(opened, null, 2), 'utf8')

  if (wantTab) {
    const clicked = await evaluate(
      send,
      `(async () => {
        const labels = ${JSON.stringify(wantTab)}.split('|')
        for (const label of labels) {
          const found = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],div,span')]
            .filter((el) => (el.textContent || '').trim() === label)
          if (found.length > 0) {
            const el = found[found.length - 1]
            el.click()
            return { clicked: label, tag: el.tagName }
          }
        }
        return { clicked: null }
      })()`,
    )
    writeFileSync(join(outDir, '01-click.json'), JSON.stringify(clicked, null, 2), 'utf8')
    await sleep(2500)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, '02-page.png'), Buffer.from(shot.data, 'base64'))

  const text = await evaluate(send, 'document.body.innerText')
  writeFileSync(join(outDir, '03-text.txt'), String(text), 'utf8')
  const html = await evaluate(send, 'document.body.innerHTML.length')
  writeFileSync(join(outDir, '04-html-len.txt'), String(html), 'utf8')

  process.stdout.write(`screenshot: ${join(outDir, '02-page.png')}\n`)
  process.stdout.write(`text bytes: ${String(text).length}\n`)
  ws.close()
}

main().catch((error) => {
  process.stderr.write(String(error) + '\n')
  process.exit(1)
})
