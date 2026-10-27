/**
 * Click by accessible name, anywhere in the page.
 *
 * The plugin row's title is a plain div, so text matching finds the label rather
 * than the control. The real control is the "查看 X" button, which carries an
 * aria-label — clicking that is what a user does.
 *
 *   node scripts/cdp-click-aria.mjs <cdpPort> <ariaNeedle>
 */
const port = process.argv[2]
const needle = process.argv[3]

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
  const before = await evaluate(
    send,
    `[...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')).filter((v) => v)`,
  )
  process.stdout.write('aria labels: ' + JSON.stringify(before) + '\n')

  const clicked = await evaluate(
    send,
    `(() => {
      const needle = ${JSON.stringify(needle)}
      const all = [...document.querySelectorAll('[aria-label],button,[role="button"]')]
      const hit = all.find((el) => (el.getAttribute('aria-label') || '').includes(needle))
      if (!hit) return { clicked: null, labels: all.map((el) => el.getAttribute('aria-label')).filter(Boolean) }
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return { clicked: hit.getAttribute('aria-label'), tag: hit.tagName, cls: String(hit.className || '').slice(0, 60) }
    })()`,
  )
  process.stdout.write(JSON.stringify(clicked, null, 2) + '\n')
  await sleep(2500)

  const after = await evaluate(send, 'document.body.innerText')
  process.stdout.write('--- body text ---\n' + String(after).slice(0, 2000) + '\n')
  ws.close()
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
