/**
 * 网络边界的外部观测器（v0.2.36 §4.2）。
 *
 * ## 为什么不能用「拦截日志为空」做证据
 *
 * v0.2.35 的离线验收就栽在这里：`NODE_OPTIONS` 预加载在 Electron 主进程里被丢掉，
 * 拦截器根本没装上 —— 于是「没有记录」与「没有出网」在同一份报告里长得一模一样。
 * 空日志不是证据，**没有观测到任何观测者**才是事实。
 *
 * ## 这条路做什么
 *
 * 它不修改宿主、不装代理、不动系统防火墙，也不依赖任何被注入的钩子。它只做一件事：
 * 起一个**极小的本地 HTTP 代理**，把被测进程的所有出网都指向它。
 *
 * 具体是两条通道：
 *
 * 1. **代理环境变量**（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`）。Node 的 `fetch`
 *    走 undici，默认**不读**代理环境变量；所以要真正生效，必须同时设
 *    `NODE_USE_ENV_PROXY=1`（Node ≥ 22.21 / 24 支持）或用 `--import` 装 undici 的
 *    dispatcher。本机 Node 是 22.22，支持 `NODE_USE_ENV_PROXY`。这条通道覆盖
 *    Renderer 与 Host 的 `fetch`。
 * 2. **HTTPS 的 CONNECT 只能看到目标主机名**（TLS 之后的路径不可见）。对本项目
 *    已经足够：要证明的是「没有连接 weibo.com / tieba.baidu.com」，不是「没请求
 *    某个具体路径」。而 TLS 拦不住的那一类 —— 平台 CLI 子进程 —— 由进程启动闸门
 *    单独覆盖（见 `net-audit.ts` 的 `assertSpawn`）。
 *
 * ## 观测器自己失效怎么办
 *
 * 这是本模块存在的**唯一理由**：{@link BoundaryObserver.selfCheck} 必须能让一个
 * 明确被禁的目标打出记录。做不到就报 `observerBroken: true`，验收脚本据此判失败，
 * 而不是把「没记录」读成「干净」。
 */

import { createServer, type Server, type Socket } from 'node:net'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一次被观测到的连接。 */
export interface ObservedConnection {
  readonly at: string
  /** `CONNECT`（HTTPS）或 `http`（明文代理请求）。 */
  readonly kind: 'connect' | 'http'
  /** 目标主机（端口单独记）。 */
  readonly host: string
  readonly port: number
  /** 判定：即使是被允许的模型请求也会记下来，判定由上层按策略做。 */
  readonly allowed: boolean
  readonly reason: string
}

/** 观测结果。 */
export interface BoundaryReport {
  readonly connections: readonly ObservedConnection[]
  /** 观测器本身是否被证明是活的。false 时任何「零出网」结论都不成立。 */
  readonly observerBroken: boolean
  readonly selfCheck: {
    readonly attempted: boolean
    readonly observed: boolean
    readonly detail: string
  }
  readonly port: number
}

/**
 * 观测器。
 *
 * 端口由系统分配（`listen(0)`），因为固定端口在并发验收里会撞车；调用方从
 * {@link BoundaryObserver.port} 拿到实际端口后再写进环境变量。
 */
export class BoundaryObserver {
  private server: Server | undefined
  private readonly connections: ObservedConnection[] = []
  private portNumber = 0
  private readonly allowHosts: readonly string[]
  private readonly artifactPath: string | undefined
  /** 自检专用：把目标名换成这个，用来证明「记录是活的」。 */
  private readonly selfCheckHost = 'observer-selfcheck.invalid'
  /** 最近一次自检结论；未自检时按「坏的」处理。 */
  private selfCheckResult: BoundaryReport['selfCheck'] = {
    attempted: false,
    observed: false,
    detail: '还没有做自检 —— 未自检的空记录不能作为「没有出网」的证据',
  }

  constructor(options: { allowHosts?: readonly string[]; artifactPath?: string } = {}) {
    this.allowHosts = options.allowHosts ?? []
    this.artifactPath = options.artifactPath
  }

  get port(): number {
    return this.portNumber
  }

