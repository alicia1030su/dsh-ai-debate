/**
 * 手动导入 + 真实宿主云模型的边界判定（v0.2.37 §6）。
 *
 * ## 与 `verify-network-boundary.ts` 的区别
 *
 * 那个脚本判「完全离线」：允许清单里只有回环，任何外部连接都算失败。
 * 这个判「手动导入 + 云端模型」：模型流量**合法**，平台流量**禁止**。
 *
 * 两条是不同的问题。把两者合成一个脚本，最可能的后果是把模型流量当成违规报红
 * （那样用户会去关掉模型），或者把平台流量当成模型流量放过（那样边界就没意义）。
 *
 * ## 四类流量分开判
 *
 * | 类别 | 判据 | 结论 |
 * | --- | --- | --- |
 * | 模型（仅本机回环） | 观测器 host 是回环 | 允许 |
 * | 模型（云端） | 观测器 host 在允许清单（`.deepseek.com` 等） | 允许，单列计数 |
 * | 平台 | weibo / baidu / tieba | **必须为 0** |
 * | 宿主自身 | 更新检查、Chromium 组件 | 允许，单列计数，不计入插件边界 |
 * | 无法归因 | 其余一切 | **必须为 0** |
 *
 * 前两类与「平台」由插件审计（egress.jsonl）再验一次：插件的**意图**必须与
 * 实际连接一致 —— 只有实际连接干净、而插件自己认为放行过平台，那说明守卫
 * 在撒谎。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.env.DSH_E2E_OUT_DIR ?? ''
const observerPath = process.env.DSH_E2E_OBSERVER_REPORT ?? join(out, 'observer.json')
const storeDir =
  process.env.DSH_E2E_STORE_DIR ?? 'C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/plugin-store'
const egressPath = join(storeDir, 'egress.jsonl')

interface Connection {
  readonly host: string
  readonly allowed: boolean
  readonly kind: string
}
interface BoundaryReport {
  readonly connections: readonly Connection[]
  readonly observerBroken: boolean
  readonly selfCheck: { readonly observed: boolean; readonly detail: string }
  readonly port: number
}
interface EgressRecord {
  readonly at?: string
  readonly purpose: string
  readonly host: string
  readonly decision: 'allow' | 'deny'
  readonly reason: string
}

const failures: string[] = []
const notes: string[] = []
const fail = (message: string): void => {
  failures.push(message)
}

const PLATFORM = /(^|\.)(weibo\.com|weibo\.cn|sina\.com\.cn|baidu\.com|tieba\.com)$/i
const HOST_APP = [
  /(^|\.)deepseek\.com$/i,
  /(^|\.)gvt1\.com$/i,
  /(^|\.)googleapis\.com$/i,
  /(^|\.)gstatic\.com$/i,
]
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/i

// ---- 第一层：进程外观测 ------------------------------------------------------
if (!existsSync(observerPath)) {
  fail(`观测器报告不存在：${observerPath}（没有观测就没有边界结论）`)
} else {
  const report = JSON.parse(readFileSync(observerPath, 'utf8')) as BoundaryReport
  if (report.observerBroken || !report.selfCheck?.observed) {
    fail(`观测器自检未通过：${report.selfCheck?.detail ?? '没有自检记录'}`)
  } else {
    notes.push(`观测器自检通过（端口 ${report.port}）：${report.selfCheck.detail}`)
  }

  const platform = report.connections.filter((entry) => PLATFORM.test(entry.host))
  if (platform.length > 0) {
    fail(
      `手动导入模式下观测到平台连接 ${platform.length} 条：` +
        platform.map((entry) => entry.host).join('、'),
    )
  }

  const hostApp = report.connections.filter((entry) => HOST_APP.some((pattern) => pattern.test(entry.host)))
  const loopback = report.connections.filter((entry) => LOOPBACK.test(entry.host))
  const selfCheck = report.connections.filter((entry) => entry.host === 'observer-selfcheck.invalid')
  /**
   * 模型流量：允许清单里的**非宿主基础设施**域名。
   *
   * 这一轮 `--allow` 里同时放了模型域名与宿主域名，两者无法只靠主机名分开。
   * 所以这里按「是否属于宿主基础设施」划分，剩下的受允许域名都记成模型流量 ——
   * 并在报告里如实写「模型流量 N 条（域名清单）」，而不是笼统说「都通过了」。
   */
  const model = report.connections.filter(
    (entry) => entry.allowed && !LOOPBACK.test(entry.host) && !HOST_APP.some((p) => p.test(entry.host)),
  )
  const unattributed = report.connections.filter(
    (entry) =>
      !entry.allowed &&
      !PLATFORM.test(entry.host) &&
      entry.host !== 'observer-selfcheck.invalid',
  )
  if (unattributed.length > 0) {
    fail(
      `观测到 ${unattributed.length} 条无法归因的连接：` +
        [...new Set(unattributed.map((entry) => entry.host))].join('、'),
    )
  }

  notes.push(`模型流量 ${model.length} 条（含回环 ${loopback.length} 条）`)
  if (hostApp.length > 0) {
    notes.push(
      `宿主自身流量 ${hostApp.length} 条（` +
        [...new Set(hostApp.map((entry) => entry.host))].join('、') +
        '）：不计入插件边界',
    )
  }
  notes.push(`观测到连接 ${report.connections.length} 条（含观测器自检 ${selfCheck.length} 条）`)
}

