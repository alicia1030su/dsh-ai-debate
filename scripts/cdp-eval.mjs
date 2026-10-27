/**
 * Run one expression inside the page and print its value.
 *
 * Escaping an expression through several shells is how a probe silently becomes a
 * different probe, so the expression lives in this file instead.
 *
 *   node scripts/cdp-eval.mjs <cdpPort> <expressionFile>
 */
import { readFileSync } from 'node:fs'

const port = process.argv[2]
const file = process.argv[3]
const expression = readFileSync(file, 'utf8').trim()

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

const main = async () => {
  const { send, ws } = await connect()
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    process.stderr.write(JSON.stringify(result.exceptionDetails, null, 2) + '\n')
    process.exitCode = 1
  } else {
    process.stdout.write(JSON.stringify(result.result.value, null, 2) + '\n')
  }
  ws.close()
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
