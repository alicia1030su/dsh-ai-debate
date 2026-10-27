/**
 * Capture every page of one real thread into `test/fixtures/paged/`.
 *
 * The pagination test runs against these, so it exercises the real markup and
 * the real gaps left by deleted floors rather than a hand-written mock.
 *
 *   node scripts/capture-pages.mjs [tid] [baseUrl]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'paged')
mkdirSync(OUT, { recursive: true })

const MUA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const DUA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const jar = new Map()
const ck = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const p = raw.split(';', 1)[0] ?? ''
    const eq = p.indexOf('=')
    if (eq > 0) jar.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim())
  }
}
async function get(url, ua) {
  const h = { 'user-agent': ua, 'accept-language': 'zh-CN,zh;q=0.9' }
  if (jar.size) h.cookie = ck()
  const res = await fetch(url, { headers: h, redirect: 'follow' })
  absorb(res)
  return { status: res.status, text: await res.text() }
}

await get('https://www.baidu.com/', DUA)

const TID = process.argv[2] ?? '6826726803'
const first = await get(`https://tieba.baidu.com/mo/q/m?kz=${TID}&pn=0`, MUA)
const meta = /\bpage:\s*\{([^}]*)\}/.exec(first.text)?.[1] ?? ''
const totalPages = Number(/"total_page"\s*:\s*(\d+)/.exec(meta)?.[1] ?? 1)
const totalNum = Number(/"total_num"\s*:\s*(\d+)/.exec(meta)?.[1] ?? 0)
writeFileSync(join(OUT, `page-1.html`), first.text)
console.log(`tid=${TID} totalPages=${totalPages} totalNum=${totalNum}`)

for (let page = 2; page <= totalPages; page += 1) {
  const offset = (page - 1) * 30
  const res = await get(`https://tieba.baidu.com/mo/q/m?kz=${TID}&pn=${offset}`, MUA)
  writeFileSync(join(OUT, `page-${page}.html`), res.text)
  const floors = (res.text.match(/<li\s+tid="\d+"\s+data-tid="\d+"\s+fn="\d+"/g) ?? []).length
  console.log(`page ${page}: ${res.status} ${res.text.length} bytes, ${floors} floors`)
  await new Promise((r) => setTimeout(r, 500))
}

writeFileSync(
  join(OUT, 'meta.json'),
  `${JSON.stringify({ tid: TID, totalPages, totalNum, capturedAt: new Date().toISOString() }, undefined, 2)}\n`,
)
console.log('done')
