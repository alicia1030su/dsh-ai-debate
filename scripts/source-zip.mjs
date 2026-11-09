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
 * ## What actually decides the bytes (v0.2.39 §5)
 *
 * The answer is **the commit**, not the working tree.
 *
 * Until v0.2.38 this script listed files with Git and then read their contents with `readFile`.
 * Half of it read the commit, the other half read the disk, and the two can disagree: v0.2.37's
 * 2369-byte difference came from exactly that — twenty text files had been rewritten as CRLF in
 * the working tree while the repository stored LF. v0.2.38 diagnosed it and added a drift check,
 * but a check only helps if someone remembers to run it. The cause stayed.
 *
 * Now every byte comes from `git cat-file --batch` at a named commit.
 *
 * ## Publish mode and local mode are different programs (v0.2.39 复审 §1)
 *
 * Reading the commit is only half the guarantee. The other half is **refusing to run when the
 * commit cannot be named**:
 *
 * - `--rev` that does not resolve (a tag not created yet, a typo, a shallow clone) used to be
 *   caught by the same `catch` that means "there is no Git here", so the packer silently fell
 *   back to the working tree and produced a plausible archive of the wrong thing. A release
 *   asset that does not correspond to any commit is worse than no release asset.
 * - The same applied to an empty `--rev`: `argValue` returned `''`, which defaulted to `HEAD`.
 *
 * So the default is **publish mode**: Git is required, the revision must resolve, and every
 * failure exits non-zero without writing a file. The working-tree walk still exists for the
 * security tests and for looking at a copied-out directory, but it must be asked for by name —
 * `--allow-working-tree` — and it refuses to combine with `--rev`, because "package this commit"
 * and "package whatever is on disk" are not the same request.
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

import { isRegisteredFakeLiteral } from './lib/fixture-allowlist.mjs'
import { readBlobs } from './lib/git-objects.mjs'

const root = process.cwd()

/**
 * Stop before writing anything.
 *
 * Exit code 2 means "refused to start" (bad arguments, no Git, unresolvable revision), which is
 * distinct from a content-scan failure (a thrown error). Both are non-zero and both leave no
 * archive behind; the distinction only helps whoever reads the CI log.
 */
function refuse(reason) {
  console.error(`源码包未生成：${reason}`)
  process.exit(2)
}

/**
 * Read `--name value`.
 *
 * A flag with no value is an error rather than a silent default. `--rev` in particular used to
 * become `''`, which then became `HEAD` — a request that named nothing produced an archive of
 * something.
 */
function argValue(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    refuse(`--${name} 需要一个值，实际后面是${value === undefined ? '结尾' : `「${value}」`}。`)
  }
  return value
}

const revGiven = process.argv.includes('--rev')
const allowWorkingTree = process.argv.includes('--allow-working-tree')

/**
 * The commit whose contents get published.
 *
 * Defaults to `HEAD`, which is what a release checkout is. `--rev` exists so the same script can
 * answer "what would the archive for tag v0.2.39 contain" without checking that tag out first —
 * the acceptance for this version needs to compare two working trees of the same commit.
 */
const requestedRev = revGiven ? argValue('rev') : 'HEAD'

/** True when this directory is inside a Git work tree. A missing `git` binary answers false. */
function insideGitWorkTree() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

/** The commit sha for `rev`, or `null` when it does not name a commit in this repository. */
function resolveCommit(rev) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const hasGit = insideGitWorkTree()

// "Package the working tree" and "package this commit" are different requests. Accepting both
// flags would silently honour one of them.
if (allowWorkingTree && revGiven) {
  refuse('--allow-working-tree 与 --rev 不能同时使用：一个要打磁盘，一个要打提交。')
}
if (allowWorkingTree && hasGit) {
  refuse('这个目录是 Git 工作树，--allow-working-tree 不适用：提交里的字节才是可复现的那一份。')
}

/**
 * `null` means "working tree", and is only reachable in the explicit local mode.
 *
 * Every other path either resolves a commit or has already exited. There is deliberately no
 * third state: "Git exists but the revision is bad" is not a reason to package something else.
 */
let commit = null
if (hasGit) {
  commit = resolveCommit(requestedRev)
  if (commit === null) {
    refuse(
      `--rev ${requestedRev} 在这个仓库里解析不到提交，不会回退到工作树。` +
        `先确认标签/分支存在：git rev-parse --verify ${requestedRev}^{commit}`,
    )
  }
} else if (revGiven) {
  refuse(`--rev ${requestedRev} 需要一个 Git 仓库，但这里不是。不会拿工作树顶替一个指定的提交。`)
} else if (!allowWorkingTree) {
  refuse(
    '这里不是 Git 工作树。正式发布必须从提交打包；' +
      '如果只是本地预览，显式加 --allow-working-tree（产物不能字节级复现，不得用于发布）。',
  )
}

