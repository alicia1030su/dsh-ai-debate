/**
 * Bump the version in the two places that must agree.
 *
 * Writes through `writeFileSync` with an explicit encoding rather than PowerShell:
 * `Set-Content -Encoding UTF8` on this machine prepends a BOM, and a BOM in
 * `package.json` makes `JSON.parse` fail with "Unexpected token" — which `pack.mjs`
 * then reports against the tarball, not against the file that was edited.
 */
import fs from 'node:fs'

const next = process.argv[2]
if (next === undefined || !/^\d+\.\d+\.\d+$/.test(next)) {
  throw new Error('用法：node tmp-bump-version.mjs <x.y.z>')
}

const root = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate'
const pkgPath = `${root}/package.json`

const raw = fs.readFileSync(pkgPath, 'utf8')
if (raw.charCodeAt(0) === 0xfeff) throw new Error('package.json 已经带 BOM，先修掉再改版本')
const pkg = JSON.parse(raw)
const previous = pkg.version
pkg.version = next
// `JSON.stringify` would reformat the whole file; keep the original 2-space shape and
// trailing newline so the diff is one line.
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

// The version is read from package.json at runtime, so nothing else needs editing — but
// a stale literal in the patch file would still be installed by `dsh plugin add`.
const patchPath = `${root}/cordis.patch.yml`
if (fs.existsSync(patchPath)) {
  const patch = fs.readFileSync(patchPath, 'utf8')
  const updated = patch.replace(/version:\s*[0-9]+\.[0-9]+\.[0-9]+/g, `version: ${next}`)
  if (updated !== patch) {
    fs.writeFileSync(patchPath, updated, 'utf8')
    console.log('cordis.patch.yml 已更新')
  }
}

console.log(`版本：${previous} → ${next}`)
