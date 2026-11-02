/**
 * 依赖复制必须同时支持 pnpm 的两种布局。
 *
 * ## 这条测试防的是什么
 *
 * `scripts/deps.mjs` 原来只按 pnpm 的 **isolated** 布局解析依赖：扫描
 * `node_modules/.pnpm/`，找名为 `<scope>+<name>@<version>` 的目录。
 *
 * 但 pnpm 还会产出 **hoisted** 布局（`nodeLinker: hoisted`）：依赖被平铺进项目
 * 自己的 `node_modules/`，而 `.pnpm/` 里**一个包目录都没有**——本机上它只有一份
 * `lock.yaml`。于是在那种机器上，`verify-install.mjs` 报出
 * 「无法在 pnpm 存储里找到 @deepseek-ai/schemastery 的依赖 @standard-schema/spec」，
 * 而那个包其实就在 `node_modules/@standard-schema/spec`，可以正常 import。
 *
 * 安装验证把一个**布局差异**说成了**打包缺陷**，而且结论是「装不上」——比不跑更糟，
 * 因为它会让人去修一个不存在的问题。
 *
 * ## 这里的做法
 *
 * 不测具体实现，而是构造两种真实的目录形状，各跑一次复制，断言：
 * 1. 依赖能被找到并复制（两种布局都要成立）；
 * 2. 复制出来的目录**真的能被 Node 解析**（用一个真实的 import 验证，而不是只看文件在不在）。
 *
 * 查找失败时还要求错误信息说明「两个地方都找过了」——否则下次又会有人以为是缺包。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')

/** What the child process reports back. */
interface CopyResult {
  readonly ok: boolean
  readonly copied?: readonly string[]
  readonly who?: string
  readonly message?: string
}

/** Write a minimal importable package: an ESM entry that exports its own name. */
function writePackage(dir: string, name: string, dependencies: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        exports: './index.js',
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      },
      null,
      2,
    ),
  )
  writeFileSync(join(dir, 'index.js'), `export const who = ${JSON.stringify(name)}\n`)
}

/**
 * Run `copyWithDependencies` in a child process and print what it produced.
 *
 * A child process is used (rather than importing the module here) because the
 * function's behaviour depends on the on-disk layout relative to `from`, and the
 * test needs several mutually incompatible layouts in one run.
 */
function runCopy(input: {
  readonly name: string
  readonly from: string
  readonly storeDir: string
  readonly targetDir: string
}): CopyResult {
  const { name, from, storeDir, targetDir } = input
  // `import('C:/...')` is not a valid specifier on Windows — the loader reads the
  // drive letter as a URL scheme. Both the module under test and the copied output
  // therefore have to be addressed as file:// URLs.
  const depsUrl = pathToFileURL(join(ROOT, 'scripts', 'deps.mjs')).href
  const outUrl = pathToFileURL(join(targetDir, name, 'index.js')).href
  const script = `
    import { copyWithDependencies } from ${JSON.stringify(depsUrl)};
    try {
      const copied = copyWithDependencies(${JSON.stringify({ name, from, storeDir, targetDir })});
      const mod = await import(${JSON.stringify(outUrl)});
      console.log(JSON.stringify({ ok: true, copied, who: mod.who }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: String(error && error.message || error) }));
    }
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: ROOT,
  })
  const last = stdout.trim().split('\n').pop()
  assert.ok(last !== undefined, '子进程没有输出任何结果')
  return JSON.parse(last) as CopyResult
}

test('hoisted 布局：依赖平铺在根 node_modules，.pnpm 里没有包目录时也能复制', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-deps-hoisted-'))
  try {
    // This is the shape that broke: one flat node_modules, an empty .pnpm.
    const modules = join(dir, 'node_modules')
    writePackage(join(modules, '@scope', 'leaf'), '@scope/leaf')
    writePackage(join(modules, '@scope', 'top'), '@scope/top', { '@scope/leaf': '^1.0.0' })
    mkdirSync(join(modules, '.pnpm'), { recursive: true })
    writeFileSync(join(modules, '.pnpm', 'lock.yaml'), 'lockfileVersion: 9.0\n')

    const target = join(dir, 'out')
    const result = runCopy({
      name: '@scope/top',
      from: join(modules, '@scope', 'top'),
      storeDir: join(modules, '.pnpm'),
      targetDir: target,
    })

    assert.equal(result.ok, true, `hoisted 布局下复制失败：${result.message}`)
    assert.deepEqual(
      [...(result.copied ?? [])].sort(),
      ['@scope/leaf', '@scope/top'],
      '两个包都应被复制；缺一个就说明解析仍然只认虚拟存储',
    )
    assert.equal(result.who, '@scope/top', '复制后的包必须真的能被 Node 解析')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isolated 布局：依赖在 .pnpm 里时仍然能复制（不能为了修 hoisted 而弄坏它）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-deps-isolated-'))
  try {
    // The shape the old code assumed: the dependency exists only inside the store.
    const modules = join(dir, 'node_modules')
    const store = join(modules, '.pnpm')
    writePackage(join(store, '@scope+leaf@1.0.0', 'node_modules', '@scope', 'leaf'), '@scope/leaf')
    writePackage(join(modules, '@scope', 'top'), '@scope/top', { '@scope/leaf': '^1.0.0' })

    const target = join(dir, 'out')
    const result = runCopy({
      name: '@scope/top',
      from: join(modules, '@scope', 'top'),
      storeDir: store,
      targetDir: target,
    })

    assert.equal(result.ok, true, `isolated 布局下复制失败：${result.message}`)
    assert.deepEqual([...(result.copied ?? [])].sort(), ['@scope/leaf', '@scope/top'])
    assert.equal(result.who, '@scope/top')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真的找不到依赖时，错误信息要说清两个查找位置都试过了', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-deps-missing-'))
  try {
    const modules = join(dir, 'node_modules')
    writePackage(join(modules, '@scope', 'top'), '@scope/top', { '@scope/absent': '^1.0.0' })
    mkdirSync(join(modules, '.pnpm'), { recursive: true })

    const result = runCopy({
      name: '@scope/top',
      from: join(modules, '@scope', 'top'),
      storeDir: join(modules, '.pnpm'),
      targetDir: join(dir, 'out'),
    })

    assert.equal(result.ok, false, '缺依赖时必须失败，而不是产出一个装不上的目录')
    const message = result.message ?? ''
    assert.match(message, /@scope\/absent/, '要指出缺的是哪个包')
    assert.match(message, /Node 规则/, '要说明按 Node 规则向上找过')
    assert.match(message, /pnpm 存储/, '要说明也在 pnpm 存储里找过——否则会被误读成布局问题')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