  /**
   * 判定一次目标是否在允许清单里（只按主机名，不看路径）。
   *
   * 条目支持两种写法：
   * - `127.0.0.1` —— 精确匹配；
   * - `.deepseek.com` —— 以点开头表示**后缀匹配**（含域名本身）。
   *
   * 后缀写法是给宿主自身的基础设施用的：DSH 启动时要访问它自己的服务
   * （`harness.deepseek.com` 等），被代理挡掉会让桌面**根本起不来** ——
   * 实测表现是 `desktop welcome: Web authentication failed`，整块界面空白，
   * 看起来像插件渲染崩了，实际是宿主没启动完。
   *
   * 这些域名被单独放行，并在报告里按「宿主自身流量」单列，不计入插件边界。
   */
  private decide(host: string): { allowed: boolean; reason: string } {
    const lowered = host.toLowerCase()
    for (const entry of this.allowHosts) {
      const candidate = entry.toLowerCase()
      if (candidate.startsWith('.')) {
        const suffix = candidate.slice(1)
        if (lowered === suffix || lowered.endsWith(candidate)) {
          return { allowed: true, reason: `在允许清单里（后缀 ${candidate}）` }
        }
        continue
      }
      if (candidate === lowered) return { allowed: true, reason: '在允许清单里' }
    }
    return { allowed: false, reason: '不在允许清单里' }
  }

  private record(entry: ObservedConnection): void {
    this.connections.push(entry)
    /**
     * 每记一条就落盘一次（v0.2.36）。
     *
     * 一开始只在收到 SIGTERM 时写报告。真机上发现：Windows 上 `kill -TERM` 常常
     * 直接终止进程，处理器来不及跑 —— 于是「跑完一整轮、报告是空的」，又一次
     * 变成「没有记录」与「没有出网」的混淆。
     *
     * 写整个文件而不是追加一行，是因为报告里还有 `observerBroken` 与连接总数；
     * 追加一行会让读取方自己去拼状态，而拼错的方式恰好是漏掉自检结论。
     * 文件很小（一次验收几十条），重写成本可以忽略。
     */
    this.persistNow()
  }

