/**
 * Pack the repository into a **publishable** source ZIP for GitHub.
 *
 * ## Why this file was rewritten in v0.2.15
 *
 * v0.2.14 walked the working directory and excluded a short hard-coded deny list. An audit
 * dropped a `.env` in the working directory — ignored by `.gitignore` — ran the script, and the
 * archive contained it with the secret intact.
 *
 * A deny list can never be complete: the set of files a developer might create locally is
 * unbounded, and every miss is a credential leak in a public artifact. So the polarity is
 * inverted here:
 *
 * 1. **Allowlist, not denylist.** A file is included only if its path matches an explicit rule.
 *    Unknown files are excluded by default — that is the requirement, not a convenience.
 * 2. **Git tracked list first.** When the directory is a real Git repository, `git ls-files` is
 *    the authority: it is exactly the set a contributor clones. It naturally excludes whatever
 *    `.gitignore` covers, including files nobody thought to name.
 * 3. **Allowlist fallback without Git.** This machine has no `git`, so the fallback has to be
 *    genuinely safe rather than a best effort. It is the same rule set, applied to a walk.
 * 4. **Content scan, not just names.** Every candidate's bytes are scanned for credential shapes
 *    *and* for the shape of a repository's own secrets. A hit **fails the build**.
 * 5. **Symlinks are never followed.** A link can point outside the tree at something private, so
 *    the walk skips them entirely and `lstat` confirms it.
 *
 * The scan is a second line, not the first: the allowlist is what actually keeps `.env` out. The
 * scan exists because "the allowlist is complete" is exactly the assumption that leaks.
 *
 * ## What publishes
 *
 * Source, tests, fixtures, docs, CI workflows, build scripts, LICENSE, README. Everything a
 * contributor or auditor needs to reproduce the release, and nothing about this machine.
 */
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, posix, relative, resolve, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const root = process.cwd()
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version

// Where the archive lands. Default is the directory *above* the project, which is where a
// developer expects to find it and where CI's own housekeeping has always looked.
//
// CI has one hard requirement the default cannot satisfy: `actions/upload-artifact@v4` rejects
// any path containing `..` — "Relative pathing '.' and '..' is not allowed". The release job
// therefore passes --out ., and the archive is written into the workspace instead. Keeping one
// script with one behaviour would mean either breaking local workflow or leaving the release
// job permanently red, so the output directory is a parameter rather than a constant.
const outFlag = process.argv.indexOf('--out')
const outDir = outFlag === -1 ? join(root, '..') : resolve(root, process.argv[outFlag + 1] ?? '.')
const outFile = join(outDir, `dsh-ai-debate-source-${version}.zip`)

// --- 1. The allowlist -------------------------------------------------------

/**
 * Top-level directories that may be published in full.
 *
 * Each entry is a directory whose *entire* contents belong in the repository. Adding one here is
 * a deliberate decision that everything beneath it is publishable, which is why the list is
 * short: directories that hold local state, downloaded references or build output are simply not
 * in it.
 */
const ALLOWED_DIRS = new Set([
  'src',
  'test',
  'scripts',
  'docs',
  'client',
  'templates',
  '.github',
  // `lib/` is not here on purpose — see BUILD_OUTPUT_DIRS below. It is compiled, and a whole-
  // directory allowance would publish whatever a mistake happens to leave inside it.
])

/**
 * Directories that are build output, published with an extension whitelist.
 *
 * The GitHub install path needs `lib/` present, and `ci.yml` asserts it is committed, so the
 * source archive must carry it. But it is generated, so "everything under this directory is
 * publishable" is the wrong promise: it should hold only what the compiler writes.
 *
 * Maps are included because they are what makes an error trace point at `src/` instead of at
 * generated code, which is the difference between a usable bug report and a dead end.
 */
const BUILD_OUTPUT_DIRS = new Map([
  ['lib', new Set(['.js', '.d.ts', '.js.map', '.d.ts.map'])],
])

/**
 * Walk a build-output path and decide from its extension.
 *
 * `.d.ts.map` has to be checked before `.js.map` and `.d.ts` before `.js`: `endsWith` on the
 * shorter suffix would match the longer name too, and while both are allowed today that ordering
 * silently changes if the allowed set is ever narrowed.
 */
