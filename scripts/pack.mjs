/**
 * Build, verify and package the plugin into a distributable `.tgz`.
 *
 * Runs the real checks first and refuses to produce an archive when any fails,
 * then verifies the produced archive by reading it back. Everything uses Node
 * built-ins plus the locally installed TypeScript: the DSH runtime ships Node
 * and pnpm but no npm, so a packaging step that shells out to `npm pack` cannot
 * run where this plugin is actually built.
 *
 *   node scripts/pack.mjs
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { createTgz, listTar } from './tar.mjs'

const root = join(import.meta.dirname, '..')

/**
 * What goes into the package.
 *
 * Compiled output plus the files the Loader and a reader need. Deliberately
 * excluded: `src/`, `test/`, `scripts/`, `node_modules`, probe output, and every
 * credential.
 */
const INCLUDE = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  '.env.example',
  // The security report travels with the package because README and CHANGELOG
  // both link to it, and a link that only resolves inside the repository is a
  // broken link for whoever installed the tarball.
  //
  // Listed by exact path rather than by adding `docs` to INCLUDE_DIRS: that
  // directory also holds historical acceptance screenshots, which added 1.2 MiB
  // to the archive for images no installed user needs.
  'docs/v0.2.3-security-report.md',
  // The README's cover image (v0.2.8). Root-relative `docs/images/...` is correct on
  // GitHub, where the file sits beside README.md in the repository — but the tarball
  // ships a flat subset, so without this entry the image is a broken link for anyone
  // reading README.md out of `node_modules`. Listed by exact path for the same reason
  // as the report above: `docs/` also holds acceptance screenshots no user needs.
  'docs/images/ai-debate-cover.png',
  // The v0.2.8 acceptance report is linked from CHANGELOG.md.
  'docs/v0.2.8-acceptance.md',
  // Same for v0.2.9. Listed explicitly rather than shipping all of `docs/`: the
  // historical screenshots there are megabytes of material no installed user opens.
  'docs/v0.2.9-acceptance.md',
  // And v0.2.10 (the cover replacement).
  'docs/v0.2.10-acceptance.md',
  // And v0.2.11 (Weibo read path + bystanders).
  'docs/v0.2.11-acceptance.md',
]
const INCLUDE_DIRS = ['lib', 'client']

/** Entries that must exist after building. */
const REQUIRED = [
  'package.json',
  'lib/index.js',
  'lib/index.d.ts',
  'client/client.cjs',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
]

/** Path prefixes that must never appear in the archive. */
const FORBIDDEN_PREFIXES = ['src/', 'test/', 'scripts/', 'node_modules/', '.git/', 'probe-out']

/** Shapes of secrets that must never be published. */
const SECRET_PATTERNS = [
  { re: /BAIDUID\s*=\s*[A-Za-z0-9]{10,}/, label: 'BAIDUID' },
  { re: /BDUSS\s*=\s*[A-Za-z0-9]{10,}/, label: 'BDUSS' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'API key' },
]

/** Run one command and exit on failure. */
function run(label, args) {
  process.stdout.write(`\n\x1b[36m▶ ${label}\x1b[0m\n`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    process.stderr.write(`\x1b[31m✖ ${label} 失败\x1b[0m\n`)
    process.exit(result.status ?? 1)
  }
}

/** Walk a directory into archive-relative file paths. */
function walk(dir, prefix) {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = `${prefix}/${name}`
    const stats = statSync(abs)
    if (stats.isDirectory()) out.push(...walk(abs, rel))
    else if (stats.isFile()) out.push(rel)
  }
  return out
}

/** Build the archive file list from the include lists. */
function collect() {
  const files = []
  for (const name of INCLUDE) {
    if (existsSync(join(root, name))) files.push(name)
  }
  for (const dir of INCLUDE_DIRS) {
    const abs = join(root, dir)
    if (existsSync(abs)) files.push(...walk(abs, dir))
  }
  return files.map((path) => path.split(sep).join('/')).sort()
}

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  process.stderr.write('\x1b[31m✖ 找不到本地 TypeScript，请先运行 pnpm install\x1b[0m\n')
  process.exit(1)
}

run('编译 TypeScript', [tsc, '-p', 'tsconfig.json'])

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarballName = `${manifest.name}-${manifest.version}.tgz`

process.stdout.write(`\n\x1b[36m▶ 收集文件\x1b[0m\n`)
const paths = collect()

