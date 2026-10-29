/**
 * 交付收尾：算产物哈希，写 SHA256SUMS.txt。
 *
 * ## 为什么报告里一个哈希都不写（v0.2.8 起）
 *
 * 报告本身在两个归档**里面**。把一个归档的哈希（甚至只是字节数）写进归档里的文件，
 * 就让归档依赖自己的摘要 —— 我在 v0.2.8 连续试了三次（先写 zip 体积、再写 tgz 哈希），
 * 每次都是「写完哈希，哈希就变了」。
 *
 * 结论很简单：自指的事实不能记在它描述的东西里。所以哈希只出现在 `SHA256SUMS.txt`，
 * 它在两个归档封存之后生成，且在源码树之外。
 *
 * ## 为什么版本号从 package.json 读
 *
 * 上一个版本这里写死了 `0.2.8`，升级时漏改就会拿旧产物的哈希去配新版本号 —— 一个
 * 只会在发布之后才被发现的错误。读 manifest 让版本只有一个来源。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = process.cwd()
const workspace = join(root, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

const tgz = join(root, `dsh-ai-debate-${version}.tgz`)
const zip = join(workspace, `dsh-ai-debate-source-${version}.zip`)

for (const path of [tgz, zip]) {
  if (!existsSync(path)) throw new Error(`缺少产物：${path}`)
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const lines = [
  `# AI代吵架 v${version} 交付校验和`,
  '#',
  '# 本文件是权威校验和；归档无法包含自身的哈希，所以报告里只引用这里。',
  '',
  `${sha(tgz)}  ${basename(tgz)}        (${statSync(tgz).size} 字节)`,
  `${sha(zip)}  ${basename(zip)} (${statSync(zip).size} 字节)`,
  '',
].join('\n')

writeFileSync(join(root, 'SHA256SUMS.txt'), lines, 'utf8')
process.stdout.write(lines)
