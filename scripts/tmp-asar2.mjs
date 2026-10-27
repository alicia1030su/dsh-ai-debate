import { readFileSync } from 'node:fs'
const ASAR = 'E:\\deepseek\\resources\\app.asar'
const buf = readFileSync(ASAR)
const headerBlockSize = buf.readUInt32LE(4)
const headerSize = buf.readUInt32LE(8)
const dataStart = 8 + headerBlockSize
const json = buf.subarray(16, 8 + headerSize).toString('utf8')
const tree = JSON.parse(json)
// walk to find connection host lib
const hits = []
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix + '/' + name
    if (child.files) walk(child, p)
    else if (/client-connection/.test(p) && /\.js$/.test(p) && /lib\//.test(p)) hits.push({ p, size: child.size })
  }
}
walk(tree, '')
for (const h of hits) console.log(h.size, h.p)
console.log('dataStart', dataStart)