/**
 * Tracked entries at the commit: mode, type, object id and path.
 *
 * `ls-tree` rather than `ls-files`: the index can hold staged-but-uncommitted changes, and
 * "what is committed" is the only thing a release archive may contain.
 */
function treeEntries(sha) {
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', sha], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const found = []
  for (const record of listing.toString('utf8').split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, type, object] = record.slice(0, tab).split(' ')
    found.push({ mode, type, object, path: record.slice(tab + 1) })
  }
  return found
}

const entries = commit === null ? null : treeEntries(commit)

const version =
  entries === null
    ? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
    : JSON.parse(
        readBlobs(root, commit, ['package.json']).get('package.json').data.toString('utf8'),
      ).version

// Where the archive lands. Default is the directory *above* the project, which is where a
// developer expects to find it and where CI's own housekeeping has always looked.
//
// CI has one hard requirement the default cannot satisfy: `actions/upload-artifact@v4` rejects
// any path containing `..` — "Relative pathing '.' and '..' is not allowed". The release job
// therefore passes --out ., and the archive is written into the workspace instead. Keeping one
// script with one behaviour would mean either breaking local workflow or leaving the release
// job permanently red, so the output directory is a parameter rather than a constant.
const outArg = argValue('out')
const outDir = outArg === undefined ? join(root, '..') : resolve(root, outArg)
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
  // ## 测试类型检查的基线（v0.2.17）
  //
  // `scripts/test-typecheck.mjs` 读这个文件决定「允许多少条历史类型错误」。它不在包里的话，
  // 从源码包解压出来跑 CI 会直接报「缺少基线文件」—— 又是一次「本机能过、别人跑不了」。
  'test-typecheck-baseline.json',
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

/**
 * Tracked test fixtures that live under a normally-forbidden directory (v0.2.39 §5.2).
 *
 * ## The conflict this resolves
 *
 * `.gitignore` has carried an exception for `test/fixtures/fake-weibo-pkg/node_modules/**` since
 * v0.2.33, with a stated reason: the微博 desktop acceptance puts that pseudo-package on `PATH`
 * and lets the real `weibo-cli` entry resolution find it, so without it "换台机器复现桌面验收"
 * does not hold. It is committed on purpose.
 *
 * `FORBIDDEN_DIRS` excludes `node_modules` unconditionally, so those two files could never enter
 * the archive — and the archive is exactly what a downloader uses to reproduce that acceptance.
 * Two rules disagreed, and the disagreement was only visible from the outside.
 *
 * ## Why the fix is an exact-path list, not "allow test fixtures"
 *
 * Dropping `node_modules` from `FORBIDDEN_DIRS` would publish every real dependency directory a
 * developer happens to have installed — hundreds of megabytes of third-party code with its own
 * licenses, and a new path for a stray secret in some package's local cache. Widening to "anything
 * under test/fixtures/" is the same mistake one step smaller: fixtures are where people paste
 * sample responses, and sample responses are where people paste real cookies.
 *
 * So each entry is a **whole path**, and it must also be a blob the named commit actually
 * contains. A directory that a `pnpm install` creates can never satisfy that, which is the point.
 */
const TRACKED_FIXTURE_EXCEPTIONS = new Set([
  'test/fixtures/fake-weibo-pkg/node_modules/@weibo-ai/weibo-cli/package.json',
  'test/fixtures/fake-weibo-pkg/node_modules/@weibo-ai/weibo-cli/dist/index.js',
])

/** True when a relative path may be published. The single decision point. */
function isPublishable(rel) {
  const segments = rel.split('/')
  const name = segments[segments.length - 1]
  const top = segments[0]

  if (TRACKED_FIXTURE_EXCEPTIONS.has(rel)) {
    // The exception still has to pass every name check: it may be under node_modules, but a
    // `.env` or a key file sitting at that exact path must still be refused.
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) return false
    if (SKIP_FILES.has(name)) return false
    if (/\.(tgz|zip|tar|gz|7z|rar)$/i.test(name)) return false
    return true
  }

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

/**
 * The bytes to publish, keyed by path.
 *
 * A `Map` rather than reading inside each later loop, because there are two fundamentally
 * different sources and every consumer must not care which one was used:
 *
 * - `git`: bytes come from the object database at `commit`. This is the reproducible path.
 * - `working-tree`: bytes come from disk. Only reachable when there is no Git at all, and the
 *   output says so plainly, because an archive built this way cannot be reproduced from the
 *   commit it claims to describe.
 */
