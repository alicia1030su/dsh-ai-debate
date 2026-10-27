/**
 * Verify the packed plugin can be **installed and loaded from a bare directory**
 * with nothing but its declared dependencies.
 *
 * This is the check that would have caught the `link:` install failure: the DSH
 * plugin manager installs a local package directory as a symlink, so the plugin
 * resolves imports from its *own* location, not from the profile. A package that
 * expects the profile to supply `@deepseek-ai/schemastery` therefore works in
 * development (where its own `node_modules` exists) and fails after install from
 * a directory that lacks one.
 *
 * So this script:
 *   1. unpacks the .tgz into a temp dir with no `node_modules` at all;
 *   2. installs the declared `dependencies` there exactly as npm/pnpm would;
 *   3. imports the entry and mounts it with a mock Host context.
 *
 *   node scripts/verify-install.mjs [path/to.tgz]
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { copyWithDependencies } from './deps.mjs'
import { listTar } from './tar.mjs'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarball = process.argv[2] ?? join(root, `dsh-ai-debate-${manifest.version}.tgz`)

if (!existsSync(tarball)) {
  process.stderr.write(`\x1b[31m✖ 找不到安装包：${tarball}\x1b[0m\n`)
  process.exit(1)
}

const workdir = mkdtempSync(join(tmpdir(), 'debate-bare-install-'))
let failures = 0
const isWindows = process.platform === 'win32'

/** Report one check. */
function check(label, ok, detail) {
  if (ok) {
    process.stdout.write(`  \x1b[32m✔\x1b[0m ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  \x1b[31m✖\x1b[0m ${label}${detail ? ` —— ${detail}` : ''}\n`)
}

/** Unpack the archive into `workdir`. */
function unpack() {
  const tar = gunzipSync(readFileSync(tarball))
  const entries = listTar(tar)
  let offset = 0
  for (const entry of entries) {
    const block = tar.subarray(offset, offset + 512)
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').replace(/[\u0000 ]+$/s, '').trim(), 8) || 0
    const body = offset + 512
    const target = join(workdir, ...entry.path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, tar.subarray(body, body + size))
    offset = body + Math.ceil(size / 512) * 512
  }
  return entries
}

/** List every bare import (package specifier) in a JS tree. */
function bareImportsIn(dir) {
  const found = new Set()
  if (!existsSync(dir)) return found
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      for (const spec of bareImportsIn(abs)) found.add(spec)
      continue
    }
    if (!name.endsWith('.js')) continue
    const text = readFileSync(abs, 'utf8')
    for (const match of text.matchAll(/from\s+'([^.'][^']*)'/g)) found.add(match[1])
    for (const match of text.matchAll(/require\('([^.'][^']*)'\)/g)) found.add(match[1])
  }
  return found
}

try {
  process.stdout.write(`\n\x1b[36m▶ 解包到无 node_modules 的空目录\x1b[0m\n  ${workdir}\n`)
  const entries = unpack()
  const pkgDir = join(workdir, 'package')
  process.stdout.write(`  解出 ${entries.length} 个文件\n`)

  check('解包后没有自带 node_modules', !existsSync(join(pkgDir, 'node_modules')))

  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const declaredDeps = Object.keys(pkg.dependencies ?? {})
  const peerDeps = Object.keys(pkg.peerDependencies ?? {})

  process.stdout.write(`\n\x1b[36m▶ 依赖契约\x1b[0m\n`)
  const external = [...bareImportsIn(join(pkgDir, 'lib'))].filter((spec) => !spec.startsWith('node:'))
  const suppliedByHost = new Set(peerDeps)
  const mustInstall = external.filter((spec) => !suppliedByHost.has(spec))

  for (const spec of mustInstall) {
    check(
      `${spec} 声明在 dependencies 里（不能靠宿主提供）`,
      declaredDeps.includes(spec),
      declaredDeps.includes(spec) ? undefined : '只声明在 peerDependencies 或完全没声明',
    )
  }

  // Install exactly what the manifest promises, the way a package manager would.
  process.stdout.write(`\n\x1b[36m▶ 按声明安装依赖\x1b[0m\n`)
  const storeDir = join(root, 'node_modules', '.pnpm')
  const targetModules = join(pkgDir, 'node_modules')
  const copied = []
  for (const spec of mustInstall) {
    const from = join(root, 'node_modules', ...spec.split('/'))
    if (!existsSync(from)) {
      check(`本地可解析 ${spec}`, false, '开发依赖里没有，无法做安装自检')
      continue
    }
    try {
      copied.push(...copyWithDependencies({ name: spec, from, storeDir, targetDir: targetModules }))
    } catch (error) {
      check(`安装 ${spec}`, false, error.message)
    }
  }
  process.stdout.write(`    装入：${[...new Set(copied)].join(', ') || '（无需额外依赖）'}\n`)

  // Now import from the unpacked location, with cwd inside it, so resolution
  // starts from the package exactly as it would after a real install.
  process.stdout.write(`\n\x1b[36m▶ 从安装位置加载\x1b[0m\n`)
  const entryUrl = `file://${join(pkgDir, 'lib', 'index.js').replace(/\\/g, '/')}`
  const probeScript = `
    const mod = await import(${JSON.stringify(entryUrl)});
    const tools = [];
    const sections = [];
    const ctx = {
      tools: { register(def) { tools.push(def.name); return () => {}; } },
      systemPrompt: { section(opts) { sections.push(opts.name); return () => {}; } },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    };
    const dispose = mod.apply(ctx, {});
    const expected = ['debate_bind_owner','debate_set_personality','debate_analyze_thread','debate_analyze_reply','debate_generate_reply','debate_publish_reply','debate_get_session','debate_stop_session','debate_health_check'];
    if (tools.length !== expected.length) throw new Error('注册了 ' + tools.length + ' 个工具，应该是 ' + expected.length);
    for (const name of expected) if (!tools.includes(name)) throw new Error('缺少工具 ' + name);
    if (sections.length !== 1) throw new Error('系统提示区块数是 ' + sections.length);
    if (typeof mod.Config !== 'function') throw new Error('Config 不是 schema 对象');
    if (typeof mod.name !== 'string' || mod.name !== 'dsh-ai-debate') throw new Error('name 导出不对');
    if (!Array.isArray(mod.inject)) throw new Error('inject 导出不对');
    dispose();
    console.log(JSON.stringify({ tools, sections, configKeys: Object.keys(mod.Config({}) ?? {}) }));
  `
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    encoding: 'utf8',
    cwd: pkgDir,
    shell: false,
  })
  if (probe.status !== 0) {
    check('从安装位置加载并挂载', false, (probe.stderr || probe.stdout || '').split('\n').slice(0, 4).join(' '))
  } else {
    check('从安装位置加载并挂载（9 个工具 + 1 个提示区块）', true)
    const parsed = JSON.parse((probe.stdout ?? '').trim().split('\n').pop())
    process.stdout.write(`    工具：${parsed.tools.join('、')}\n`)
    process.stdout.write(`    配置项：${parsed.configKeys.length} 个\n`)
  }

  process.stdout.write(
    failures === 0
      ? `\n\x1b[32m裸目录安装验证通过\x1b[0m\n\n  安装包：${tarball}\n\n`
      : `\n\x1b[31m${failures} 项检查未通过\x1b[0m\n\n`,
  )
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

void isWindows
process.exit(failures === 0 ? 0 : 1)
