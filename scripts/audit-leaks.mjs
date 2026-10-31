/**
 * Credential-leak scan.
 *
 * Fixtures are named `fixture-…` so this scan can tell them from a real secret:
 * a scan that has to whitelist its own test data cannot be trusted to run in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { listTar } from './tar.mjs'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const PATTERNS = [
  { re: /BDUSS=(?!fixture-)[A-Za-z0-9]{10,}/, label: 'BDUSS cookie' },
  { re: /\bST=(?!fixture-)[A-Za-z0-9]{8,}/, label: 'ST cookie' },
  { re: /BAIDUID=(?!fixture-)[A-Za-z0-9]{10,}/, label: 'BAIDUID cookie' },
  { re: /\bsk-(?!fixture-)[A-Za-z0-9]{20,}/, label: 'API key (sk-)' },
  { re: /as_sk_[A-Za-z0-9]{10,}/, label: 'API key (as_sk_)' },
]

const problems = []
const scan = (label, text) => {
  for (const p of PATTERNS) if (p.re.test(text)) problems.push(`${label}: ${p.label}`)
}

const tar = gunzipSync(readFileSync(join(root, `dsh-ai-debate-${pkg.version}.tgz`)))
const entries = listTar(tar)
let off = 0
let tarChecked = 0
for (const e of entries) {
  const block = tar.subarray(off, off + 512)
  const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/[\u0000 ]+$/s, '').trim(), 8) || 0
  const body = off + 512
  if (e.type !== '5') { scan(`tgz:${e.path}`, tar.subarray(body, body + size).toString('utf8')); tarChecked++ }
  off = body + Math.ceil(size / 512) * 512
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|js|cjs|mjs|md|json|yml|yaml|example)$/.test(name) && !/^tmp-/.test(name)) out.push(p)
  }
  return out
}
const tree = walk(root).filter((p) => !p.endsWith('.tgz') && !p.endsWith('.zip'))
for (const p of tree) scan(`tree:${relative(root, p).replaceAll('\\', '/')}`, readFileSync(p, 'utf8'))

console.log(`tgz files : ${tarChecked}`)
console.log(`tree files: ${tree.length}`)
if (problems.length === 0) console.log('RESULT: no credential material found')
else { console.log('RESULT: LEAK'); for (const p of problems) console.log('  - ' + p); process.exit(1) }
