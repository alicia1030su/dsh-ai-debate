/**
 * Dump the DOM around one element, to find out how to open it.
 *
 * Guessing selectors wastes cycles; asking the page what it contains does not.
 *
 *   node scripts/cdp-probe.mjs <cdpPort> <needle>
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

const main = async () => {
  const { send, ws } = await connect()
  const out = await evaluate(
    send,
    `(() => {
      const needle = ${JSON.stringify(needle)}
      const all = [...document.querySelectorAll('*')]
      const hit = all.find((el) => (el.textContent || '').trim() === needle)
      if (!hit) return { found: false }
      // Walk up until the container looks like a whole row.
      let node = hit
      for (let i = 0; i < 6 && node.parentElement; i += 1) node = node.parentElement
      const describe = (el) => ({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 80),
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        text: (el.textContent || '').trim().slice(0, 80),
        tagCount: el.querySelectorAll('*').length,
      })
      return {
        found: true,
        chain: [hit, hit.parentElement, hit.parentElement?.parentElement].filter(Boolean).map(describe),
        container: describe(node),
        buttons: [...node.querySelectorAll('button,[role="button"],svg,a')].map(describe).slice(0, 20),
        containerHtml: node.outerHTML.slice(0, 3000),
      }
    })()`,
  )
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  ws.close()
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
