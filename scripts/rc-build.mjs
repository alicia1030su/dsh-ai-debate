#!/usr/bin/env node
/**
 * 构建 **v0.3.0-rc.1 候选产物**（不是发布）。
 *
 * ## 为什么需要单独一个脚本
 *
 * 任务书要求预发布候选，但仓库的版本工具只接受三段数字（`x.y.z`）：
 *
 * - `scripts/version.mjs` 拒绝 `0.3.0-rc.1`；
 * - `scripts/release-dry-run.mjs` 同样拒绝；
 * - `release.yml` 用 `TAG_VERSION != PKG_VERSION` 做标签校验，且 `gh release create`
 *   没有 `--prerelease`，一个 rc 标签会被打成 **Latest 正式版**。
 *
 * 结论：**当前流程不支持预发布版本号**。按任务书的规定，这种情况不修改工作流
 * （改发布流程需要维护者批准），而是产出「明确标识的非公开候选产物」：
 *
 * - 目录：`.ship/v0.3.0-rc.1/`（已被 `.gitignore` 忽略，不会误提交）；
 * - 文件名与 `MANIFEST.json` 都写明 `candidate` 与 `release: false`；
 * - 不创建 tag、不创建 Release、不改 `main`；
 * - 仍然执行**全部发布前检查**：双包扫描、源码包逐文件核验、裸目录安装。
 *
 * ## 它检查什么
 *
 * 任何一步失败都退出非零，不产出「看起来完整」的目录。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const label = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : 'v0.3.0-rc.1'
if (typeof label !== 'string' || !/^v\d+\.\d+\.\d+-rc\.\d+$/.test(label)) {
  console.error(`候选标签必须是 vX.Y.Z-rc.N，收到 ${JSON.stringify(label)}`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.error(`package.json 版本不是三段数字：${pkg.version}`)
  process.exit(2)
}

const outputDir = join(root, '.ship', label)
rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

function run(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const failure = error
    process.stderr.write(`✖ ${command} ${args.join(' ')}\n`)
    process.stderr.write(`${failure.stdout ?? ''}${failure.stderr ?? ''}\n`)
    process.exit(typeof failure.status === 'number' ? failure.status : 1)
  }
}

const step = (name) => process.stdout.write(`\n▶ ${name}\n`)

step('构建安装包（tsc + pack）')
run(process.execPath, ['scripts/pack.mjs'])
const tarball = join(root, `dsh-ai-debate-${pkg.version}.tgz`)
if (!existsSync(tarball)) {
  console.error(`✖ 没有生成 ${tarball}`)
  process.exit(1)
}

step('构建源码包')
run(process.execPath, ['scripts/source-zip.mjs', '--out', outputDir])
const sourceZip = join(outputDir, `dsh-ai-debate-source-${pkg.version}.zip`)
if (!existsSync(sourceZip)) {
  console.error(`✖ 没有生成 ${sourceZip}`)
  process.exit(1)
}

step('独立扫描两个产物')
run(process.execPath, ['scripts/scan-archive.mjs', tarball])
run(process.execPath, ['scripts/scan-archive.mjs', sourceZip])

step('源码包逐文件核验（等于 git 提交）')
run(process.execPath, ['scripts/verify-source-archive.mjs', '--zip', sourceZip])

step('裸目录安装验证')
run(process.execPath, ['scripts/verify-install.mjs', tarball])

step('写入候选清单')
copyFileSync(tarball, join(outputDir, `dsh-ai-debate-${pkg.version}.tgz`))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const tarballSha = sha256(join(outputDir, `dsh-ai-debate-${pkg.version}.tgz`))
const sourceSha = sha256(sourceZip)
const commit = run('git', ['rev-parse', 'HEAD']).trim()

writeFileSync(
  join(outputDir, 'SHA256SUMS.txt'),
  `${tarballSha}  dsh-ai-debate-${pkg.version}.tgz\n${sourceSha}  dsh-ai-debate-source-${pkg.version}.zip\n`,
  'utf8',
)

const manifest = {
  candidate: label,
  release: false,
  note: '候选构建：未打标签、未创建 Release、未合并到 main。不得当作正式版本分发。',
  version: pkg.version,
  commit,
  builtAt: new Date().toISOString(),
  artifacts: [
    { file: `dsh-ai-debate-${pkg.version}.tgz`, sha256: tarballSha, bytes: readFileSync(join(outputDir, `dsh-ai-debate-${pkg.version}.tgz`)).length },
    { file: `dsh-ai-debate-source-${pkg.version}.zip`, sha256: sourceSha, bytes: readFileSync(sourceZip).length },
  ],
}
writeFileSync(join(outputDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

process.stdout.write(`\n候选构建完成（不是发布）：${resolve(outputDir)}\n`)
process.stdout.write(`  ${label} · commit ${commit.slice(0, 12)}\n`)
process.stdout.write(`  tgz  sha256 ${tarballSha}\n`)
process.stdout.write(`  zip  sha256 ${sourceSha}\n`)