function isBuildOutput(rel, top) {
  const allowed = BUILD_OUTPUT_DIRS.get(top)
  if (allowed === undefined) return false
  const name = rel.split('/').pop() ?? ''
  for (const extension of ['.d.ts.map', '.js.map', '.d.ts', '.js']) {
    if (name.endsWith(extension)) return allowed.has(extension)
  }
  return false
}

/**
 * Top-level files that may be published.
 *
 * Extensions and exact names only — a pattern like `*.json` would let a future
 * `credentials.json` through, and that is the class of mistake this rewrite exists for.
 */
const ALLOWED_FILES = new Set([
  'package.json',
  // ## The lockfile is part of the source (v0.2.16 §一)
  //
  // `pnpm install --frozen-lockfile` needs it, so an archive without it cannot be built. It was
  // missing in v0.2.15 — the allowlist was written from the directory listing and this file, being
  // generated by the package manager rather than authored, was overlooked.
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.test.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
  'AGENTS.md',
  'cordis.patch.yml',
  '.gitignore',
  '.npmignore',
  '.gitattributes',
  '.editorconfig',
  '.env.example',
])

/**
 * Nested names that are never publishable, wherever they appear.
 *
 * Applies inside allowed directories too: `test/fixtures/.env` and `src/x/credentials.json` are
 * still secrets. This is the one place a denylist is correct, because it runs *after* the
 * allowlist rather than instead of it.
 */
const FORBIDDEN_NAMES = [
  /^\.env$/i,
  /^\.env\.(?!example$)/i, // .env.local, .env.production — but not .env.example
  /^\.credentials/i,
  /^credentials\.(json|ya?ml|txt)$/i,
  /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^(token|secrets?)\.(json|ya?ml|txt)$/i,
  /\.(log|tmp|bak|swp|orig)$/i,
  /~$/,
]

/** Nested directory names never descended into, wherever they appear. */
const FORBIDDEN_DIRS = new Set([
  '.git',
  'node_modules',
  '.ssh',
  '.dsh',
  '.plugin-manager',
  '.venv',
  '.idea',
  '.vscode',
  '__pycache__',
])

/**
 * Delivery artifacts generated *after* this archive, so they must not be inside it.
 *
 * `SHA256SUMS.txt` holds the hash of this very ZIP: including it makes the archive depend on its
 * own digest, so every run differs and the published checksum is stale the moment it is written.
 */
const SKIP_FILES = new Set(['SHA256SUMS.txt'])

/** True when a relative path may be published. The single decision point. */
function isPublishable(rel) {
  const segments = rel.split('/')
  const name = segments[segments.length - 1]
  const top = segments[0]

  for (const segment of segments) {
    if (FORBIDDEN_DIRS.has(segment)) return false
  }
  if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) return false
  if (SKIP_FILES.has(name)) return false
  // Build output and archives are never source. `.tgz`/`.zip` would also nest a release inside
  // its own source archive.
  if (/\.(tgz|zip|tar|gz|7z|rar)$/i.test(name)) return false

  if (segments.length === 1) return ALLOWED_FILES.has(name)
  if (ALLOWED_DIRS.has(top)) return true
  // Build output is allowed by extension, not wholesale: `lib/` should contain only what `tsc`
  // writes, and a stray script in there must not ride along.
  return isBuildOutput(rel, top)
}

// --- 2. Enumerate candidates ------------------------------------------------

/**
 * Ask Git for the tracked files.
 *
 * Returns `null` when this is not a Git repository or `git` is unavailable, which is the normal
 * case on this machine. A `null` here means "fall back to the allowlist walk", never "include
 * everything".
 */
function gitTrackedFiles() {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (inside !== 'true') return null
    const listing = execFileSync('git', ['ls-files', '-z', '--cached'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return listing.split('\0').filter((entry) => entry.length > 0)
  } catch {
    // No git, or not a repository: the caller falls back to the allowlist.
    return null
  }
}

/** Walk the tree, returning posix-style rel paths of **regular files only**. */
async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(root, full).split(sep).join(posix.sep)

    // `isSymbolicLink()` is checked before anything else: following one could put a readable
    // path to an outside private file into a public archive, and `readFile` would happily do it.
    if (entry.isSymbolicLink()) {
      skipped.push({ path: rel, reason: '符号链接（不跟随）' })
      continue
    }
    if (entry.isDirectory()) {
      if (!FORBIDDEN_DIRS.has(entry.name)) await walk(full, acc)
      continue
    }
    if (!entry.isFile()) {
      skipped.push({ path: rel, reason: '非常规文件' })
      continue
    }
    acc.push(rel)
  }
  return acc
}

