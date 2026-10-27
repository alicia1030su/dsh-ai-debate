/**
 * Close any modal that is covering the page, without knowing its markup.
 *
 * A dialog blocks clicks underneath, and its presence is a property of the
 * deployment (logged in or not), not of the plugin. Trying Escape and the common
 * dismiss affordances is more robust than hard-coding one selector.
 */
const port = process.argv[2]

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
  // Escape first: most shells close their dialog on it.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)

  const result = await evaluate(
    send,
    `(() => {
      // Anything that looks like a modal close control.
      const buttons = [...document.querySelectorAll('button,[role="button"]')]
      const closers = buttons.filter((el) => {
        const aria = (el.getAttribute('aria-label') || '').trim()
        const title = (el.getAttribute('title') || '').trim()
        const text = (el.textContent || '').trim()
        return (
          aria.includes('关闭') || aria.includes('Close') ||
          title.includes('关闭') || title.includes('Close') ||
          text === '✕' || text === '×' || text === '关闭'
        )
      })
      for (const el of closers) el.click()
      // Also try a backdrop click, which several shells use.
      const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')]
      for (const d of dialogs) d.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return {
        closers: closers.length,
        dialogs: dialogs.length,
        stillHasDialog: [...document.querySelectorAll('[role="dialog"],dialog')].length,
      }
    })()`,
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  ws.close()
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
