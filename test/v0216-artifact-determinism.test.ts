/**
 * v0.2.16 §6 —— 安装包的字节必须只由内容决定，不能带上构建机器的指纹。
 *
 * 真实回归：v0.2.16 的 Release 在 Linux runner 上打包并发布了
 * `dsh-ai-debate-0.2.16.tgz`，sha256 `ac7200c3…`；同一份源码在本机（Windows）
 * 重建出来是 `77234900…`。长度一模一样，只有 1 个字节不同：gzip 头的第 9 个字节，
 * 也就是 zlib 填进去的 OS 字段（Linux 写 0x03，Windows 写 0x0a）。
 *
 * 后果不是「难看的差异」，而是发布说明里印出来的校验和在任何非 Linux 机器上都对不上——
 * 而本项目恰恰是在 Windows 上开发的，用户按 README 自己重建时只会以为下载坏了。
 * mtime 早就固定成 0 了，OS 这一个字节被漏掉。
 *
 * 另一个同源问题：工作区里 `scripts/configure-stage.mjs` 与 `test/target.test.ts`
 * 结尾多了一个 CR（CRLF 而仓库里是 LF），导致本地源码包比 GitHub 上的大 5 字节。
 * 那条也一并在这里钉住：归档的字节必须能由仓库内容一一复算。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTgz } from '../scripts/tar.mjs'

const ROOT = join(import.meta.dirname, '..')

function readRepoFile(rel) {
  return readFileSync(join(ROOT, rel))
}

test('gzip 头把 OS 字节固定成 255，不暴露构建机器的平台', () => {
  const tgz = createTgz([{ path: 'a.txt', data: Buffer.from('hello\n') }])

  assert.equal(tgz[0], 0x1f, 'gzip magic 第一字节')
  assert.equal(tgz[1], 0x8b, 'gzip magic 第二字节')
  assert.equal(tgz[2], 0x08, '压缩方法必须是 deflate')
  assert.equal(tgz[3], 0x00, 'FLG 必须为 0：不能有 FNAME/FEXTRA，否则 OS 不在第 10 字节')

  assert.equal(tgz[9], 255, 'OS 字节必须是 255（unknown），不能是 0x03/0x0a/0x13')

  // mtime 固定为 0 是老约定，一并守住，否则「同一份源码两次打包字节相同」也会破。
  assert.equal(tgz.readUInt32LE(4), 0, 'gzip mtime 必须为 0')
})

test('相同内容两次打包字节完全相同', () => {
  const entries = [
    { path: 'package/a.txt', data: Buffer.from('one\n') },
    { path: 'package/b/c.txt', data: Buffer.from('two\n') },
  ]

  const first = createTgz(entries)
  const second = createTgz(entries)

  assert.equal(first.equals(second), true, '同一份输入必须产出同一串字节')
})

test('内容变一个字节，产物就必须变', () => {
  const a = createTgz([{ path: 'package/a.txt', data: Buffer.from('one\n') }])
  const b = createTgz([{ path: 'package/a.txt', data: Buffer.from('one!\n') }])

  assert.notEqual(a.toString('hex'), b.toString('hex'), '打包不能把内容差异吃掉')
})

test('tar.mjs 不再直接返回 gzipSync 的结果', () => {
  // 这条是为了让「有人把 createTgz 改回一行 gzipSync」立刻变红。
  // 字节层面的断言在别的机器上也能过（因为 zlib 恰好写 255），所以还要看源码意图。
  const source = readFileSync(join(ROOT, 'scripts', 'tar.mjs'), 'utf8')

  assert.match(source, /gz\[9\]\s*=\s*255/, 'createTgz 必须显式固定 OS 字节')
  assert.doesNotMatch(
    source,
    /export function createTgz\(entries\)\s*\{\s*return gzipSync\(/,
    'createTgz 不能直接返回 gzipSync 的结果',
  )
})

test('归档里的文本文件不携带多余的 CR（行尾统一 LF）', () => {
  // Windows 上的编辑器很容易把最后一行写成 CRLF，而仓库里是 LF。
  // 一个字节的差异就让本地源码包与 GitHub 产物对不上，排查起来极费时间。
  for (const rel of ['scripts/configure-stage.mjs', 'test/target.test.ts', 'scripts/tar.mjs']) {
    const bytes = readRepoFile(rel)
    const strayCr = bytes.indexOf(Buffer.from([0x0d, 0x0a]))
    assert.equal(strayCr, -1, `${rel} 里出现了 CRLF，仓库约定是 LF`)
  }
})
