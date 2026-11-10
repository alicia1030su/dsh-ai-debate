#!/usr/bin/env node
/**
 * 生成「可以直接交给测试者」的 v0.3.0 测试包。
 *
 * ## 为什么要有生成器，而不是手写一份
 *
 * 测试包里的 30 条案例必须与 `test/gui/quality-cases.ts` 完全一致。手抄一次，
 * 下一版改案例时就会漏掉某几行；而评审材料一旦与采集器用的样本不同，
 * 「两版对比」这件事本身就不成立了。
 *
 * 所以这里只做拼装：案例来自 `scripts/quality-corpus-materials.json`（由案例模块生成），
 * 表格结构与 `docs/v0.3.0-review-kit.md` 对齐。改格式改这里，改案例改案例模块。
 *
 * ## 它不生成什么
 *
 * 不生成任何「分数」或「结论」。测试包是空表，填表的是人。
 *
 * 用法：
 *   node scripts/gen-tester-package.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const outDir = join(root, 'docs', 'v0.3.0-tester-package')
const materials = JSON.parse(readFileSync(join(root, 'scripts', 'quality-corpus-materials.json'), 'utf8'))

const ids = Object.keys(materials).sort()
if (ids.length !== 30) {
  console.error(`案例数应为 30，实际 ${ids.length}：测试包与采集器样本不一致`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

/** 从材料里取标题（第一行 `# `）。材料缺失标题时用 id，不编一个。 */
function titleOf(text, id) {
  const first = String(text).split(/\r?\n/).find((line) => line.startsWith('# '))
  return first === undefined ? id : first.slice(2).trim()
}

const caseRows = ids.map((id) => {
  const text = String(materials[id])
  return { id, title: titleOf(text, id), text: text.trim() }
})

const cases = [
  '# v0.3.0 匿名评审案例（30 条）',
  '',
  '> 这些是脱敏后的讨论材料。每一条都来自固定样本，与采集器使用的案例一一对应。',
  '> 请对**两条回复 A / B** 分别按 `03-scoring-sheet.csv` 打分；不要猜测哪条来自哪个版本。',
  '',
  '---',
  '',
  ...caseRows.flatMap((row) => [
    `## ${row.id} · ${row.title}`,
    '',
    '```text',
    row.text,
    '```',
    '',
    '---',
    '',
  ]),
].join('\n')

const header = [
  'case',
  'A_target',
  'A_fact',
  'A_relevance',
  'A_natural',
  'A_persona',
  'B_target',
  'B_fact',
  'B_relevance',
  'B_natural',
  'B_persona',
  'preferred',
  'concrete_problem',
]
const rows = caseRows.map((row) => [row.id, ...Array(10).fill(''), '', ''].join(','))
const sheet = [header.join(','), ...rows].join('\n') + '\n'

const install = `# 安装与首次使用（测试者版）

> 目标：不打开命令行，完成「装好 → 配模型 → 粘讨论 → 生成 → 改 → 批准 → 复制」。
> 遇到卡住的地方请原样记下来，那比「整体不错」有用。

## 1. 安装

安装包：\`dsh-ai-debate-<版本>.tgz\` —— 文件名里的版本必须与本批交付说明一致。
候选版是 \`dsh-ai-debate-0.3.0-rc.1.tgz\`，正式版是 \`dsh-ai-debate-0.3.0.tgz\`；
SHA-256 见交付说明。**不要**用旧版本或本地自行构建的包。

如果你已经在用 DSH Desktop：

1. 打开 DSH 的插件页；
2. 选择「从本地安装」，选中上面的 tgz；
3. 重启 DSH；
4. 插件列表里应出现「AI 代吵架」。

如果启动器要求命令行，请让组织者协助一次；把这一步的卡点写进反馈表。

## 2. 配模型

进入插件 → 设置 → AI 模型：

1. 先点「检查宿主模型」。能列出模型就直接选一个；
2. 否则选「自己配置的模型接口」，填地址、模型名、API Key；
3. 点「测试模型连接」，看到协议、耗时与 token 数才算成功。

API Key 只存本机凭据库；不要把它写进反馈表或截图。

## 3. 粘一段讨论

工作台 → 离线讨论导入 → 粘贴一段你熟悉的讨论（用 \`02-cases.md\` 里的材料也可以）。
点「预览解析」，确认原帖、参与者与条数与你的理解一致，再点「确认导入并分析」。

## 4. 选对手、选人格、生成

1. 在参与者里选中你要回的那个人；
2. 选人格与打法（不知道选什么就留「自动」）；
3. 点生成。可以点「比较四种人格」看四种语气。

## 5. 改、批准、复制

1. 直接改正文，点「保存并重新评估」；
2. 看安全评估的结论与理由；
3. 点「人工确认」；**未确认时复制是禁用的**，这是设计；
4. 点「复制回复」，粘贴到你能检查的地方。

## 6. 重启后还在吗

关掉 DSH 再打开，回到插件：刚才的会话应该仍在，步骤停在「复制回复」。

## 7. 这个版本不做什么

- 不会自动发到贴吧/微博；本轮没有真实平台发表入口；
- 不会替你把关事实：安全评估是确定性检查，不是事实核查；
- 不会保存你的 API Key 到配置或日志里。
`

