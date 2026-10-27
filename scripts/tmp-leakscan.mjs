/** Credential-leak scan over everything this release ships or publishes. */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { listTar } from './tar.mjs'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const PATTERNS = [
  { re: /BDUSS\s*=\s*[A-Za-z0-9]{10,}/, label: 'BDUSS cookie' },
  { re: /ST\s*=\s*[A-Za-z0-9]{10,}/, label: 'ST cookie' },
  { re: /BAIDUID\s*=\s*[A-Za-z0-9]{10,}/, label: 'BAIDUID cookie' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'API key (sk-)' },
  { re: /as_sk_[A-Za-z0-9]{10,}/, label: 'API key (as_sk_)' },
  { re: /attacker-value-123/, label: 'the test value I injected' },
]

const problems = []
const scan = (label, text) => {
  for (const p of PATTERNS) {
    if (p.re.test(text)) problems.push(`${label}: found ${p.label}`)
  }
}

// 1. the tarball
const tar = gunzipSync(readFileSync(join(root, `dsh-ai-debate-${pkg.version}.tgz`)))
const entries = listTar(tar)
let off = 0
let tarChecked = 0
for (const e of entries) {
  const block = tar.subarray(off, off + 512)
  const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/[\u0000 ]+$/s, '').trim(), 8) || 0
  const body = off + 512
  if (e.type !== '5') {
    const text = tar.subarray(body, body + size).toString('utf8')
    scan(`tgz:${e.path}`, text)
    tarChecked++
  }
  off = body + Math.ceil(size / 512) * 512
}

// 2. the tree that will be published (src, client, test, scripts, docs)
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|js|cjs|mjs|md|json|yml|yaml|example)$/.test(name)) out.push(p)
  }
  return out
}
const treeFiles = walk(root).filter((p) => !p.endsWith('.tgz') && !p.endsWith('.zip'))
for (const p of treeFiles) {
  const rel = relative(root, p).replaceAll('\\', '/')
  // The changelog deliberately quotes the detector's own regexes; skip that one line.
  const text = readFileSync(p, 'utf8')
  const scrubbed = text.replace(/BAIDUID\s*=\s*\[A-Za-z0-9\]\{10,\}[\s\S]{0,200}/g, '')
  scan(`tree:${rel}`, scrubbed)
}

console.log(`tgz files scanned : ${tarChecked}`)
console.log(`tree files scanned: ${treeFiles.length}`)
if (problems.length === 0) {
  console.log('RESULT: no credential material found')
} else {
  console.log('RESULT: LEAK')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