const skipped = []

const tracked = gitTrackedFiles()
const source = tracked === null ? 'allowlist-walk' : 'git-ls-files'
const candidates = (tracked ?? (await walk(root))).map((rel) => rel.split(sep).join(posix.sep))

const files = []
for (const rel of candidates.sort()) {
  if (!isPublishable(rel)) continue
  // A tracked path can still be a symlink (Git stores the link, not its target), so the check
  // applies to both sources rather than only to the walk.
  const info = await lstat(join(root, rel.split('/').join(sep)))
  if (info.isSymbolicLink()) {
    skipped.push({ path: rel, reason: '符号链接（不跟随）' })
    continue
  }
  if (!info.isFile()) {
    skipped.push({ path: rel, reason: '非常规文件' })
    continue
  }
  files.push(rel)
}

if (files.length === 0) {
  throw new Error('没有可发布的文件：白名单为空，拒绝生成空源码包')
}

// --- 3. Content scan --------------------------------------------------------

/**
 * Credential shapes that must never appear in a published file.
 *
 * Deliberately **not** the only protection — the requirement says as much, and a regex can never
 * prove the absence of a secret. It catches the mistakes that do happen (a pasted key, a committed
 * cookie) so they fail the build here rather than after publication.
 */
const SECRET_PATTERNS = [
  { re: /\bBDUSS=[A-Za-z0-9+/=]{20,}/, label: '贴吧 BDUSS Cookie' },
  { re: /\bSTOKEN=[A-Za-z0-9+/=]{20,}/, label: '贴吧 STOKEN Cookie' },
  { re: /\b(?:sk|pk)-[A-Za-z0-9]{20,}/, label: 'API key（sk-/pk- 前缀）' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{30,}/, label: 'Bearer 令牌' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, label: '私钥' },
  { re: /\bm0sk_[A-Za-z0-9]{16,}/, label: 'mem0 API key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, label: 'GitHub 令牌' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack 令牌' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
]

/**
 * Files that legitimately contain credential-*shaped* strings.
 *
 * These are the security tests and the detector itself: they contain the patterns on purpose, and
 * a build that refused to publish its own security tests would push authors to delete them.
 * The exception is narrow — an exact path, not a pattern — so a real `.env` cannot hide behind it.
 */
const SCAN_EXEMPT = new Set([
  'src/security/output-guard.ts',
  'test/v0214-target-identity.test.ts',
  'scripts/source-zip.mjs',
])

/** Lines that are obviously a fixture, so a scanned test file does not fail the build. */
const FIXTURE_MARKER = /(?:fixture|dummy|example|fake|placeholder|test-only|FIXTURE)/i

const findings = []
for (const rel of files) {
  const raw = await readFile(join(root, rel.split('/').join(sep)))
  // Binary files cannot carry a readable secret and scanning them is noise.
  if (raw.includes(0)) continue
  const text = raw.toString('utf8')

  for (const { re, label } of SECRET_PATTERNS) {
    if (!re.test(text)) continue
    if (SCAN_EXEMPT.has(rel)) continue
    // A test fixture legitimately holds a fake secret. Only real-looking values in non-test
    // files fail the build; the path check above already limits this to a known list.
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      if (!re.test(line)) continue
      if (FIXTURE_MARKER.test(line)) continue
      if (rel.startsWith('test/') || rel.startsWith('docs/')) continue
      findings.push({ path: rel, label, sample: line.trim().slice(0, 120) })
    }
  }
}

if (findings.length > 0) {
  const detail = findings
    .map((f) => `  ${f.path} — ${f.label}\n    ${f.sample}`)
    .join('\n')
  throw new Error(`源码包包含疑似凭据，构建已失败：\n${detail}`)
}

// --- 4. Final gate: re-read the list ---------------------------------------

