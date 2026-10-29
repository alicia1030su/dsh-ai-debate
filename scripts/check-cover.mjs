/**
 * 封面替换后的引用与资源检查。
 *
 * 读的是磁盘上的真实文件，不是我对它的记忆：README 引用的每个 `src` 都要存在，
 * 旧封面不能以别的名字留在仓库里冒充「还有一份」，而新图的字节必须与归档一致。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const readme = readFileSync('README.md', 'utf8')

console.log('=== README 图片引用 ===')
for (const match of readme.matchAll(/src="([^"]+)"/g)) {
  const ref = match[1]
  console.log(` ${ref} -> ${existsSync(ref) ? 'EXISTS' : 'MISSING'}`)
}

console.log('\n=== README 封面属性 ===')
console.log(' width="420":     ', readme.includes('width="420"'))
console.log(' width="100%":     ', readme.includes('width="100%"'))
console.log(' <p align="center">:', readme.includes('<p align="center">'))
console.log(' 临时附件 URL:     ', /\.dsh\/attachments|v1\/objects/.test(readme))
console.log(' Base64 内嵌:      ', /data:image/.test(readme))

console.log('\n=== 仓库里的图片资源 ===')
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) out.push(full)
  }
  return out
}
const images = walk('.').filter((path) => !path.includes('node_modules'))
for (const path of images) {
  console.log(` ${path}  ${statSync(path).size} bytes  ${sha(path).slice(0, 16)}`)
}
console.log(` 共 ${images.length} 个图片文件`)

console.log('\n=== 封面本体 ===')
const cover = 'docs/images/ai-debate-cover.png'
const buf = readFileSync(cover)
console.log(' 路径:      ', cover)
console.log(' 字节:      ', buf.length)
console.log(' 尺寸:      ', `${buf.readUInt32BE(16)} x ${buf.readUInt32BE(20)}`)
console.log(' 格式:      ', buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'PNG' : '(非 PNG)')
console.log(' 色彩类型:  ', buf[25] === 2 ? '2 (RGB)' : buf[25] === 6 ? '6 (RGBA)' : `${buf[25]}`)
console.log(' SHA-256:   ', sha(cover))