const feedback = `# 测试者反馈表（每人一份）

| 项 | 填写 |
| --- | --- |
| 测试日期 | |
| 是否独立完成安装 | 是 / 否（卡在哪一步） |
| 是否用过命令行 | 是 / 否（做了什么） |
| 配模型是否顺利 | 是 / 否（哪一步不懂） |
| 导入讨论是否顺利 | 是 / 否 |
| 选回复对象是否清楚 | 是 / 否 |
| 是否理解「未批准不能复制」 | 是 / 否 |
| 是否能判断回复是否合适 | 能 / 不能（为什么） |
| 是否愿意再次使用 | 是 / 否 |
| 遇到的阻断问题 | |
| 最想改的一件事 | |

## 允许提供 / 禁止提供

- 可以：卡住时的界面截图（遮住账号与 API Key）、你看不懂的提示原文。
- 不要：API Key、Cookie、真实账号、未脱敏的聊天记录、他人隐私。

## 组织者填写（测试者不填）

- 发放人数：
- 独立完成全流程人数：
- 至少卡住一次的人数：
- 阻断问题分类：安装 / 模型 / 导入 / 生成 / 批准 / 复制
- 是否达到事先约定的准入标准：
`

const checklist = `# 组织者清单

## 发放前

- [ ] 确认候选包 SHA-256 与交付说明一致
- [ ] 确认测试者拿到的是本批的那个 tgz（\`dsh-ai-debate-0.3.0-rc.1.tgz\` 或 \`dsh-ai-debate-0.3.0.tgz\`），不是旧版本
- [ ] 候选版与正式版的告警措辞一致：标清是预发布（Pre-release），不要转述成正式版
- [ ] 给每位测试者一份 \`01-install.md\`、\`02-cases.md\`、\`03-scoring-sheet.csv\`、\`04-feedback-form.md\`
- [ ] 说明：不提供 API Key / Cookie / 真实账号

## 回收后

- [ ] 按人归档反馈表，不改写原话
- [ ] 统计完成率、卡点分类
- [ ] 评审表只统计真实填写的行；空行不算「通过」
- [ ] 把「阻断问题」原样汇总进发布报告

## 三人分配（建议）

30 条案例对单个测试者偏重，按人切分更容易拿到真实完成率：

| 测试者 | 案例 | 必须完成 |
| --- | --- | --- |
| T1 | \`q01\`–\`q10\` | 安装 + 至少 3 条完整生成 |
| T2 | \`q11\`–\`q20\` | 安装 + 至少 3 条完整生成 |
| T3 | \`q21\`–\`q30\` | 安装 + 至少 3 条完整生成 |

- 每人另外都做一遍 \`01-install.md\` 的完整流程（安装 → 配模型 → 导入 → 生成 → 改 → 批准 → 复制 → 重启）；
- 三条**重叠**案例用于交叉核对：\`q01\`、\`q15\`、\`q30\`。重叠部分只用来判断「不同人看同一条会不会分歧」，不做合并计分；
- 分配可以改，但**改完要写在这里**，否则回收后无法判断哪条被谁评过。

## 不能做

1. 不代替测试者填表。没做就是没做。
2. 不把自动评审写成人评。
3. 不在未达到人数/完成率时把用户验收标为通过。
4. 不泄露测试者身份与聊天原文。
5. 发现严重问题先修，再用**同一批**案例复评。
`

const readme = `# v0.3.0 外部测试包

这个目录是给**真实测试者**的，不是自动评审的产物。

| 文件 | 给谁 | 用途 |
| --- | --- | --- |
| \`01-install.md\` | 测试者 | 安装、配模型、走完一次完整流程 |
| \`02-cases.md\` | 测试者 | 30 条脱敏讨论材料（固定样本） |
| \`03-scoring-sheet.csv\` | 测试者 | 两条回复 A/B 的逐条评分（空表） |
| \`04-feedback-form.md\` | 测试者 | 试用反馈（每人一份） |
| \`05-organizer-checklist.md\` | 组织者 | 发放、回收、统计口径与边界 |

## 当前状态（必须如实转述）

- 测试包已生成，**尚未发放给任何真实测试者**；
- 人工语义评分：**0 人**；
- 真实用户试用：**0 人**。

在这些数字变化之前，v0.3.0 的「人工质量验收」与「真实用户验收」都不能标为通过。
自动评分、规则打分、agent 自评都不能替代它们。

## 重新生成

\`\`\`bash
node scripts/gen-tester-package.mjs
\`\`\`

案例来自 \`scripts/quality-corpus-materials.json\`（由 \`test/gui/quality-cases.ts\` 生成），
不要在测试包里手改案例 —— 那会让评审样本与采集器样本分叉。
`

writeFileSync(join(outDir, 'README.md'), readme, 'utf8')
writeFileSync(join(outDir, '01-install.md'), install, 'utf8')
writeFileSync(join(outDir, '02-cases.md'), cases, 'utf8')
writeFileSync(join(outDir, '03-scoring-sheet.csv'), sheet, 'utf8')
writeFileSync(join(outDir, '04-feedback-form.md'), feedback, 'utf8')
writeFileSync(join(outDir, '05-organizer-checklist.md'), checklist, 'utf8')

console.log(`已生成 ${outDir}`)
console.log(`  案例 ${caseRows.length} 条；评分表 ${rows.length} 行`)
