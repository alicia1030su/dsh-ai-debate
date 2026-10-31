#!/usr/bin/env node
/**
 * Release 的无发布模拟（任务书 §二）。
 *
 * ## 它解决什么问题
 *
 * `release.yml` 里有一整段只在**真发版**时才走到的东西：从 CHANGELOG 截说明、现算两个附件的
 * SHA-256、拼安装命令、把它交给 `gh release create`。这段逻辑从来没有在 PR 阶段被执行过，
 * 所以它的错误只在打完标签、推上去之后才暴露 —— v0.2.16 的两个真实缺陷都栽在这里：
 *
 * 1. `upload-artifact` 拒绝 `..` 路径（说明「路径在本地能用」不等于「在发布时能用」）；
 * 2. 发布说明里的哈希与实际产物的哈希对不上（说明「写了哈希」不等于「哈希是对的」）。
 *
 * 这个脚本把那段逻辑**原样跑一遍**，只是最后不调用 `gh release create`。于是：
 *
 * - 说明的每一行在 PR 里就能看到
 * - 两个哈希都是现读磁盘算的，和用户将要下载的文件一致
 * - 附件名里带 `..` / 斜杠会被当场拒绝
 * - 说明里少了安装命令、少了哈希、出现占位文本，都会让 CI 变红
 *
 * ## 它不做的事
 *
 * 它**没有**任何网络调用，也不碰 GitHub。它不检查「Release 是否已存在」「标签是否合法」——
 * 那些是关于远端的事实，只在真实发布时才成立，模拟它们只会制造虚假信心。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/release-dry-run.mjs              # 校验，失败即退出非零
 * node scripts/release-dry-run.mjs --emit x.md  # 校验并把说明写到 x.md（release.yml 用这条）
 * ```
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildReleaseNotes, checkReleaseNotes } from './lib/release-notes.mjs'

const root = process.cwd()
const args = process.argv.slice(2)
const emitIndex = args.indexOf('--emit')
const emitPath = emitIndex === -1 ? null : args[emitIndex + 1]

/** 仓库标识。CI 里来自 `GITHUB_REPOSITORY`，本地从 git remote 推不出来时用一个明确的默认值。 */
const repo = process.env.GITHUB_REPOSITORY ?? 'alicia1030su/dsh-ai-debate'

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json 的 version 不是三段数字：${version}`)

const tarball = `dsh-ai-debate-${version}.tgz`
const sourceZip = `dsh-ai-debate-source-${version}.zip`

// 两个包必须已经生成。这里不接受「找不到就用空哈希」—— 那正是占位文本的来源。
for (const name of [tarball, sourceZip]) {
  if (!existsSync(join(root, name))) {
    fail(`找不到 ${name}。先跑 node scripts/pack.mjs 与 node scripts/source-zip.mjs --out .`)
  }
  if (/\.\.|\//.test(name)) fail(`附件名不合法：${name}`)
}

const tarballSha256 = sha256Of(join(root, tarball))
const sourceZipSha256 = sha256Of(join(root, sourceZip))

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const notes = buildReleaseNotes({
  changelog,
  repo,
  version,
  tarball,
  tarballSha256,
  sourceZip,
  sourceZipSha256,
})

const problems = checkReleaseNotes(notes, { version, tarball, tarballSha256, sourceZip, sourceZipSha256, repo })

// CHANGELOG 缺段落不算致命（有兜底说明），但必须说出来：发布说明会比正常的短很多。
const hasSection = changelog.includes(`## [${version}]`)

if (problems.length > 0) {
  console.error('发布说明自检未通过：')
  for (const problem of problems) console.error(`  ✖ ${problem}`)
  process.exit(1)
}

if (emitPath !== null) {
  writeFileSync(emitPath, notes, 'utf8')
  console.log(`发布说明已写入 ${emitPath}`)
}

console.log('Release 无发布模拟')
console.log(`  版本：      ${version}`)
console.log(`  仓库：      ${repo}`)
console.log(`  安装包：    ${tarball}  ${tarballSha256}`)
console.log(`  源码包：    ${sourceZip}  ${sourceZipSha256}`)
console.log(`  CHANGELOG： ${hasSection ? `有 ${version} 段落` : `缺 ${version} 段落（将使用兜底说明）`}`)
console.log(`  说明长度：  ${notes.length} 字符，${notes.split('\n').length} 行`)
console.log('  结果：      通过（未创建 Release、未访问网络）')

if (!hasSection) {
  // 用 notice 而不是 error：有兜底说明，发布仍可继续，但作者应该补上。
  console.log(`::notice::CHANGELOG.md 缺少 ${version} 段落，发布说明会退化成兜底文案`)
}

if (process.env.RELEASE_DRY_RUN_PRINT === '1') {
  console.log('\n----- 发布说明预览 -----')
  console.log(notes)
  console.log('----- 预览结束 -----')
}
