/**
 * 准备一个隔离的 Desktop profile（v0.2.36）。
 *
 * ## 为什么要有这个脚本，而不是在 shell 里内联 `node -e`
 *
 * v0.2.36 第一次跑边界验收时，`storeDir` 的替换**没有生效**，于是：
 *
 * - 插件写的是 `tmp/desk-import/plugin-store`（上一轮离线导入的 store），
 * - 那一轮跑起来直接读到了**上一轮的会话**，空状态断言当然不成立；
 * - 审计文件也落在那边，边界判定去新目录找，报「审计不存在」。
 *
 * 三条红，没有一条是产品问题。内联 `node -e` 里嵌套引号与正则转义是这次事故的
 * 直接原因 —— 把配置改写放进一个有测试、能单独运行的文件，比在一个 200 行的
 * shell 里玩转义可靠得多。
 *
 * ## 它改什么
 *
 * 1. `storeDir` —— **必须**指向本环境自己的目录。跨环境共用 store 会让一轮验收
 *    读到另一轮的会话，而那种错误的形状是「功能好像不对」。
 * 2. `egressMode` —— 本轮要验证的边界模式。
 * 3. 模型地址与模型名 —— 指向本机假模型（回环，属于明确允许的那一类）。
 *
 * 不改凭据：隔离环境里不该有任何真实 Cookie / API Key，脚本也不会读它们。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const profileDir = process.argv[2]
const storeDir = process.argv[3]
const egressMode = process.argv[4] ?? 'offline'

if (profileDir === undefined || storeDir === undefined) {
  process.stderr.write('用法：node scripts/prepare-desktop-profile.mjs <profileDir> <storeDir> [egressMode]\n')
  process.exit(2)
}

const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  process.stderr.write(`找不到 ${patchPath}\n`)
  process.exit(2)
}

let text = readFileSync(patchPath, 'utf8')

/**
 * 逐键改写，而不是整行正则。
 *
 * `storeDir: .*` 这种写法在路径里带盘符与反斜杠时很容易只匹配到一半；
 * 按「行首缩进 + 键名」定位，替换整行，才是不会漏的写法。
 */
/**
 * 逐键改写，而不是整行正则。
 */
function setKey(source, key, value) {
  const pattern = new RegExp(`^(\\s*)${key}:.*$`, 'm')
  if (pattern.test(source)) return source.replace(pattern, `$1${key}: ${value}`)
  // 没有这个键：插到 `config:` 段里第一行之前。
  return source.replace(/^(\s*)config:\s*$/m, `$1config:\n$1  ${key}: ${value}`)
}

text = setKey(text, 'storeDir', storeDir.replace(/\\/g, '/'))
text = setKey(text, 'egressMode', egressMode)
// 假模型：本机回环。真实凭据不该出现在隔离环境里。
text = setKey(text, 'llmBaseUrl', 'http://127.0.0.1:58999/v1')
text = setKey(text, 'llmModel', 'mock-model')

writeFileSync(patchPath, text, 'utf8')

// 读回来验一遍：写没写进去，不能靠「我以为写了」。
const after = readFileSync(patchPath, 'utf8')
const problems = []
for (const [key, expected] of [
  ['storeDir', storeDir.replace(/\\/g, '/')],
  ['egressMode', egressMode],
]) {
  const line = after.split('\n').find((entry) => new RegExp(`^\\s*${key}:`).test(entry))
  if (line === undefined || !line.includes(expected)) {
    problems.push(`${key} 没写进去（实际：${line ?? '缺这一行'}）`)
  }
}
if (problems.length > 0) {
  process.stderr.write(`profile 配置校验失败：\n- ${problems.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write(`profile 已就绪：storeDir=${storeDir} egressMode=${egressMode}\n`)
