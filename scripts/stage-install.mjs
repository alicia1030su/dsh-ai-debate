/**
 * Prepare a directory that looks exactly like what `dsh plugin add` leaves on
 * disk after pnpm resolved the tarball: the package files plus its declared
 * `dependencies` in a local `node_modules`.
 *
 * The DSH plugin manager links a local directory as-is (`link:`), which means it
 * does not run a dependency install of its own. A real install from GitHub or
 * from a `.tgz` does. This script reproduces that end state so `install_bundle`
 * can be pointed at a directory that is genuinely installable, and so the result
 * can be inspected by hand.
 *
 *   node scripts/stage-install.mjs <output-dir>
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { copyWithDependencies } from './deps.mjs'
import { listTar } from './tar.mjs'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarball = join(root, `dsh-ai-debate-${manifest.version}.tgz`)
const output = process.argv[2]

if (!output) {
  process.stderr.write('用法：node scripts/stage-install.mjs <输出目录>\n')
  process.exit(1)
}
if (!existsSync(tarball)) {
  process.stderr.write(`找不到 ${tarball}，请先运行 node scripts/pack.mjs\n`)
  process.exit(1)
}

mkdirSync(output, { recursive: true })

/** Unpack the tarball under `package/` inside the output directory. */
function unpack() {
  const tar = gunzipSync(readFileSync(tarball))
  const entries = listTar(tar)
  let offset = 0
  for (const entry of entries) {
    const block = tar.subarray(offset, offset + 512)
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').replace(/[\u0000 ]+$/s, '').trim(), 8) || 0
    const body = offset + 512
    const target = join(output, ...entry.path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, tar.subarray(body, body + size))
    offset = body + Math.ceil(size / 512) * 512
  }
  return entries
}

const entries = unpack()
const pkgDir = join(output, 'package')
process.stdout.write(`解出 ${entries.length} 个文件到 ${pkgDir}\n`)

/** Every bare import in the published code. */
function bareImportsIn(dir) {
  const found = new Set()
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      for (const spec of bareImportsIn(abs)) found.add(spec)
      continue
    }
    if (!name.endsWith('.js')) continue
    const text = readFileSync(abs, 'utf8')
    for (const match of text.matchAll(/from\s+'([^.'][^']*)'/g)) found.add(match[1])
  }
  return found
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const declared = new Set(Object.keys(pkg.dependencies ?? {}))
const peers = new Set(Object.keys(pkg.peerDependencies ?? {}))
const needed = [...bareImportsIn(join(pkgDir, 'lib'))]
  .filter((spec) => !spec.startsWith('node:'))
  .filter((spec) => !peers.has(spec))

const storeDir = join(root, 'node_modules', '.pnpm')
let copied = 0
for (const spec of needed) {
  if (!declared.has(spec)) {
    process.stderr.write(`✖ ${spec} 被代码 import 但没声明在 dependencies\n`)
    process.exit(1)
  }
  const from = join(root, 'node_modules', ...spec.split('/'))
  if (!existsSync(from)) {
    process.stderr.write(`✖ 本地找不到 ${spec}，请先在仓库里 pnpm install\n`)
    process.exit(1)
  }
  const result = copyWithDependencies({
    name: spec,
    from,
    storeDir,
    targetDir: join(pkgDir, 'node_modules'),
  })
  copied += result.length
}

process.stdout.write(`安装依赖：${needed.join(', ')}（连同传递依赖共 ${copied} 个包）\n`)

// A final self-mount from the staged directory, so a broken stage is caught here
// rather than in the Host's error output.
const probe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const m = await import('file://' + ${JSON.stringify(join(pkgDir, 'lib', 'index.js').replace(/\\/g, '/'))});
     const tools = [];
     m.apply({ tools: { register(d) { tools.push(d.name); return () => {}; } },
               systemPrompt: { section() { return () => {}; } },
               effect(fn) { return fn() ?? (() => {}); } }, {});
     console.log('挂载成功，注册 ' + tools.length + ' 个工具');`,
  ],
  { encoding: 'utf8', cwd: pkgDir, shell: false },
)
if (probe.status !== 0) {
  process.stderr.write(`✖ 暂存目录挂载失败：${probe.stderr}\n`)
  process.exit(1)
}
process.stdout.write(`${(probe.stdout ?? '').trim()}\n`)
process.stdout.write(`\n已就绪：${pkgDir}\n`)
