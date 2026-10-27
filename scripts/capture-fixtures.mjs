/**
 * Capture real platform responses into `test/fixtures/`.
 *
 * Run this once by hand against the live site; the fixtures it writes are the
 * evidence the parsers are tested against. Not part of the build.
 *
 *   node scripts/capture-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures')
mkdirSync(OUT, { recursive: true })

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

const jar = new Map()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';', 1)[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

async function get(url, { ua = DESKTOP_UA, headers = {}, as = 'text' } = {}) {
  const h = { 'user-agent': ua, 'accept-language': 'zh-CN,zh;q=0.9', ...headers }
  if (jar.size) h.cookie = cookieHeader()
  const res = await fetch(url, { headers: h, redirect: 'follow' })
  absorb(res)
  if (as === 'buffer') return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) }
  return { status: res.status, text: await res.text() }
}

// Bootstrap: Tieba answers 403 with a security challenge until a BAIDUID cookie exists.
const boot = await get('https://www.baidu.com/')
console.log('bootstrap', boot.status, 'cookies', jar.size)

const TID = process.argv[2] ?? '6826726803'

const first = await get(`https://tieba.baidu.com/mo/q/m?kz=${TID}&pn=0`, { ua: MOBILE_UA })
writeFileSync(join(OUT, 'wap-page1.html'), first.text)
console.log('wap page1', first.status, first.text.length)

const second = await get(`https://tieba.baidu.com/mo/q/m?kz=${TID}&pn=30`, { ua: MOBILE_UA })
writeFileSync(join(OUT, 'wap-page2.html'), second.text)
console.log('wap page2', second.status, second.text.length)

// A thread with floor-level nested replies, to exercise the 楼中楼 parsers.
const SMALL_TID = '8752343543'
const small = await get(`https://tieba.baidu.com/mo/q/m?kz=${SMALL_TID}&pn=0`, { ua: MOBILE_UA })
writeFileSync(join(OUT, 'wap-small.html'), small.text)
console.log('wap small', small.status, small.text.length)

const fidMatch = /\bfid:\s*["']?(\d+)/.exec(small.text)
const fid = fidMatch?.[1] ?? ''
console.log('fid', fid)

const total = await get(
  `https://tieba.baidu.com/p/totalComment?tid=${SMALL_TID}&fid=${fid}&pn=1&see_lz=0`,
  { headers: { 'x-requested-with': 'XMLHttpRequest' } },
)
writeFileSync(join(OUT, 'total-comment.json'), total.text)
console.log('totalComment', total.status, total.text.length)

// The comment page is GBK; keep the raw bytes so the decoder is tested honestly.
const totalJson = JSON.parse(total.text)
const pid = Object.entries(totalJson.data?.comment_list ?? {})
  .sort((a, b) => (b[1].comment_num ?? 0) - (a[1].comment_num ?? 0))[0]?.[0]
console.log('busiest nested pid', pid)

if (pid) {
  const comments = await get(
    `https://tieba.baidu.com/p/comment?tid=${SMALL_TID}&pid=${pid}&pn=1`,
    { as: 'buffer' },
  )
  writeFileSync(join(OUT, 'comment-page1.gbk.bin'), comments.buf)
  console.log('comment page1', comments.status, comments.buf.length, 'bytes')
}

const unauth = await get('https://tieba.baidu.com/f/commit/post/add', {
  headers: { 'x-requested-with': 'XMLHttpRequest' },
})
writeFileSync(join(OUT, 'publish-unauth.json'), unauth.text)
console.log('publish (unauthenticated)', unauth.status, unauth.text.slice(0, 160))