// ---- 第二层：插件审计 --------------------------------------------------------
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

  /**
   * ## 只认本轮写下的记录（v0.2.37）
   *
   * 这一条是被一次「假绿」逼出来的：脚本把 profile 指到了 A 目录，而 DSH 实际
   * 加载的是 B 目录，于是判定读到的 `egress.jsonl` 是**上一轮**留下的 ——
   * 里面有 12 条 deny，看起来完美通过。而那一轮真正跑的其实是 `open` 模式。
   *
   * 判据：每条记录的时间必须不早于本轮开始时刻。早于的一律丢掉，丢了以后如果
   * 一条不剩，就是「本轮没有任何审计」——那要判失败，不是通过。
   */
  const startedAt = process.env.DSH_E2E_RUN_STARTED_AT ?? ''
  const fresh = (entry: EgressRecord & { at?: string }): boolean =>
    startedAt === '' || entry.at === undefined ? true : entry.at >= startedAt
  const all = records
  const current = records.filter((entry) => fresh(entry))
  if (startedAt !== '' && current.length === 0) {
    fail(
      `插件审计里没有本轮（${startedAt} 之后）的记录：读到 ${all.length} 条全是旧的。` +
        '这一轮要么没跑起来，要么 profile 指错了目录。',
    )
  }
  records.length = 0
  records.push(...current)

  const platformAllows = records.filter((entry) => entry.purpose === 'platform' && entry.decision === 'allow')
  if (platformAllows.length > 0) {
    fail(
      `插件放行了 ${platformAllows.length} 次平台出网：` +
        [...new Set(platformAllows.map((entry) => entry.host))].join('、'),
    )
  }
  const platformDenies = records.filter((entry) => entry.purpose === 'platform' && entry.decision === 'deny')
  const modelAllows = records.filter((entry) => entry.purpose === 'model' && entry.decision === 'allow')
  if (platformDenies.length === 0) {
    fail('插件一条平台拒绝都没有：这一轮没有触发过平台路径，等于边界没被检验')
  } else {
    notes.push(
      `插件拦下 ${platformDenies.length} 次平台出网（` +
        [...new Set(platformDenies.map((entry) => entry.host))].join('、') +
        '）',
    )
  }
  notes.push(`插件放行模型请求 ${modelAllows.length} 次`)
}

// ---- 结论 -------------------------------------------------------------------
for (const note of notes) process.stdout.write(`· ${note}\n`)
if (failures.length > 0) {
  for (const message of failures) process.stdout.write(`✘ ${message}\n`)
  process.stdout.write(`云模型边界：失败（${failures.length} 条）\n`)
  process.exit(1)
}
process.stdout.write('云模型边界：通过（平台流量 0，模型流量走明确允许的渠道）\n')
/**
 * 覆盖范围必须写在结论旁边（§6.2）。
 *
 * 一个只写「通过」的报告，会让人以为「全进程零出网」已经被证明了。实际不是：
 * 宿主进程的 Node 侧没有经过代理（代理会阻断它自己的模型目录查询），所以那一层
 * 没有观测。把范围写在这里，报告读者才不会把结论外推。
 */
process.stdout.write(
  '覆盖范围：Chromium 出网（经代理，逐条记录）；插件四条出口（模型/贴吧/CLI/授权探针，' +
    '由 egress.jsonl 记录）；**宿主进程 Node 出网未观测**（不得据此声称全进程零出网）。\n',
)
