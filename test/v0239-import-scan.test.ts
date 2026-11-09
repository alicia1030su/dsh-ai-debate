/**
 * 裸导入扫描必须区分「代码里的 import」与「注释里提到的 import」（v0.2.39 复审 §5）。
 *
 * ## 这条测试对应的真实故障
 *
 * `scripts/verify-install.mjs` 是「安装包能不能独立装上」的唯一自动化门禁。它会对解包后
 * 的 `lib/` 做一次裸导入扫描，凡是被 import 的包都必须声明在 `dependencies` 里。
 *
 * 但扫描器读的是原始文本。`src/host-llm.ts` 从 v0.2.36 起有一句注释，说明「故意不 import
 * 那个类型」：
 *
 * ```ts
 * // 这里用结构化类型（HostLlmLike）而不是 import type { ... } from '@deepseek-ai/dsh-llm'
 * ```
 *
 * 扫描器把这句话当成了依赖声明，于是报告「`@deepseek-ai/dsh-llm` 只声明在 peerDependencies
 * 或完全没声明」，安装验证从那一刻起每次都是红的。它红的理由与实际发布物毫无关系 ——
 * 一个注释。
 *
 * ## 为什么测试要盯住「注释里的」而不是「注释」
 *
 * 剥注释的朴素做法（`text.replace(/\/\/.*$/gm, '')`）会把 URL 里的 `//` 也当成注释起点，
 * 于是 `https://example` 后面的字符串被吞掉，反过来漏掉真依赖。所以这里既断言
 * 「注释里的 import 不算」，也断言「字符串里的 // 之后的 import 仍然算」。
 * 两条都过，才说明扫描器理解的是结构而不是字形。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { bareImportsIn, stripComments } from '../scripts/lib/import-scan.mjs'

test('stripComments：行注释与块注释都被丢弃，代码保留', () => {
  const source = [
    "import { a } from 'pkg-a'",
    "// import { b } from 'pkg-commented'",
    '/* import { c } from "pkg-block" */',
    "import { d } from 'pkg-d'",
    '',
  ].join('\n')
  const stripped = stripComments(source)
  assert.match(stripped, /pkg-a/)
  assert.match(stripped, /pkg-d/)
  assert.doesNotMatch(stripped, /pkg-commented/)
  assert.doesNotMatch(stripped, /pkg-block/)
  assert.equal(stripped.split('\n').filter((line) => line !== '').length, 2, '只剩两行真代码')
})

test('stripComments：字符串里的 // 不是注释起点', () => {
  const source = ["const url = 'https://example.invalid/x'", "import { e } from 'pkg-after-url'", ''].join('\n')
  const stripped = stripComments(source)
  assert.match(stripped, /https:\/\/example\.invalid\/x/, 'URL 必须原样保留')
  assert.match(stripped, /pkg-after-url/, 'URL 之后的真导入不能被一个注释起点吞掉')
})

test('stripComments：字符串里的 import 字样不算依赖', () => {
  const source = ["const note = 'this is not an import from pkg-string'", "import { f } from 'pkg-real'", ''].join('\n')
  const imports = [...stripComments(source).matchAll(/from\s+'([^.'][^']*)'/g)].map((match) => match[1])
  assert.deepEqual(imports, ['pkg-real'])
})

test('stripComments：转义引号不会提前结束字符串', () => {
  const source = ["const quoted = 'it\\'s fine'", "import { g } from 'pkg-after-escape'", ''].join('\n')
  const stripped = stripComments(source)
  assert.match(stripped, /pkg-after-escape/, '转义引号之后仍在字符串外')
})

test('bareImportsIn：注释里引用的包不进入依赖清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-import-scan-'))
  try {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    // 与 src/host-llm.ts 里那句注释同形状：说明「故意不 import」。
    writeFileSync(
      join(dir, 'host-llm.js'),
      [
        '/*',
        ' * 这里用结构化类型而不是',
        " * `import type { Something } from '@deepseek-ai/dsh-llm'`",
        ' */',
        "import { LlmError } from './llm.js'",
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(dir, 'nested', 'entry.js'), "import { schemastery } from '@deepseek-ai/schemastery'\n", 'utf8')

    const imports = bareImportsIn(dir)
    assert.equal(
      imports.has('@deepseek-ai/dsh-llm'),
      false,
      '注释里提到的包不是依赖：把它列进来会让安装验证永远红',
    )
    assert.equal(imports.has('@deepseek-ai/schemastery'), true, '真依赖必须仍然被列出')
    assert.equal(imports.has('./llm.js'), false, '相对导入不是包说明符')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
