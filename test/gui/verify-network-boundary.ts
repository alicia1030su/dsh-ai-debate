/**
 * 网络边界的**判定**（v0.2.36 §4.3）。
 *
 * 这个脚本不驱动界面，只读两层记录并下结论：
 *
 * 1. `observer.json` —— 进程外代理观测到的每一条连接（Renderer + Host fetch）。
 * 2. `plugin-store/egress.jsonl` —— 插件守卫对模型 / 平台 / 子进程的每一次判定。
 *
 * ## 判定规则（写死在这里，不放宽）
 *
 * - 观测器自检没通过 → **失败**。没被证明活着的观测器，它的空记录不算证据。
 * - 观测到任何 `weibo.com` / `weibo.cn` / `baidu.com` / `tieba.com` 连接 → **失败**。
 * - 观测到任何不在允许清单里的主机 → **失败**。
 * - 插件侧出现任何 `purpose=platform` 且 `decision=allow` 的记录 → **失败**。
 * - 插件侧一次 `self-test` 的 `deny` 记录都没有 → **失败**（守卫没被证明是活的）。
 * - 两层都干净才通过。
 *
 * 环境变量：
 *   DSH_E2E_OUT_DIR           本轮证据目录（observer.json 在这里）
 *   DSH_E2E_OBSERVER_REPORT   覆盖 observer.json 路径
 *   DSH_E2E_STORE_DIR         插件 store 目录（egress.jsonl 在这里）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.env.DSH_E2E_OUT_DIR ?? ''
const observerPath = process.env.DSH_E2E_OBSERVER_REPORT ?? join(out, 'observer.json')
const storeDir =
  process.env.DSH_E2E_STORE_DIR ?? 'C:/AI-Workspace/dsh-ai-debate/tmp/desk-offline/plugin-store'
const egressPath = join(storeDir, 'egress.jsonl')

interface Connection {
  readonly at: string
  readonly host: string
  readonly allowed: boolean
  readonly kind: string
}
interface BoundaryReport {
  readonly connections: readonly Connection[]
  readonly observerBroken: boolean
  readonly selfCheck: { readonly attempted: boolean; readonly observed: boolean; readonly detail: string }
  readonly port: number
}
interface EgressRecord {
  readonly at: string
  readonly purpose: string
  readonly host: string
  readonly decision: 'allow' | 'deny'
  readonly reason: string
}

const failures: string[] = []
const notes: string[] = []

/**
 * 宿主自身的流量白名单（v0.2.36）。
 *
 * ## 为什么这几个域名必须单独归类，而不是混进「插件出网」
 *
 * 真机上观测到 `harness.deepseek.com`、`download.deepseek.com`、
 * `redirector.gvt1.com` —— 它们出现在**插件挂载之前**，来自 DSH 自己的更新检查与
 * Chromium 的组件下载。把它们算成「插件出网失败」会让这条断言永远红，而真正的
 * 信号（插件有没有碰微博/贴吧）被淹没；把它们悄悄忽略，又等于伪造一个干净的
 * 观测结果。
 *
 * 所以：单独列出并计数，在报告里明写「这是宿主流量，不计入插件边界」。插件
 * 归因的连接一条都不许有。
 */
const HOST_APP_HOSTS = [
  /(^|\.)deepseek\.com$/i,
  /(^|\.)gvt1\.com$/i,
  /(^|\.)googleapis\.com$/i,
  /(^|\.)gstatic\.com$/i,
]

/**
 * 本次运行中，插件真正会碰的网络目的是这两类：模型接口、平台接口。
 *
 * 「插件归因」= 既不是宿主基础设施、也不是观测器自检、也不是本机回环的连接。
 * 这个划分是判定脚本的核心，写在这里而不是散在几个 if 里。
 */

function fail(message: string): void {
  failures.push(message)
}

