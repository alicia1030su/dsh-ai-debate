#!/usr/bin/env node
/**
 * 版本号只有一处真相，但这个真相要在四个地方出现。
 *
 * ## 为什么需要一个脚本
 *
 * 上一次发版后，README 的安装命令指着当次的版本——那是当时的正确值，但下一次发版时它不会
 * 自己变。人工改的结果是：`package.json` 改了、README 忘了，于是用户按文档装到的是上一个
 * 版本，而且没有人会报错，因为「文档里写的版本能装上」这件事本身没有人测。
 *
 * 四处对应关系：
 *
 * | 位置 | 内容 | 谁在读它 |
 * | --- | --- | --- |
 * | `package.json` | `version` | 打包、标签校验、npm |
 * | `README.md` | 安装命令、Release 链接、附件名 | 用户 |
 * | `CHANGELOG.md` | `## [x.y.z]` 段落 | 发布说明生成 |
 * | git 标签 | `v<x.y.z>` | Release 工作流 |
 *
 * 脚本管前三个（标签在远端，只能在 `check --tag` 时比对）。
 *
 * 判定规则在 `scripts/lib/version-core.mjs`：那里是纯函数，测试可以直接喂假的 README 文本，
 * 不用真的去启动一个会 `process.exit` 的程序。
 *
 * 用法：
 *   node scripts/version.mjs check
 *   node scripts/version.mjs check --tag v0.2.17
 *   node scripts/version.mjs set 0.2.17     # CHANGELOG 必须先有该版本段落
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { changelogHasVersion, checkReadme, rewriteReadme, staleVersionMentions } from './lib/version-core.mjs'

const root = process.cwd()
const pkgPath = join(root, 'package.json')
const readmePath = join(root, 'README.md')
const changelogPath = join(root, 'CHANGELOG.md')

function check(args) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const expected = pkg.version
  const problems = []

  if (!/^\d+\.\d+\.\d+$/.test(expected)) {
    problems.push(`package.json 的 version 不是三段数字：${expected}`)
  }

  const readme = readFileSync(readmePath, 'utf8')
  problems.push(...checkReadme(readme, expected))

  const changelog = readFileSync(changelogPath, 'utf8')
  if (!changelogHasVersion(changelog, expected)) {
    problems.push(`CHANGELOG.md 里没有 ${expected} 的段落，发布说明会是空的`)
  }

  const tagFlag = args.indexOf('--tag')
  if (tagFlag !== -1) {
    const tag = args[tagFlag + 1]
    if (tag !== `v${expected}`) {
      problems.push(`标签是 ${tag}，而 package.json 是 ${expected}（应为 v${expected}）`)
    }
  }

  for (const problem of problems) console.log(`  ✖ ${problem}`)
  if (problems.length > 0) {
    console.log(`版本一致性：${problems.length} 个问题`)
    process.exit(1)
  }

  // 提示性的，不影响退出码：安装说明附近可能还留着旧版本号，人看得到就行。
  const stale = staleVersionMentions(readme, expected)
  for (const item of stale) {
    console.log(`  提示：README 第 ${item.line} 行仍提到 ${item.version}（${item.text.slice(0, 60)}）`)
  }

  console.log(`版本一致性：通过（${expected}）`)
}

function set(args) {
  const target = args[0]
  if (!/^\d+\.\d+\.\d+$/.test(String(target ?? ''))) {
    console.error(`版本号必须形如 0.2.17，收到的是 ${JSON.stringify(target)}`)
    process.exit(1)
  }

  const pkgText = readFileSync(pkgPath, 'utf8')
  const previous = JSON.parse(pkgText).version

  // 先检查前置条件再动文件。一条命令改到一半失败，最容易留下「一半新一半旧」的状态，
  // 而那种状态下次构建时不会有任何明显症状。
  const changelog = readFileSync(changelogPath, 'utf8')
  if (!changelogHasVersion(changelog, target)) {
    console.error(
      `CHANGELOG.md 里还没有 ${target} 的段落。\n` +
        `请先写好 \`## [${target}] — YYYY-MM-DD\` 段落，再跑这条命令。\n` +
        '版本号先改、说明后补，会让发布说明在补上之前一直是空的。',
    )
    process.exit(1)
  }

  const pkgNext = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${target}$2`)
  const readme = readFileSync(readmePath, 'utf8')
  const readmeNext = rewriteReadme(readme, previous, target)

  const problems = checkReadme(readmeNext, target)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✖ ${problem}`)
    console.error('README 改写后仍不一致，未写入任何文件')
    process.exit(1)
  }

  writeFileSync(pkgPath, pkgNext, 'utf8')
  writeFileSync(readmePath, readmeNext, 'utf8')

  console.log(`版本：${previous} → ${target}`)
  console.log('  已更新 package.json、README.md')
  console.log(`  下一步：node scripts/version.mjs check --tag v${target}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'check') check(rest)
else if (command === 'set') set(rest)
else {
  console.error('用法：node scripts/version.mjs <check|set> [参数]')
  process.exit(1)
}
