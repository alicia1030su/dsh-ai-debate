/**
 * 可被自动化读取的交付状态报告。
 *
 * ## 为什么要有这个文件（任务书 §二）
 *
 * 之前的验收报告都是人写的 Markdown。人写的报告有一个结构性问题：它写在提交里，而提交的
 * SHA 只有提交之后才知道。于是「报告里写的提交」和「报告所在的那个提交」永远差一拍，
 * v0.2.16 的报告就栽在这上面 —— 它写着发布提交 `f1c111c`，而最终标签实际指向 `57ffec6`。
 * 那不是笔误，是这个形式本身做不到。
 *
 * 一份在**发布当时**生成的 JSON 不受这个限制：它知道自己的 SHA、自己的 Run ID、自己附件的
 * 哈希，因为生成它的那个进程正握着这些值。所以约定的分工是：
 *
 * - Markdown 报告讲「为什么这么做」，不写会变的数字
 * - 这个 JSON 讲「实际发生了什么」，数字全部现取
 *
 * ## 字段约定
 *
 * 所有字段都可能是 `null`，含义是「还没到那一步」或「这次运行不知道」。**不允许**用
 * 占位字符串（`'TBD'`、`'待补充'`）冒充值 —— 那会让「未验证」变成「已验证」。
 * 读者应当把 `null` 当作未知处理，而不是当作零。
 */

/**
 * 按 BOM 把测试日志的字节解成文本。
 *
 * 起因是一次本机实测：`node --test > full.txt` 在 PowerShell 里写出的是 **UTF-16LE**
 * （开头 `FF FE`）。按 UTF-8 读会得到一片替换字符，`parseTestSummary` 一条都对不上，
 * 于是「1170 项全过」被记成「测试数为 0」。CI 里 `tee` 写的是 UTF-8，所以这个坑只在
 * Windows 上手工核对时出现 —— 恰恰是最需要相信报告的时候。
 */
export function decodeTestLog(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  return buffer.toString('utf8')
}

/** 报告结构版本。字段语义变了就加一，读取方据此拒绝旧格式。 */
export const STATUS_SCHEMA = 1

/** 总体状态。`blocked` 与 `failed` 都是负面结果，区别只在「要不要人来解」。 */
export const STATUS_VALUES = ['in_progress', 'success', 'failed', 'blocked']

/**
 * 把任意来源的计数归一成可比较的形状。
 *
 * `node --test` 的汇总行长这样：`ℹ tests 1067` / `ℹ pass 1067` / `ℹ fail 0` / `ℹ skipped 1`。
 * 之前每个脚本各自用正则捞一遍，捞不到就当 0 —— 那等于「没跑」和「全过了」长得一样。
 * 这里改成：捞不到就是 `null`，并且 `total` 与 `passed + failed` 对不上时直接报错。
 */
export function parseTestSummary(text) {
  const pick = (label) => {
    const match = new RegExp(`^\\s*(?:ℹ|#)?\\s*${label}\\s+(\\d+)\\s*$`, 'm').exec(text ?? '')
    return match === null ? null : Number(match[1])
  }

  const total = pick('tests')
  const passed = pick('pass')
  const failed = pick('fail')
  const skipped = pick('skipped')

  if (total === null || passed === null || failed === null) {
    return { total, passed, failed, skipped, consistent: false }
  }

  // 跳过数默认 0：旧版 runner 没有这一行，不该因此判成不一致。
  const skippedCount = skipped ?? 0
  const consistent = total === passed + failed + skippedCount
  return { total, passed, failed, skipped: skippedCount, consistent }
}

/**
 * 构造报告。
 *
 * 入参都是「已知就填、未知就留空」，构造函数本身不做任何推断 —— 它没有能力知道远端
 * 发生了什么，假装知道就是编造。
 */
export function createStatusReport({ version, generatedAt = new Date().toISOString() }) {
  return {
    schema: STATUS_SCHEMA,
    version,
    generatedAt,
    status: 'in_progress',
    stage: null,
    /** 失败或阻塞时才有值。`stage` 说明坏在哪一步，`recovery` 说明人该做什么。 */
    failure: null,
    github: {
      repo: null,
      branch: null,
      baseSha: null,
      commitSha: null,
      tag: null,
      tagObjectSha: null,
      pr: null,
      runs: { ci: null, release: null },
    },
    checks: {
      typecheck: null,
      tests: null,
      leakScan: null,
      archiveScan: null,
      installArchive: null,
      sourceArchive: null,
    },
    tests: { files: null, total: null, passed: null, failed: null, skipped: null },
    artifacts: [],
    /** 明确列出「这次没有验证的东西」。空数组表示「没有遗漏」，而不是「没写」。 */
    unverified: [],
    notes: [],
  }
}

/**
 * 一条附件的描述。
 *
 * `sha256` 必须来自**读这个文件算出来的**结果，不能从打包脚本的输出里抄 —— 抄来的那串
 * 数字证明的是「打包脚本认为它写对了」，而我们想证明的是「磁盘上这个文件确实是这样」。
 */
export function artifactOf({ name, bytes, sha256, kind }) {
  if (!name) throw new Error('附件必须有名')
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error(`${name} 的字节数不合法：${bytes}`)
  if (!/^[0-9a-f]{64}$/i.test(sha256 ?? '')) throw new Error(`${name} 的 sha256 不是 64 位十六进制`)
  return { name, bytes, sha256: sha256.toLowerCase(), kind: kind ?? null }
}

/**
 * 校验报告自身是否自洽。
 *
 * 这是给 CI 用的：一份声称 `status: success` 却缺 `commitSha` 或附件哈希的报告，本身就是
 * 「绿灯但什么都没证明」的形状。校验失败时抛出，让发布步骤变红，而不是把可疑报告发出去。
 */
export function assertReportConsistent(report) {
  const problems = []
  if (report?.schema !== STATUS_SCHEMA) problems.push(`schema 不是 ${STATUS_SCHEMA}`)
  if (!STATUS_VALUES.includes(report?.status)) problems.push(`status 不合法：${report?.status}`)
  if (typeof report?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(report.version)) {
    problems.push('version 不是三段数字')
  }

  if (report?.status === 'success') {
    if (!report.github?.commitSha) problems.push('status 是 success 但没有 commitSha')
    if (!report.github?.tag) problems.push('status 是 success 但没有 tag')
    if (!Array.isArray(report.artifacts) || report.artifacts.length === 0) {
      problems.push('status 是 success 但没有附件')
    }
    const tests = report.tests ?? {}
    if (tests.total === null || tests.total === 0) problems.push('status 是 success 但测试数为 0')
    if (tests.failed !== 0) problems.push(`status 是 success 但失败数是 ${tests.failed}`)
  }

  if ((report?.status === 'failed' || report?.status === 'blocked') && report.failure === null) {
    problems.push(`${report.status} 必须写明 failure`)
  }

  if (problems.length > 0) {
    throw new Error(`交付状态报告不自洽：\n  - ${problems.join('\n  - ')}`)
  }
  return report
}

/** 报告的文件名。固定下来，让 workflow、ship、文档都引用同一个名字。 */
export function statusFileName(version) {
  return `delivery-status-${version}.json`
}
