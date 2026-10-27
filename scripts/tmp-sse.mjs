/** Does the Host watch the client bundle and rebuild it? */
const res = await fetch('http://127.0.0.1:63169/plugins/events')
if (!res.ok) { console.log('SSE status', res.status); process.exit(0) }
const reader = res.body.getReader()
const dec = new TextDecoder()
const events = []
const pump = (async () => {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    events.push(dec.decode(value))
  }
})()
await new Promise(r => setTimeout(r, 1200))
const { utimesSync, statSync } = await import('node:fs')
const p = process.env.USERPROFILE + '/.dsh/plugins/dsh-ai-debate/package/client/client.cjs'
const now = new Date()
utimesSync(p, now, now)
console.log('touched bundle; size', statSync(p).size)
await pump.catch(() => {})
console.log('events after touch:', JSON.stringify(events))
process.exit(0)
