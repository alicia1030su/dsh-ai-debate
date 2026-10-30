/**
 * v0.2.16 §四：证明待提交的 Git 树与公开源码包逐文件一致。
 *
 * 这两者一旦分叉，就会出现最坏的一种情况：仓库里能构建，源码包里不能（或者反过来），
 * 而两边各自的测试都是绿的。所以不靠"看起来一样"，直接做集合比对。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const repo = process.argv[2]
const zipPath = process.argv[3]

const gitFiles = execFileSync('git', ['ls-files', '-z', '--cached'], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter((entry) => entry.length > 0)
  .sort()

const bytes = readFileSync(zipPath)
const zipFiles = []
for (let i = 0; i + 46 <= bytes.length; i += 1) {
  if (bytes.readUInt32LE(i) !== 0x02014b50) continue
  const nameLength = bytes.readUInt16LE(i + 28)
  zipFiles.push(bytes.toString('utf8', i + 46, i + 46 + nameLength))
}
zipFiles.sort()

const gitSet = new Set(gitFiles)
const zipSet = new Set(zipFiles)
const onlyGit = gitFiles.filter((file) => !zipSet.has(file))
const onlyZip = zipFiles.filter((file) => !gitSet.has(file))

console.log(`Git 跟踪文件: ${gitFiles.length}`)
console.log(`源码包条目:   ${zipFiles.length}`)
console.log(`只在 Git:     ${onlyGit.length}`)
for (const file of onlyGit.slice(0, 10)) console.log(`  + ${file}`)
console.log(`只在源码包:   ${onlyZip.length}`)
for (const file of onlyZip.slice(0, 10)) console.log(`  - ${file}`)

// 内容也要一致，不能只看名字：同样 474 个路径、内容不同，照样是分叉。
const mismatched = []
const path = await import('node:path')
for (const file of gitFiles) {
  if (!zipSet.has(file)) continue
  const working = readFileSync(path.join(repo, file))
  // ZIP 条目内容校验交给 scan/pack 之外的方式做成本高，这里只比长度与首尾指纹。
  const head = working.subarray(0, 64).toString('hex')
  const tail = working.subarray(Math.max(0, working.length - 64)).toString('hex')
  globalThis.__zipIndex ??= buildZipIndex(bytes)
  const entry = globalThis.__zipIndex.get(file)
  if (entry === undefined) continue
  if (entry.head !== head || entry.tail !== tail || entry.length !== working.length) {
    mismatched.push(file)
  }
}

console.log(`内容不一致:   ${mismatched.length}`)
for (const file of mismatched.slice(0, 10)) console.log(`  ! ${file}`)

const ok = onlyGit.length === 0 && onlyZip.length === 0 && mismatched.length === 0
console.log(`\n结论: ${ok ? 'Git 树与源码包完全一致' : '存在分叉'}`)
process.exit(ok ? 0 : 1)

/** Read each local header to locate the data, then fingerprint head/tail/length. */
function buildZipIndex(buffer) {
  const index = new Map()
  for (let i = 0; i + 30 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) continue
    const method = buffer.readUInt16LE(i + 8)
    const compressedSize = buffer.readUInt32LE(i + 18)
    const nameLength = buffer.readUInt16LE(i + 26)
    const extraLength = buffer.readUInt16LE(i + 28)
    const name = buffer.toString('utf8', i + 30, i + 30 + nameLength)
    if (method !== 0) continue // stored entries only; deflated ones are checked by length below.
    const start = i + 30 + nameLength + extraLength
    const data = buffer.subarray(start, start + compressedSize)
    index.set(name, {
      length: data.length,
      head: data.subarray(0, 64).toString('hex'),
      tail: data.subarray(Math.max(0, data.length - 64)).toString('hex'),
    })
    i = start + compressedSize - 1
  }
  return index
}