let contents
let source
const files = []

if (entries === null) {
  source = 'working-tree（没有 Git 仓库，不能字节级复现）'
  contents = new Map()
  const walked = (await walk(root)).map((rel) => rel.split(sep).join(posix.sep))
  for (const rel of walked.sort()) {
    if (!isPublishable(rel)) continue
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
    contents.set(rel, await readFile(join(root, rel.split('/').join(sep))))
  }
} else {
  source = `git ${requestedRev}（${commit.slice(0, 12)}）`
  contents = new Map()
  const candidates = []
  for (const entry of entries) {
    if (entry.type !== 'blob') {
      // A submodule is a commit pointer, not content: publishing it would silently drop a
      // directory and leave a checkout that cannot be built.
      skipped.push({ path: entry.path, reason: `提交里的 ${entry.type}（不是文件内容）` })
      continue
    }
    // 120000 is a symlink in Git's mode encoding. Git stores the link target as the blob, so
    // publishing it would create a link in the archive pointing wherever it pointed here.
    if (entry.mode === '120000') {
      skipped.push({ path: entry.path, reason: '符号链接（不跟随）' })
      continue
    }
    if (!isPublishable(entry.path)) continue
    candidates.push(entry.path)
  }
  candidates.sort()
  const blobs = readBlobs(root, commit, candidates)
  for (const rel of candidates) {
    const blob = blobs.get(rel)
    if (blob === undefined) throw new Error(`提交 ${commit} 里读不到 ${rel}`)
    files.push(rel)
    contents.set(rel, blob.data)
  }
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
 * 精确的假数据例外（v0.2.39 复审 §2）。
 *
 * 原来是三件东西叠在一起：一个按文件名的豁免表、一个「行里出现 fixture 就跳过」的正则、
 * 以及 `test/`、`docs/` 的整目录跳过。三者的共同问题不是「太宽」而是**不可验证**：
 *
 * - 整目录跳过意味着把一把真 AWS key 粘进任何测试文件都不会让构建失败；
 * - 行级关键字意味着 `// example: <真钥匙>` 也能过 —— 一句注释就买到了豁免；
 * - 文件级豁免意味着那三个文件里可以藏任何东西，而它们是源码，不是一次性夹具。
 *
 * 现在只有一个判据：`path` 与**逐字**登记的假值相等。登记表在
 * `scripts/lib/fixture-allowlist.mjs`，由测试逐条核对「仍然出现在那个文件里」。
 * 换一把钥匙、换一个文件、同一文件里多一把，都不匹配。
 */
const findings = []
for (const rel of files) {
  // Scan **the bytes that will be published**, not a fresh read of the disk. If those two could
  // differ, the scan would be certifying something other than the artifact.
  const raw = contents.get(rel)
  if (raw === undefined) throw new Error(`内部不一致：${rel} 有名字没有内容`)
  // Binary files cannot carry a readable secret and scanning them is noise.
  if (raw.includes(0)) continue
  const text = raw.toString('utf8')
  const lines = text.split(/\r?\n/)

  for (const { re, label } of SECRET_PATTERNS) {
    if (!re.test(text)) continue
    // One pattern can hit more than once on a line. Each hit is judged on its own, so a
    // registered fake at the start of a line cannot carry an unregistered key behind it.
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    for (const line of lines) {
      for (const match of line.matchAll(global)) {
        if (isRegisteredFakeLiteral(rel, match[0], line)) continue
        findings.push({ path: rel, label, sample: line.trim().slice(0, 120) })
      }
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
 *
 * The exception list is re-checked here too, deliberately re-derived rather than trusting
 * `isPublishable`: the point of this gate is to be a second opinion, so it must not call the
 * first opinion to form its own.
 */
const leaky = files.filter((rel) => {
  const name = rel.split('/').pop()
  if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) return true
  if (TRACKED_FIXTURE_EXCEPTIONS.has(rel)) return !contents.has(rel)
  return rel.split('/').some((segment) => FORBIDDEN_DIRS.has(segment))
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
  const raw = contents.get(rel)
  if (raw === undefined) throw new Error(`内部不一致：${rel} 有名字没有内容`)
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
if (commit === null) {
  console.log('  模式：本地（--allow-working-tree）—— 字节来自磁盘，**不能**从某个提交复现。')
  console.log('        这只是给人本地看一眼用的，不得作为发布产物。')
}
if (skipped.length > 0) {
  console.log(`  跳过：${skipped.length} 个`)
  for (const entry of skipped) console.log(`    ${entry.path} — ${entry.reason}`)
}
for (const rel of files) console.log(`  ${rel}`)