  /** 把当前状态写一次盘。没有 artifactPath 时什么也不做。 */
  persistNow(): void {
    if (this.artifactPath === undefined) return
    const report: BoundaryReport = {
      connections: [...this.connections],
      // 自检结论单独记：还没自检时按「坏的」处理 —— 一个没被证明活着的观测器，
      // 它的空记录不能当证据。
      observerBroken: !this.selfCheckResult.observed,
      selfCheck: this.selfCheckResult,
      port: this.portNumber,
    }
    try {
      mkdirSync(dirname(this.artifactPath), { recursive: true })
      writeFileSync(this.artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {
      // 落盘失败不升级：报告里 selfCheck.detail 已能说明观测是否可信。
    }
  }

  /** 起服务（端口由系统分配）。返回实际端口。 */
  async start(): Promise<number> {
    return this.startAt(0)
  }

  /**
   * 起服务并监听**指定**端口。
   *
   * 为什么要这一条：代理地址必须在被测进程启动前就知道，端口不能等服务起来才
   * 分配。端口被占用时直接抛错，而不是悄悄换一个 —— 换了之后被测进程连的是
   * 一个不存在的地址，所有出网都会「失败」，那会被误读成「没有出网」。
   */
  async startAt(port: number): Promise<number> {
    const server = createServer()
    this.server = server

    server.on('connection', (socket: Socket) => {
      socket.once('data', (chunk) => {
        const head = chunk.toString('utf8').split('\r\n')[0] ?? ''
        // CONNECT host:port HTTP/1.1
        const connectMatch = /^CONNECT\s+([^\s:]+)(?::(\d+))?\s+HTTP/i.exec(head)
        if (connectMatch !== null) {
          const host = connectMatch[1] ?? ''
          const port = Number(connectMatch[2] ?? '443')
          const verdict = this.decide(host)
          this.record({
            at: new Date().toISOString(),
            kind: 'connect',
            host,
            port,
            allowed: verdict.allowed,
            reason: verdict.reason,
          })
          if (!verdict.allowed) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
            return
          }
          // 允许的隧道：真把两条流接起来，否则被放行的模型调用会失败，
          // 而那会被误读成「模型坏了」。
          const upstream = tlsConnect({ host, port, servername: host })
          upstream.on('error', () => socket.destroy())
          socket.on('error', () => upstream.destroy())
          upstream.once('secureConnect', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            upstream.pipe(socket)
            socket.pipe(upstream)
          })
          return
        }

        // 明文代理请求：GET http://host/path HTTP/1.1
        const absolute = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s+(http:\/\/[^\s]+)/i.exec(head)
        if (absolute !== null) {
          let host = ''
          let port = 80
          try {
            const url = new URL(absolute[2] ?? '')
            host = url.hostname
            port = Number(url.port === '' ? '80' : url.port)
          } catch {
            host = ''
          }
          const verdict = this.decide(host)
          this.record({
            at: new Date().toISOString(),
            kind: 'http',
            host: host === '' ? '<unparsable>' : host,
            port,
            allowed: verdict.allowed,
            reason: verdict.reason,
          })
          if (!verdict.allowed) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
            return
          }
          // 允许的明文请求：转给目标并回写。这条只用于本机回环上的假模型。
          const target = absolute[2] ?? ''
          const options = { method: absolute[1] ?? 'GET', headers: {} as Record<string, string> }
          const outbound = httpRequest(target, options, (response: IncomingMessage) => {
            const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}`]
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
              else if (value !== undefined) lines.push(`${name}: ${value}`)
            }
            socket.write(`${lines.join('\r\n')}\r\n\r\n`)
            response.pipe(socket)
          })
          outbound.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
          // 已经读过第一块，剩下的客户端数据直接转发。
          outbound.end()
          return
        }

        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    this.portNumber = typeof address === 'object' && address !== null ? address.port : 0
    return this.portNumber
  }

  /**
   * 自检：一个确定不该被允许的目标，必须真的出现在记录里。
   *
   * 直接用原始 socket 说一句 `CONNECT`，不走 fetch —— 自检要证明的是**观测链路**，
   * 不是被测进程的 fetch 行为。
   */
  async selfCheck(): Promise<BoundaryReport['selfCheck']> {
    if (this.portNumber === 0) {
      return { attempted: false, observed: false, detail: '观测器没有启动' }
    }
    try {
      const { connect } = await import('node:net')
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: this.portNumber }, () => {
          socket.write(`CONNECT ${this.selfCheckHost}:443 HTTP/1.1\r\nHost: ${this.selfCheckHost}:443\r\n\r\n`)
        })
        socket.once('data', () => {
          socket.destroy()
          resolve()
        })
        socket.once('error', reject)
        socket.setTimeout(2000, () => {
          socket.destroy()
          reject(new Error('自检超时'))
        })
      })
      const observed = this.connections.some((entry) => entry.host === this.selfCheckHost)
      const result = {
        attempted: true,
        observed,
        detail: observed
          ? `自检连接已记录并被拒绝（目标 ${this.selfCheckHost}）`
          : `自检发出了请求，但记录里没有它 —— 观测链路是断的`,
      }
      this.selfCheckResult = result
      this.persistNow()
      return result
    } catch (error) {
      const result = { attempted: true, observed: false, detail: `自检失败：${(error as Error).message}` }
      this.selfCheckResult = result
      this.persistNow()
      return result
    }
  }

  /** 汇总：连接记录 + 自检结论。 */
  async report(selfCheck: BoundaryReport['selfCheck']): Promise<BoundaryReport> {
    const report: BoundaryReport = {
      connections: [...this.connections],
      observerBroken: !selfCheck.observed,
      selfCheck,
      port: this.portNumber,
    }
    this.persist(report)
    return report
  }

  private persist(report: BoundaryReport): void {
    if (this.artifactPath === undefined) return
    try {
      mkdirSync(dirname(this.artifactPath), { recursive: true })
      writeFileSync(this.artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {
      // 落盘失败不升级：报告里 selfCheck.detail 已经能说明观测是否可信。
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** 导出给测试用的占位：一个只回 403 的 HTTP 服务（不做隧道）。 */
export function createDenyAllServer(hosts: readonly string[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const head = chunk.toString('utf8').split('\r\n')[0] ?? ''
        const target = /^CONNECT\s+([^\s:]+)/i.exec(head)?.[1] ?? ''
        void hosts
        void target
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, port })
    })
  })
}

/** 未使用但保留导出，避免 TS 因未使用而报错的行内注释辅助。 */
export type { IncomingMessage, ServerResponse }