const problems = []
for (const required of REQUIRED) {
  if (!paths.includes(required)) problems.push(`缺少必需文件：${required}`)
}
for (const path of paths) {
  const bad = FORBIDDEN_PREFIXES.find((prefix) => path.startsWith(prefix))
  if (bad) problems.push(`包含不应发布的路径：${path}`)
}
if (!paths.some((path) => path.endsWith('.js'))) problems.push('没有编译后的 JS')

for (const path of paths) {
  if (!/\.(js|ts|json|yml|yaml|md|example)$/.test(path)) continue
  const text = readFileSync(join(root, path), 'utf8')
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) problems.push(`疑似 ${pattern.label} 出现在 ${path}`)
  }
  if (/link:[A-Za-z]:\\/.test(text)) problems.push(`出现了本机绝对路径：${path}`)
}

if (problems.length > 0) {
  process.stderr.write('\x1b[31m✖ 打包前检查未通过：\x1b[0m\n')
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.exit(1)
}
process.stdout.write(`\x1b[32m✔ ${paths.length} 个文件通过检查\x1b[0m\n`)

process.stdout.write(`\n\x1b[36m▶ 生成 ${tarballName}\x1b[0m\n`)
// npm tarballs put every file under a single top-level `package/` directory;
// `npm install ./x.tgz` and the DSH plugin manager both expect that layout.
const archivePath = (path) => `package/${path}`
const tgz = createTgz(
  paths.map((path) => ({ path: archivePath(path), data: readFileSync(join(root, path)) })),
)
writeFileSync(join(root, tarballName), tgz)
const digest = createHash('sha256').update(tgz).digest('hex')
process.stdout.write(`\x1b[32m✔ 已写入 ${tarballName}\x1b[0m\n`)

process.stdout.write(`\n\x1b[36m▶ 回读校验\x1b[0m\n`)
const listed = listTar(gunzipSync(readFileSync(join(root, tarballName))))
const listedPaths = listed.map((entry) => entry.path)
const expectedPaths = paths.map(archivePath)

const missingInArchive = expectedPaths.filter((path) => !listedPaths.includes(path))
if (missingInArchive.length > 0) {
  process.stderr.write(`\x1b[31m✖ 归档里缺少：${missingInArchive.join(', ')}\x1b[0m\n`)
  process.exit(1)
}
if (listedPaths.length !== expectedPaths.length) {
  process.stderr.write(
    `\x1b[31m✖ 归档条目数不符：期望 ${expectedPaths.length}，实际 ${listedPaths.length}\x1b[0m\n`,
  )
  process.exit(1)
}
for (const entry of listed) {
  const relativePath = entry.path.replace(/^package\//, '')
  const actual = statSync(join(root, ...relativePath.split('/'))).size
  if (entry.size !== actual) {
    process.stderr.write(`\x1b[31m✖ ${entry.path} 的大小不符：${entry.size} ≠ ${actual}\x1b[0m\n`)
    process.exit(1)
  }
}
process.stdout.write(`\x1b[32m✔ 归档包含全部 ${listedPaths.length} 个条目，大小一致\x1b[0m\n`)

// ---- entry self-check -------------------------------------------------------
const entryUrl = `file://${join(root, 'lib', 'index.js').replace(/\\/g, '/')}`
const probe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import(${JSON.stringify(entryUrl)}).then((m) => {
       const missing = ['apply', 'name', 'inject', 'Config', 'DEFAULT_CONFIG'].filter((key) => m[key] === undefined);
       if (missing.length) { console.error('缺少导出：' + missing.join(',')); process.exit(1); }
       if (typeof m.apply !== 'function') { console.error('apply 不是函数'); process.exit(1); }
       console.log('apply / name / inject / Config / DEFAULT_CONFIG 导出正常');
     }).catch((error) => { console.error(error.message); process.exit(1); })`,
  ],
  { encoding: 'utf8', shell: false },
)
if (probe.status !== 0) {
  process.stderr.write(`\x1b[31m✖ 入口自检失败：${probe.stderr || probe.stdout}\x1b[0m\n`)
  process.exit(1)
}
process.stdout.write(`\x1b[32m✔ ${(probe.stdout ?? '').trim()}\x1b[0m\n`)

process.stdout.write(
  `\n\x1b[32m打包完成\x1b[0m\n` +
    `  文件：${tarballName}\n` +
    `  大小：${(tgz.length / 1024).toFixed(1)} KiB\n` +
    `  sha256：${digest}\n\n` +
    `  本地安装：dsh plugin --profile <profile-name> add ./${tarballName}\n` +
    `  GitHub 安装：dsh plugin --profile <profile-name> add github:<owner>/dsh-ai-debate#v${manifest.version}\n\n`,
)
