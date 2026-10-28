/**
 * A tiny CDP driver for verifying the real UI in the isolated instance.
 *
 * ## Why a script instead of screenshots
 *
 * A screenshot proves "something rendered" but not *what*, and pulling one through the
 * harness costs tens of thousands of tokens of base64. `Runtime.evaluate` answers the
 * questions that matter here — does the tab exist, does the body text appear, what does
 * clicking do — as a few hundred bytes of JSON.
 *
 * ## Why not a browser-automation dependency
 *
 * Node 24 ships a global `WebSocket`, and CDP over it is a dozen lines. Adding Playwright
 * to verify a UI would put it in `devDependencies` and in every future install.
 *
 * Usage:
 *   node tmp-cdp.mjs eval "<expression>"
 *   node tmp-cdp.mjs screenshot <out.png>
 *   node tmp-cdp.mjs click "<css selector or text>"
 *   node tmp-cdp.mjs text
 */
const PORT = process.argv[2]
const command = process.argv[3]
const argument = process.argv.slice(4).join(' ')

if (!PORT || !command) {
  console.error('用法：node tmp-cdp.mjs <port> <eval|screenshot|click|text> [argument]')
  process.exit(2)
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((entry) => entry.type === 'page' && entry.url.startsWith('http://127.0.0.1'))
if (page === undefined) {
  console.error('找不到页面 target：', targets.map((entry) => `${entry.type} ${entry.url}`).join(' | '))
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (waiter !== undefined) {
    pending.delete(message.id)
    waiter(message)
  }
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

/** Send one CDP command and await its reply. */
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (reply.result?.exceptionDetails !== undefined) {
    throw new Error(reply.result.exceptionDetails.text ?? 'evaluation threw')
  }
  return reply.result?.result?.value
}

if (command === 'eval') {
  console.log(JSON.stringify(await evaluate(argument), null, 2))
} else if (command === 'text') {
  const text = await evaluate('document.body.innerText')
  console.log(text)
} else if (command === 'click') {
  // Match by visible text first (what a user clicks), then by selector.
  const result = await evaluate(`(() => {
    const needle = ${JSON.stringify(argument)}
    const byText = [...document.querySelectorAll('button, a, [role="tab"], [role="button"]')]
      .filter((node) => (node.textContent || '').includes(needle))
    if (byText.length > 0) { byText[0].click(); return { clicked: 'text', label: byText[0].textContent } }
    const bySelector = document.querySelector(needle)
    if (bySelector) { bySelector.click(); return { clicked: 'selector', label: bySelector.textContent } }
    return { clicked: null, label: null }
  })()`)
  console.log(JSON.stringify(result))
} else if (command === 'screenshot') {
  const reply = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(argument, Buffer.from(reply.result.data, 'base64'))
  console.log('written', argument)
} else {
  console.error(`未知命令：${command}`)
  process.exit(2)
}

socket.close()
