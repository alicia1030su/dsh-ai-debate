/**
 * 从 Git 对象库读「已提交的那一份」字节。
 *
 * ## 为什么需要一个独立模块（v0.2.39 §5）
 *
 * `source-zip.mjs` 一直是「先 `git ls-files` 拿到清单，再 `readFile` 读工作树」。前半段读的是
 * 提交，后半段读的是磁盘 —— 两半混用，于是同一个提交在两台机器上可以打出不同的字节：
 *
 * - v0.2.37 的 2369 字节差异就是这么来的：工作树里 20 个文本文件被工具改写成 CRLF，
 *   仓库里存的是 LF，而打包器读工作树。
 * - v0.2.38 查清了原因，但只加了「打包前发现漂移」的检查（`verify-source-archive --drift`），
 *   根因还在：只要有人忘了跑那个检查、或者顺手在脏工作树上打包，出去的包就不是那个提交。
 *
 * 现在读的是 `git cat-file --batch` 的输出。**归档的字节只由提交决定，与磁盘上的状态无关。**
 * 于是「工作树是不是干净的」不再影响发布产物，`--drift` 也从「打包前必须做的检查」降级成
 * 「给你自己看的信息」。
 *
 * ## 为什么不直接 `git show HEAD:path`
 *
 * 一个包里有几百个文件，每次都 fork 一个 git 是几百次进程启动（Windows 上尤其慢）。
 * `git cat-file --batch` 在**一个进程**里连续回答多个 `<rev>:<path>`，输出是
 * `<sha> <type> <size>\n<content>\n`。代价是要自己解析这个流，而流里的 `size` 是**字节数**——
 * 按字符串截断会切坏 UTF-8 中文，所以下面按 Buffer 偏移切。
 */

import { execFileSync } from 'node:child_process'

/** 一个 blob 的真实字节。`sha` 是它在对象库里的地址，用来写清单。 */
export function readBlobs(root, rev, paths) {
  if (paths.length === 0) return new Map()

  const input = paths.map((path) => `${rev}:${path}`).join('\n') + '\n'
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const blobs = new Map()
  let offset = 0
  for (const path of paths) {
    // `<sha> <type> <size>` 后面跟一个换行，然后是 size 字节内容，再一个换行。
    const headerEnd = output.indexOf(0x0a, offset)
    if (headerEnd === -1) throw new Error(`git cat-file 的输出在 ${path} 处提前结束`)

    const header = output.subarray(offset, headerEnd).toString('utf8')
    if (header.endsWith(' missing') || header === `${rev}:${path} missing`) {
      throw new Error(`提交 ${rev} 里没有 ${path}：清单与对象库不一致`)
    }
    const parts = header.split(' ')
    if (parts.length !== 3) throw new Error(`git cat-file 的响应格式不认识：${header}`)
    const [sha, type, sizeText] = parts
    const size = Number(sizeText)
    if (type !== 'blob') throw new Error(`${path} 在提交里不是 blob（是 ${type}）`)

    const start = headerEnd + 1
    const data = Buffer.from(output.subarray(start, start + size))
    blobs.set(path, { sha, data })
    // 内容之后是一个分隔换行（batch 格式的约定）。
    offset = start + size + 1
  }

  return blobs
}
