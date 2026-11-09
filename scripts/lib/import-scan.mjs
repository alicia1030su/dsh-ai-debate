/**
 * 找出产物里的**裸导入**，供安装验证判断「哪些包必须随包声明」。
 *
 * ## 为什么要单独一个模块（v0.2.39 复审 §5）
 *
 * 原来的实现直接对 `.js` 文本跑 `from '...'` 正则。它把**注释里引用的 import 形式**
 * 也当成了真依赖：`src/host-llm.ts` 从 v0.2.36 起就有一句
 *
 * ```ts
 * // 这里用结构化类型，而不是 import type { ... } from '@deepseek-ai/dsh-llm'
 * ```
 *
 * 用来说明「故意不这么做」。扫描器读到这行，认定插件需要 `@deepseek-ai/dsh-llm`，
 * 于是在裸目录安装验证里报「只声明在 peerDependencies 或完全没声明」。
 *
 * 这个误报从 v0.2.36 一直红到 v0.2.39：验证脚本本身的结论被一个注释带偏，而它又是
 * 「安装包能不能独立装上」的唯一自动化门禁。误报和漏报的代价一样 —— 都会让人开始
 * 忽略这个脚本。
 *
 * ## 为什么是状态机而不是正则
 *
 * `//` 也出现在 URL 和字符串里（`https://…`）。用正则剥注释会切坏字符串，于是
 * 一处修好、另一处漏掉。这里逐字符走：字符串原样保留，注释整段丢弃，转义字符
 * 不参与判定。它不需要理解 JavaScript 的全部语法，只需要正确区分「代码 / 字符串 /
 * 注释」三件事 —— 这正是判定导入所需要的全部。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 去掉行注释与块注释，保留字符串内容。
 *
 * @param {string} text 源码文本
 * @returns {string} 去掉注释后的文本
 */
export function stripComments(text) {
  let out = ''
  let index = 0
  /** `''` 表示不在字符串里；否则是当前字符串的引号。 */
  let quote = ''

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (quote !== '') {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = ''
      index += 1
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }

    out += char
    index += 1
  }

  return out
}

/**
 * 列出目录下所有 JS 文件里的裸导入（包说明符）。
 *
 * @param {string} dir 目录
 * @returns {Set<string>} 包说明符集合
 */
export function bareImportsIn(dir) {
  const found = new Set()
  if (!existsSync(dir)) return found
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name)
    if (statSync(absolute).isDirectory()) {
      for (const specifier of bareImportsIn(absolute)) found.add(specifier)
      continue
    }
    if (!name.endsWith('.js')) continue
    // 先剥注释：注释里引用的 import 不是依赖。
    const text = stripComments(readFileSync(absolute, 'utf8'))
    for (const match of text.matchAll(/from\s+'([^.'][^']*)'/g)) found.add(match[1])
    for (const match of text.matchAll(/require\('([^.'][^']*)'\)/g)) found.add(match[1])
  }
  return found
}