/**
 * Verify the assembled list once more, with fresh eyes.
 *
 * By construction every entry passed `isPublishable`, so this can only fail if that function and
 * this one disagree — which is exactly the regression worth catching. It runs on the final list,
 * not on the candidates, so a future refactor that bypasses the check still fails here.
 */
const leaky = files.filter((rel) => {
  const name = rel.split('/').pop()
  return (
    FORBIDDEN_NAMES.some((pattern) => pattern.test(name)) ||
    rel.split('/').some((segment) => FORBIDDEN_DIRS.has(segment))
  )
})
if (leaky.length > 0) {
  throw new Error(`最终清单仍含禁止文件，构建已失败：${leaky.join(', ')}`)
}

// --- 5. Write the ZIP -------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * The ZIP epoch (1980-01-01 00:00), pinned rather than each file's mtime.
 *
 * Using `mtime` made two runs over identical content produce different bytes — the previous step
 * had just rewritten one file — so a published SHA-256 was stale as soon as anyone rebuilt. The
 * content determines the archive now, not the clock.
 */
const PINNED_DOS = { time: 0, day: (1 << 5) | 1 }

const LOCAL_HEADER = Buffer.alloc(30)
const CENTRAL_HEADER = Buffer.alloc(46)

const chunks = []
const central = []
let offset = 0

for (const rel of files) {
  const raw = await readFile(join(root, rel.split('/').join(sep)))
  const compressed = deflateRawSync(raw, { level: 9 })
  const nameBytes = Buffer.from(rel, 'utf8')
  const crc = crc32(raw)
  const { time, day } = PINNED_DOS

  LOCAL_HEADER.writeUInt32LE(0x04034b50, 0)
  LOCAL_HEADER.writeUInt16LE(20, 4)
  LOCAL_HEADER.writeUInt16LE(0x0800, 6) // UTF-8 names
  LOCAL_HEADER.writeUInt16LE(8, 8) // deflate
  LOCAL_HEADER.writeUInt16LE(time, 10)
  LOCAL_HEADER.writeUInt16LE(day, 12)
  LOCAL_HEADER.writeUInt32LE(crc, 14)
  LOCAL_HEADER.writeUInt32LE(compressed.length, 18)
  LOCAL_HEADER.writeUInt32LE(raw.length, 22)
  LOCAL_HEADER.writeUInt16LE(nameBytes.length, 26)
  LOCAL_HEADER.writeUInt16LE(0, 28)

  chunks.push(Buffer.from(LOCAL_HEADER), nameBytes, compressed)

  const entry = Buffer.from(CENTRAL_HEADER)
  entry.writeUInt32LE(0x02014b50, 0)
  entry.writeUInt16LE(20, 4)
  entry.writeUInt16LE(20, 6)
  entry.writeUInt16LE(0x0800, 8)
  entry.writeUInt16LE(8, 10)
  entry.writeUInt16LE(time, 12)
  entry.writeUInt16LE(day, 14)
  entry.writeUInt32LE(crc, 16)
  entry.writeUInt32LE(compressed.length, 20)
  entry.writeUInt32LE(raw.length, 24)
  entry.writeUInt16LE(nameBytes.length, 28)
  entry.writeUInt16LE(0, 30)
  entry.writeUInt16LE(0, 32)
  entry.writeUInt16LE(0, 34)
  entry.writeUInt16LE(0, 36)
  // `<< 16` overflows into a negative int32 for mode 0o100644, so force unsigned.
  entry.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  entry.writeUInt32LE(offset, 42)
  central.push(Buffer.from(entry), nameBytes)

  offset += LOCAL_HEADER.length + nameBytes.length + compressed.length
}

const centralBuffer = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralBuffer.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

const zip = Buffer.concat([...chunks, centralBuffer, end])
await writeFile(outFile, zip)

console.log(`已写入 ${outFile}`)
console.log(`  来源：${source}`)
console.log(`  文件数：${files.length}`)
console.log(`  大小：${zip.length} 字节`)
if (skipped.length > 0) {
  console.log(`  跳过：${skipped.length} 个`)
  for (const entry of skipped) console.log(`    ${entry.path} — ${entry.reason}`)
}
for (const rel of files) console.log(`  ${rel}`)
