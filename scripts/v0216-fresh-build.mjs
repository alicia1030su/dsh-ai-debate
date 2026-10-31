/**
 * v0.2.16 §一：从交付的源码 ZIP 在全新空目录复现整个构建。
 *
 * ## 为什么这一步不能省
 *
 * 开发机上 `lib/` 和 `node_modules/` 都在，所以「`tsc` 能过」「测试能过」什么都证明不了 ——
 * 那只能证明这台机器当前是绿的。v0.2.15 就是在这种状态下发的包，而那个包缺锁文件和编译产物，
 * 下载的人第一条命令就会失败。
 *
 * 这个脚本只做一件事：把 ZIP 解到一个**全新目录**，用**全新 store**（不碰本机 pnpm 缓存），
 * 从零装依赖、编译、类型检查、跑全部测试、打 TGZ，然后把产物与开发机上的对比。
 *
 * 全新 store 是关键。用默认 store 的话，包体可能从本机缓存里拿，网络不通也照样"成功"，
 * 那就又回到了自我认证。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const NODE = process.execPath
const ROOT = process.cwd()

/**
 * Locate pnpm without baking a machine-specific path into a public repository.
 *
 * Order: an explicit `PNPM_BIN`, then whatever `pnpm` is first on PATH. There is no third
 * fallback on purpose — guessing a path would make this script "work on my machine" and fail
 * confusingly everywhere else, which is the opposite of what it is for.
 *
 * Returns how to *invoke* it, not just where it lives. On Windows `pnpm` may be a `.cjs` (a Node
 * script with no launcher), a `.cmd` shim, or an `.exe`. Treating those uniformly is what breaks:
 * passing a `.cjs` straight to `execFileSync` fails as `MODULE_NOT_FOUND`, and a `.cmd` needs a
 * shell because it is a batch file. So the caller gets `{command, prefix, shell}` already decided.
 */
function findPnpm() {
  const describe = (path) => {
    const lower = path.toLowerCase()
    if (lower.endsWith('.cjs') || lower.endsWith('.js')) {
      return { command: process.execPath, prefix: [path], shell: false }
    }
    // `.cmd`/`.bat` are batch files: only a shell can run them.
    return { command: path, prefix: [], shell: process.platform === 'win32' && !lower.endsWith('.exe') }
  }

  if (process.env.PNPM_BIN !== undefined && process.env.PNPM_BIN.length > 0) {
    if (!existsSync(process.env.PNPM_BIN)) {
      throw new Error(`PNPM_BIN 指向的文件不存在：${process.env.PNPM_BIN}`)
    }
    return describe(process.env.PNPM_BIN)
  }
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, `pnpm${extension}`)
      if (existsSync(candidate)) return describe(candidate)
    }
  }
  throw new Error(
    '找不到 pnpm。请安装 pnpm，或用 PNPM_BIN=/path/to/pnpm 指定。' +
      '（本脚本刻意不去猜开发机上的路径。）',
  )
}
const ZIP = join(ROOT, '..', 'dsh-ai-debate-source-0.2.16.zip')

