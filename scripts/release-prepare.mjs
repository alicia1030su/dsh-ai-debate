#!/usr/bin/env node
/**
 * 从本地构建到可发布状态的一键脚本（供维护者使用，不参与 CI 逻辑）。
 *
 * 做的事情和 CI 完全一致，只是额外把产物摆在眼前：
 *   编译 → 类型检查 → 测试 → 打包 → 打印 git 与发布命令
 *
 * 用法：
 *   node scripts/release-prepare.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

/** 运行一个子步骤，失败即退出。 */
function step(label, script, args = []) {
  process.stdout.write(`\n\x1b[36m▶ ${label}\x1b[0m\n`)
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  })
  if (result.status !== 0) {
    process.stderr.write(`\x1b[31m✖ ${label} 失败\x1b[0m\n`)
    process.exit(result.status ?? 1)
  }
  process.stdout.write(`\x1b[32m✔ ${label}\x1b[0m\n`)
}

step('完整校验（编译 + 类型检查 + 测试）', 'scripts/verify.mjs')
step('打包并校验内容', 'scripts/pack.mjs')

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${manifest.version}`

process.stdout.write(
  `\n\x1b[32m本地已就绪\x1b[0m\n\n` +
    `接下来（需要你确认后才执行）：\n\n` +
    `  git init -b main                       # 如果还没初始化仓库\n` +
    `  git add -A\n` +
    `  git commit -m "feat: AI代吵架 v${manifest.version}（百度贴吧版）"\n` +
    `  git remote add origin git@github.com:<owner>/dsh-ai-debate.git\n` +
    `  git push -u origin main\n` +
    `  git tag -a ${tag} -m "${tag}"\n` +
    `  git push origin ${tag}                 # 触发 Release 工作流\n\n` +
    `如果不想用 Actions，也可以手动发布：\n\n` +
    `  gh release create ${tag} dsh-ai-debate-${manifest.version}.tgz \\\n` +
    `     --title "AI代吵架 ${tag}" --notes-file CHANGELOG.md\n\n` +
    `发布后用户即可安装：\n\n` +
    `  dsh plugin --profile <profile> add github:<owner>/dsh-ai-debate#${tag}\n\n`,
)
