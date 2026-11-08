#!/usr/bin/env node
/**
 * 独立核验公开源码包：每个文件是否等于仓库里**已提交**的那一份。
 *
 * ## 这个脚本解决的具体问题（v0.2.38 §7）
 *
 * v0.2.37 发布后，从同一台机器重建源码包得到 7815604 字节，GitHub 上是 7813235，
 * 相差 2369 字节。当时只能写「原因未查清」，因为手上没有工具回答一个更基本的问题：
 * **差的是哪几个文件、差在内容还是差在字节？**
 *
 * 查清后原因是确定的：工作树里 20 个文本文件被工具以文本模式重写成了 CRLF，仓库里
 * 存的是 LF（`.gitattributes` 写死 `eol=lf`），而 `source-zip.mjs` 读工作树。从干净
 * 检出重建，SHA256 与官方**逐字节一致** —— 源码包本身可复现，是打包时读错了基准。
 *
 * ## 为什么是「独立」核验
 *
 * 不 import `source-zip.mjs` 的任何规则，也不读它的白名单。判据只有一条：归档里每个
 * 文件都必须等于 `git cat-file` 出来的字节。多出来的、少掉的、内容不同的，全部列出。
 * 于是「这次发布是从哪个提交、哪些文件出来的」不再需要相信打包脚本的自述。
 *
 * ## 它说什么、不说什么
 *
 * 说：哪些文件不一致、差在哪一类（内容 / 仅行尾 / 归档多出 / 归档缺失）。
 * 不说：源码包「可完全复现」。字节级复现还要求同一套 Node/zlib，这一点只能记录在
 * 报告的「构建环境」一节，不能由这个脚本证明。
 *
 * ```bash
 * node scripts/verify-source-archive.mjs                     # 找当前版本的包
 * node scripts/verify-source-archive.mjs --zip path/to.zip
 * node scripts/verify-source-archive.mjs --json out.json     # 附带逐文件哈希清单
 * node scripts/verify-source-archive.mjs --drift             # 只查工作树与 HEAD 的差异
 * ```
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  headPaths,
  readHeadBlobs,
  verifyArchive,
  workingTreeDrift,
} from './lib/archive-verify.mjs'

const root = process.cwd()

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? '')
}

const driftOnly = process.argv.includes('--drift')

if (driftOnly) {
  const drift = workingTreeDrift(root, headPaths(root))
  if (drift.length === 0) {
    process.stdout.write('✔ 工作树里所有跟踪文件与 HEAD 逐字节一致\n')
    process.exit(0)
  }
  process.stdout.write(`✖ ${drift.length} 个跟踪文件与 HEAD 不一致：\n`)
  for (const line of drift.slice(0, 40)) process.stdout.write(`  · ${line}\n`)
  process.stdout.write(
    '\n工作树与提交不一致时打包，产出的归档就不是那个提交的副本。\n' +
      '先提交或还原这些改动，再打包。只有行尾不同的，`git config core.autocrlf false` 后重新检出即可。\n',
  )
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const explicit = arg('zip')
const candidates =
  explicit !== ''
    ? [resolve(explicit)]
    : [
        join(root, '..', `dsh-ai-debate-source-${version}.zip`),
        join(root, `dsh-ai-debate-source-${version}.zip`),
      ]
const zipPath = candidates.find((candidate) => existsSync(candidate))
if (zipPath === undefined) {
  process.stderr.write(
    `找不到源码包（找过：\n  ${candidates.join('\n  ')}\n）。先跑 node scripts/source-zip.mjs\n`,
  )
  process.exit(2)
}

const createHashHex = (buffer) => createHash('sha256').update(buffer).digest('hex')
const zipBytes = readFileSync(zipPath)
const paths = headPaths(root)
const blobs = readHeadBlobs(root, paths)
const verification = verifyArchive(zipBytes, blobs, paths.length)

const report = {
  zip: zipPath,
  bytes: zipBytes.length,
  sha256: createHashHex(zipBytes),
  entries: verification.entries,
  identical: verification.identical,
  totals: verification.totals,
  problems: verification.verdicts,
  missing: verification.missing,
  // 构建环境必须记录：字节级复现依赖同一套 Node/zlib。
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    command: 'node scripts/source-zip.mjs --out <dir>',
  },
}


process.stdout.write(`源码包 ${zipPath}\n`)
process.stdout.write(`  sha256 ${report.sha256}\n`)
process.stdout.write(`  ${verification.entries} 个条目，${verification.identical} 个与 HEAD 逐字节一致\n`)

if (verification.verdicts.length === 0 && verification.missing.length === 0) {
  process.stdout.write('  ✔ 归档内容与已提交内容完全一致\n')
} else {
  process.stdout.write(
    `  ✖ ${verification.verdicts.length} 个条目不一致，${verification.missing.length} 个跟踪文件不在归档里\n`,
  )
  for (const verdict of verification.verdicts.slice(0, 20)) {
    process.stdout.write(`    · ${verdict.path} — ${verdict.kind}：${verdict.detail}\n`)
  }
  if (verification.verdicts.length > 20) {
    process.stdout.write(`    …（其余 ${verification.verdicts.length - 20} 条省略）\n`)
  }
  for (const path of verification.missing.slice(0, 10)) process.stdout.write(`    · 缺失 ${path}\n`)
}

if (verification.totals.lineEndingsOnly > 0) {
  process.stdout.write(
    `\n其中 ${verification.totals.lineEndingsOnly} 个文件「只差行尾」。这不是源码被改，` +
      '而是打包时工作树里存的是 CRLF、仓库里存的是 LF。\n' +
      '从干净检出打包即可复现；`git config core.autocrlf false` 后重新检出。\n',
  )
}

const jsonOut = arg('json')
if (jsonOut !== '') {
  writeFileSync(
    resolve(jsonOut),
    `${JSON.stringify({ ...report, manifest: verification.manifest }, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`逐文件清单已写入 ${resolve(jsonOut)}\n`)
}

// 不一致就非零退出：这个脚本的用途是门禁，不是报告。
process.exit(verification.verdicts.length === 0 && verification.missing.length === 0 ? 0 : 1)
