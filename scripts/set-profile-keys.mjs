/**
 * 按 `key=value` 改写隔离 profile 的插件配置（v0.2.36）。
 *
 * ## 为什么单独一个文件
 *
 * 在 shell 里内联 `node -e` 改 YAML，转义会出错而且**不会报错**。v0.2.36 两次
 * 验收假红都出在这：一次是 `storeDir` 没替换掉（读到另一轮的会话），一次是
 * `llmSource` 没写进去（脚本按连接假模型在跑，却以为在用宿主模型）。
 *
 * 两次的共同点是「脚本以为改了，实际没改，而且没人检查」。所以这里有两条硬规则：
 *
 * 1. 只改**已存在**的键，改完读回来逐条比对；
 * 2. 任何一条没生效就退出码非 0，让外层的 `|| exit` 真的拦住。
 *
 * 用法：
 *     node scripts/set-profile-keys.mjs <profileDir> key=value [key=value ...]
 *
 * `value` 为空串时写成 `""`（YAML 的空字符串，不是 null）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const profileDir = process.argv[2]
const assignments = process.argv.slice(3)
if (profileDir === undefined || assignments.length === 0) {
  process.stderr.write('用法：node scripts/set-profile-keys.mjs <profileDir> key=value [...]\n')
  process.exit(2)
}

const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  process.stderr.write(`找不到 ${patchPath}\n`)
  process.exit(2)
}

let text = readFileSync(patchPath, 'utf8')
const wanted = new Map()
for (const assignment of assignments) {
  const eq = assignment.indexOf('=')
  if (eq <= 0) {
    process.stderr.write(`参数不是 key=value：${assignment}\n`)
    process.exit(2)
  }
  wanted.set(assignment.slice(0, eq), assignment.slice(eq + 1))
}

const problems = []
for (const [key, value] of wanted) {
  const rendered = value === '' ? '""' : value
  const line = new RegExp(`^(\\s*)${key}:.*$`, 'm')
  if (!line.test(text)) {
    /**
     * 键不存在时插到 `llmModel:` 之后。
     *
     * 为什么允许插入：`llmSource` 是 v0.2.36 新加的字段，而隔离 profile 是从
     * 上一版复制来的 —— 要求「只改已存在的键」会让新字段永远写不进去，而失败
     * 方式恰好是静默的（脚本继续跑，按旧模式工作）。
     *
     * 插入位置选在 `llmModel` 之后而不是文件末尾：它是同一段配置里的相邻项，
     * 插到别的段落会挂到错误的插件上。
     */
    const anchor = new RegExp(`^(\\s*)llmModel:.*$`, 'm')
    if (!anchor.test(text)) {
      problems.push(`${key}：不存在，且找不到可用的插入锚点（llmModel）`)
      continue
    }
    text = text.replace(anchor, (matched, indent) => `${matched}\n${indent}${key}: ${rendered}`)
    continue
  }
  text = text.replace(line, `$1${key}: ${rendered}`)
}

writeFileSync(patchPath, text, 'utf8')

// 读回来逐条比对。写没写进去，不能靠「我以为写了」。
const after = readFileSync(patchPath, 'utf8')
for (const [key, value] of wanted) {
  const rendered = value === '' ? '""' : value
  const found = after.split('\n').find((entry) => new RegExp(`^\\s*${key}:`).test(entry))
  if (found === undefined || !found.includes(rendered)) {
    problems.push(`${key}：期望 ${rendered}，实际 ${found ?? '缺这一行'}`)
  }
}

if (problems.length > 0) {
  process.stderr.write(`profile 配置校验失败：\n- ${problems.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write(
  `已写入 ${wanted.size} 个键：${[...wanted.entries()].map(([k, v]) => `${k}=${v === '' ? '""' : v}`).join(' ')}\n`,
)
