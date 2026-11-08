/**
 * 独立的网络边界观测器进程（v0.2.36 §4.2）。
 *
 * ## 为什么要单独一个进程
 *
 * 观测器必须在**被测进程启动之前**就绪：代理地址要写进被测进程的环境变量与
 * 命令行（`--proxy-server`），端口一旦定下来就不能再变。所以它不能是被测脚本
 * 里的一个函数，必须是先起来、把端口打出来、然后等着的那一个。
 *
 * ## 它记什么、不记什么
 *
 * 记：每条连接的目标主机、端口、是否被允许、为什么。
 * 不记：TLS 之后的路径（看不见）、请求头（其中可能有凭据）、正文。
 *
 * 对「有没有碰微博/贴吧」这个问题，主机名就够了。
 *
 * ## 用法
 *
 *     node --experimental-transform-types scripts/net-observer.mjs \
 *       --port 9600 --out <dir>/observer.json --allow 127.0.0.1 --allow newapi.example.com
 *
 * 起来后往 stdout 打一行 `OBSERVER-PORT=<port>`，调用方据此确认就绪。
 * 收到 SIGTERM 时写完报告再退。
 */

import { BoundaryObserver } from '../test/gui/network-observer.ts'

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const port = Number(argOf('port') ?? '0')
const out = argOf('out')
const allows = []
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--allow') {
    const value = process.argv[index + 1]
    if (value !== undefined) allows.push(value)
  }
}

const observer = new BoundaryObserver({
  allowHosts: allows,
  ...(out === undefined ? {} : { artifactPath: out }),
})

// 固定端口：代理地址要提前写给被测进程，端口不能等到分配完才知道。
// 端口被占用时直接失败，而不是退回随机端口 —— 后者会让被测进程连到一个不存在的代理。
const actualPort = await observer.startAt(port === 0 ? 9600 : port)
process.stdout.write(`OBSERVER-PORT=${actualPort}\n`)

const selfCheck = await observer.selfCheck()
process.stdout.write(`OBSERVER-SELFCHECK=${selfCheck.observed ? 'ok' : 'broken'}\n`)

let stopping = false
async function finish() {
  if (stopping) return
  stopping = true
  const report = await observer.report(selfCheck)
  process.stdout.write(
    `OBSERVER-CONNECTIONS=${report.connections.length}\n` +
      `OBSERVER-BROKEN=${report.observerBroken ? 'yes' : 'no'}\n`,
  )
  await observer.stop()
  process.exit(0)
}

process.on('SIGTERM', () => {
  void finish()
})
process.on('SIGINT', () => {
  void finish()
})