const steps = []
function step(name, fn) {
  const started = Date.now()
  process.stdout.write(`\n=== ${name} ===\n`)
  try {
    const detail = fn()
    steps.push({ name, ok: true, ms: Date.now() - started, detail })
    process.stdout.write(`  ✔ ${detail ?? 'ok'}\n`)
    return detail
  } catch (error) {
    steps.push({ name, ok: false, ms: Date.now() - started, detail: error.message })
    process.stdout.write(`  ✖ ${error.message}\n`)
    throw error
  }
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  return result
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

if (!existsSync(ZIP)) {
  console.error(`源码包不存在：${ZIP}`)
  process.exit(1)
}

const workspace = join(
  tmpdir(),
  `dsh-v0216-fresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
)
mkdirSync(workspace, { recursive: true })
const storeDir = join(workspace, '.pnpm-store')
const appDir = join(workspace, 'dsh-ai-debate')

process.stdout.write(`工作目录: ${workspace}\n`)
process.stdout.write(`源码包:   ${ZIP} (${statSync(ZIP).size} 字节, ${sha256(ZIP).slice(0, 16)}…)\n`)

let failed = null
try {
  step('解压源码包', () => {
    const ps =
      `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${workspace}\\x' -Force; ` +
      `New-Item -ItemType Directory -Path '${appDir}' -Force | Out-Null; ` +
      `Get-ChildItem '${workspace}\\x' | Move-Item -Destination '${appDir}' -Force`
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
    const entries = readdirSync(appDir)
    return `${entries.length} 个顶层条目：${entries.slice(0, 8).join(', ')}…`
  })

  step('确认解压结果没有依赖本机状态', () => {
    const forbidden = ['node_modules', '.git', '.dsh']
    for (const name of forbidden) {
      if (existsSync(join(appDir, name))) throw new Error(`源码包里带了 ${name}`)
    }
    if (!existsSync(join(appDir, 'pnpm-lock.yaml'))) throw new Error('源码包缺 pnpm-lock.yaml')
    if (!existsSync(join(appDir, 'lib', 'index.js'))) throw new Error('源码包缺 lib/index.js')
    const srcCount = countFiles(join(appDir, 'src'), '.ts', (n) => !n.endsWith('.d.ts'))
    const libCount = countFiles(join(appDir, 'lib'))
    return `锁文件在，lib/ ${libCount} 个产物，src/ ${srcCount} 个 TS`
  })

  step('删除交付的 lib/，强制从零编译', () => {
    rmSync(join(appDir, 'lib'), { recursive: true, force: true })
    return 'lib/ 已清空'
  })

  step('全新 store 安装依赖（--frozen-lockfile，不碰本机缓存）', () => {
    const pnpm = findPnpm()
    // `--store-dir` inside the throwaway workspace is the point: a shared store could satisfy the
    // install from this machine's cache, so a package that is not really published would still
    // "work" — and the reproduction would prove nothing.
    run(pnpm.command, [...pnpm.prefix, 'install', '--frozen-lockfile', '--store-dir', storeDir], {
      cwd: appDir,
      shell: pnpm.shell,
    })
    const modules = existsSync(join(appDir, 'node_modules')) ? readdirSync(join(appDir, 'node_modules')).length : 0
    return `node_modules 顶层 ${modules} 项`
  })

  step('编译 TypeScript', () => {
    run(NODE, [join(appDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
      cwd: appDir,
    })
    const libCount = countFiles(join(appDir, 'lib'))
    if (libCount === 0) throw new Error('编译后 lib/ 为空')
    return `lib/ ${libCount} 个产物`
  })

  step('类型检查（含测试与脚本）', () => {
    run(NODE, [join(appDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.test.json'], {
      cwd: appDir,
    })
    return '无类型错误'
  })

  step('跑全部测试', () => {
    const output = run(NODE, ['--experimental-transform-types', '--test', 'test/**/*.test.ts'], {
      cwd: appDir,
    })
    const tests = /# tests (\d+)/.exec(output)?.[1] ?? /ℹ tests (\d+)/.exec(output)?.[1]
    const fail = /# fail (\d+)/.exec(output)?.[1] ?? /ℹ fail (\d+)/.exec(output)?.[1]
    if (fail !== undefined && Number(fail) > 0) throw new Error(`${fail} 项测试失败`)
    if (tests === undefined) throw new Error('读不到测试计数，不能判定通过')
    return `${tests} 项全部通过`
  })

  step('在源码包内打正式 TGZ', () => {
    run(NODE, ['scripts/pack.mjs'], { cwd: appDir })
    const packed = join(appDir, 'dsh-ai-debate-0.2.16.tgz')
    if (!existsSync(packed)) throw new Error(`没有生成 ${packed}`)
    return `${statSync(packed).size} 字节，sha256 ${sha256(packed).slice(0, 16)}…`
  })

  step('与开发机构建的产物对比', () => {
    const fresh = join(appDir, 'dsh-ai-debate-0.2.16.tgz')
    const dev = join(ROOT, 'dsh-ai-debate-0.2.16.tgz')
    const freshHash = sha256(fresh)
    if (!existsSync(dev)) {
      throw new Error(`开发机还没打 0.2.16 的包，无法对比（先跑 node scripts/pack.mjs）`)
    }
    const devHash = sha256(dev)
    if (freshHash !== devHash) {
      throw new Error(`两个 TGZ 不一致：全新 ${freshHash.slice(0, 16)}… vs 开发机 ${devHash.slice(0, 16)}…`)
    }
    return `字节完全一致：${freshHash.slice(0, 32)}…`
  })
} catch (error) {
  failed = error
}

function countFiles(dir, extension, filter) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += countFiles(full, extension, filter)
    else if (entry.isFile()) {
      if (extension === undefined) total += 1
      else if (entry.name.endsWith(extension) && (filter === undefined || filter(entry.name))) total += 1
    }
  }
  return total
}

const report = { workspace, zip: ZIP, zipSha256: sha256(ZIP), steps, ok: failed === null }
writeFileSync(join(ROOT, '..', 'v0216-fresh-build.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

process.stdout.write(`\n=== 汇总 ===\n`)
for (const entry of steps) {
  process.stdout.write(`  ${entry.ok ? '✔' : '✖'} ${entry.name} (${entry.ms}ms) — ${entry.detail}\n`)
}
process.stdout.write(`\n结论: ${failed === null ? '源码 ZIP 可在全新环境复现完整构建' : `失败于「${failed.message}」`}\n`)
process.exit(failed === null ? 0 : 1)