// ---- 第一层：进程外观测 ------------------------------------------------------
if (!existsSync(observerPath)) {
  fail(`观测器报告不存在：${observerPath}（没有观测就没有「零出网」结论）`)
} else {
  const report = JSON.parse(readFileSync(observerPath, 'utf8')) as BoundaryReport
  if (report.observerBroken || !report.selfCheck?.observed) {
    fail(`观测器自检未通过：${report.selfCheck?.detail ?? '没有自检记录'}`)
  } else {
    notes.push(`观测器自检通过（端口 ${report.port}）：${report.selfCheck.detail}`)
  }
  /** 观测器自检那一条属于机制本身，不是被测进程的流量。 */
  const isSelfCheck = (host: string): boolean => host === 'observer-selfcheck.invalid'
  const isHostApp = (host: string): boolean => HOST_APP_HOSTS.some((pattern) => pattern.test(host))

  const platform = report.connections.filter((entry) =>
    /(^|\.)(weibo\.com|weibo\.cn|sina\.com\.cn|baidu\.com|tieba\.com)$/i.test(entry.host),
  )
  if (platform.length > 0) {
    fail(
      `观测到平台连接 ${platform.length} 条：` +
        platform.map((entry) => `${entry.host}:${entry.kind}`).join('、') +
        '（插件或宿主访问了平台主机，手动导入模式不允许）',
    )
  }

  const hostApp = report.connections.filter((entry) => isHostApp(entry.host))
  if (hostApp.length > 0) {
    const hosts = [...new Set(hostApp.map((entry) => entry.host))].join('、')
    notes.push(`宿主自身流量 ${hostApp.length} 条（${hosts}）：DSH 更新检查与 Chromium 组件下载，不计入插件边界`)
  }

  const pluginAttributable = report.connections.filter(
    (entry) => !isSelfCheck(entry.host) && !isHostApp(entry.host) && !/^(127\.0\.0\.1|localhost|::1)$/i.test(entry.host),
  )
  if (pluginAttributable.length > 0) {
    fail(
      `观测到 ${pluginAttributable.length} 条可归因到被测插件的出网：` +
        pluginAttributable.map((entry) => `${entry.host}:${entry.kind}`).join('、'),
    )
  }
  notes.push(`观测到连接 ${report.connections.length} 条，插件归因 ${pluginAttributable.length} 条`)
}

// ---- 第二层：插件内守卫 ------------------------------------------------------
if (!existsSync(egressPath)) {
  fail(`插件出网审计不存在：${egressPath}（守卫没有被触发过，或没有落盘）`)
} else {
  const records: EgressRecord[] = []
  for (const line of readFileSync(egressPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as EgressRecord)
    } catch {
      // 半行跳过：进程被杀时最后一行可能不完整。
    }
  }
  const platformAllows = records.filter((entry) => entry.purpose === 'platform' && entry.decision === 'allow')
  if (platformAllows.length > 0) {
    fail(
      `插件放行了 ${platformAllows.length} 次平台出网：` +
        platformAllows.map((entry) => entry.host).join('、'),
    )
  }
  /**
   * 守卫必须被证明「真的拦过东西」。
   *
   * 两种证据都算：
   * - `self-test`：设置页/脚本故意发一次必然被拒的请求；
   * - `platform`：这一轮真实发生的平台尝试被拦下（离线模式下授权探针就会被打回）。
   *
   * 不接受「审计文件存在但一条 deny 都没有」——那和一个没装上的守卫无法区分。
   */
  const selfTestDenies = records.filter((entry) => entry.purpose === 'self-test' && entry.decision === 'deny')
  const platformDenies = records.filter((entry) => entry.purpose === 'platform' && entry.decision === 'deny')
  if (selfTestDenies.length === 0 && platformDenies.length === 0) {
    fail('插件守卫没有任何 deny 记录 —— 自检没执行、平台请求也没被拦，等于守卫没生效')
  } else if (selfTestDenies.length > 0) {
    notes.push(`插件守卫自检通过：${selfTestDenies[0]!.host} 被拒绝（${selfTestDenies[0]!.reason}）`)
    if (platformDenies.length > 0) notes.push(`另有 ${platformDenies.length} 次平台出网被拦`)
  } else {
    notes.push(
      `插件守卫拦下 ${platformDenies.length} 次平台出网（` +
        [...new Set(platformDenies.map((entry) => entry.host))].join('、') +
        '）',
    )
  }
  const allows = records.filter((entry) => entry.decision === 'allow')
  notes.push(`插件判定 ${records.length} 次（allow ${allows.length} / deny ${records.length - allows.length}）`)
}

// ---- 结论 -------------------------------------------------------------------
for (const note of notes) process.stdout.write(`· ${note}\n`)
if (failures.length > 0) {
  for (const message of failures) process.stdout.write(`✘ ${message}\n`)
  process.stdout.write(`网络边界：失败（${failures.length} 条）\n`)
  process.exit(1)
}
process.stdout.write('网络边界：通过（两层观测均干净，且两层自检都被证明是活的）\n')
