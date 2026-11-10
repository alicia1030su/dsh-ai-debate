/**
 * ZIP 索引的完整性规则（v0.3.0 issue #29）。
 *
 * ## 为什么把判定抽出来
 *
 * `scan-archive.mjs` 与 `archive-verify.mjs` 都要读 ZIP：前者判断「发布物里有没有凭据」，
 * 后者判断「发布物里的字节是不是等于那个提交」。历史上两者各写一份读取器，于是
 * v0.2.39 收口时只在扫描器里补了索引一致性检查，核验器仍然用「EOCD 说几条就读几条」——
 * 一个**少报自己**的中央目录在核验器眼里是「全部一致」，因为没被读到的条目根本不进入
 * 比对清单。
 *
 * 所以索引一致性的**判定**只有一份：这里。两边的读取流程各写各的（扫描器要解压内容、
 * 核验器要逐文件比对），但「这个索引可信吗」只有一个答案。
 *
 * ## 这条规则要挡什么
 *
 * 1. **EOCD 少报条目数**。`count = 1` 而磁盘上有两条中央目录记录时，按 count 遍历
 *    只读一条就返回，第二条从未被打开。修法不是信任更大的那个数字，而是要求
 *    「本盘条数 = 总条数 = 实际遍历条数」，且遍历结束位置正好等于「偏移 + 声明长度」。
 * 2. **中央目录与 EOCD 之间有空隙**。少报长度时，目录尾部会落在 EOCD 之前，
 *    那段空隙就是一个没人读的索引。
 * 3. **重复文件名**。同一个名字出现两次时，后一条会覆盖前一条的判定；发布包里出现两次
 *    本身就是「有人在藏东西」的信号。
 * 4. **路径穿越**。`../` 或绝对路径会让解压器写到归档目录之外，扫描器读到的名字也与
 *    实际落点不一致。
 * 5. **非普通文件**。符号链接、设备、FIFO 都不是「文件内容」，语义上无法用「字节是否
 *    等于提交」来判定。
 * 6. **资源耗尽**。声明了 10 GB 解压后内容的条目，不需要真的解开就能拖垮扫描器。
 *
 * 这些规则**只收紧**，不含任何豁免参数。调用方无法关掉其中任何一条 —— 能关掉的检查
 * 等于没有检查。
 */

import { posix } from 'node:path'

/**
 * @typedef {object} ZipIndexEntry
 * @property {string} name 中央目录里的原始名称
 * @property {number} flags 通用标志位，bit 0 = 加密
 * @property {number} method 压缩方式：0 = stored，8 = deflate
 * @property {number} compressedSize 声明的压缩后字节数
 * @property {number} uncompressedSize 声明的解压后字节数
 * @property {number} crc 声明的 CRC32
 * @property {number} localOffset 本地头在文件里的偏移
 * @property {number} mode 外部属性高 16 位（Unix mode）
 * @property {boolean} hostUnix 是否由 Unix 主机创建（高字节 3）
 * @property {'file' | 'directory' | 'nonregular'} kind 索引层的类型判定
 */

/**
 * @typedef {object} ZipIndex
 * @property {number} entriesOnDisk 本盘条目数（EOCD 偏移 8）
 * @property {number} totalEntries 总条目数（EOCD 偏移 10）
 * @property {number} centralSize 中央目录声明的字节长度（EOCD 偏移 12）
 * @property {number} centralOffset 中央目录起始偏移（EOCD 偏移 16）
 * @property {number} eocdOffset EOCD 记录自身的偏移
 * @property {number} walked 实际被读到的条目数
 * @property {number} walkedEnd 遍历结束时游标的位置
 * @property {readonly ZipIndexEntry[]} entries 索引条目
 */

/**
 * @typedef {object} ZipIndexVerdict
 * @property {boolean} ok 是否可信
 * @property {readonly string[]} problems 问题列表（不含文件内容）
 */

/**
 * 索引是否自洽。
 *
 * 每条问题的措辞都不含文件内容 —— 它会被打进日志。
 *
 * @param {ZipIndex} index 索引
 * @returns {ZipIndexVerdict} 判定
 */
export function judgeZipIndex(index) {
  /** @type {string[]} */
  const problems = []

  if (index.entriesOnDisk !== index.totalEntries) {
    problems.push(
      `EOCD 声称本盘 ${index.entriesOnDisk} 条、共 ${index.totalEntries} 条，两者不一致`,
    )
  }
  if (index.walked !== index.totalEntries) {
    problems.push(`实际遍历到 ${index.walked} 条，EOCD 声称 ${index.totalEntries} 条`)
  }

  const declaredEnd = index.centralOffset + index.centralSize
  if (declaredEnd > index.eocdOffset) {
    problems.push('中央目录的偏移与长度越过了结尾记录')
  } else if (declaredEnd !== index.eocdOffset) {
    problems.push(
      `中央目录结束于 ${declaredEnd}，结尾记录在 ${index.eocdOffset}：中间有未说明的数据`,
    )
  }

  if (index.walkedEnd !== declaredEnd) {
    problems.push(
      `遍历结束于 ${index.walkedEnd}，中央目录声明结束于 ${declaredEnd}：条目数或长度被少报`,
    )
  }

  const names = new Set()
  for (const entry of index.entries) {
    if (names.has(entry.name)) problems.push(`重复的条目名：${entry.name}`)
    names.add(entry.name)

    if (isUnsafePath(entry.name)) problems.push(`路径穿越或绝对路径：${entry.name}`)

    if (entry.kind === 'nonregular') {
      problems.push(`非普通文件条目：${entry.name}（mode ${(entry.mode & 0o170000).toString(8)}）`)
    }

    if ((entry.flags & 0x1) !== 0) problems.push(`条目已加密，无法扫描：${entry.name}`)
    if (entry.method !== 0 && entry.method !== 8) {
      problems.push(`不支持的压缩方式 ${entry.method}：${entry.name}`)
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * 名字是否逃出归档根目录。
 *
 * 判定基于**分段**而不是字符串包含：`a/../b` 与 `..%2fb` 是两件事，后者只是一个普通文件名。
 * 反斜杠先归一成斜杠 —— ZIP 规范要求 `/`，但 Windows 工具历史上写过 `\`，把 `..\x`
 * 当成普通名字会让解压器写出归档目录。
 *
 * @param {string} name 条目名
 * @returns {boolean} 是否不安全
 */
export function isUnsafePath(name) {
  if (name === '') return true
  const normalised = name.split('\\').join('/')
  if (normalised.startsWith('/')) return true
  // Windows 盘符形式的绝对路径。
  if (/^[A-Za-z]:/.test(normalised)) return true
  const resolved = posix.normalize(normalised)
  if (resolved.startsWith('../') || resolved === '..') return true
  return resolved.split('/').some((segment) => segment === '..')
}

/**
 * @typedef {object} ZipLimits
 * @property {number} maxEntryBytes 单个条目解压后的上限
 * @property {number} maxTotalBytes 全部条目解压后的总上限
 * @property {number} maxEntries 条目数上限
 */

/**
 * 默认上限。
 *
 * 本仓库的源码包最大条目是 8 MB 级，总解压量约 30 MB；这里给 20 倍余量。上限的作用不是
 * 「精确贴合」，而是把一个 10 GB 的压缩炸弹变成一个立刻发生的失败。
 *
 * @type {ZipLimits}
 */
export const DEFAULT_ZIP_LIMITS = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20000,
}

/**
 * 声明的尺寸是否在预算内。
 *
 * 只看**声明的**数字：这正好是最便宜的一道闸门 —— 一个声明了 10 GB 的条目在被解压之前
 * 就会失败，扫描器不会先去分配那 10 GB。
 *
 * @param {readonly ZipIndexEntry[]} entries 索引条目
 * @param {ZipLimits} [limits] 上限
 * @returns {readonly string[]} 超限说明；空数组表示在预算内
 */
export function judgeZipBudget(entries, limits = DEFAULT_ZIP_LIMITS) {
  /** @type {string[]} */
  const problems = []
  if (entries.length > limits.maxEntries) {
    problems.push(`条目数 ${entries.length} 超过上限 ${limits.maxEntries}`)
  }
  let total = 0
  for (const entry of entries) {
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      problems.push(
        `条目声明 ${entry.uncompressedSize} 字节，超过单条上限 ${limits.maxEntryBytes}：${entry.name}`,
      )
    }
    total += entry.uncompressedSize
    if (total > limits.maxTotalBytes) {
      problems.push(`累计声明 ${total} 字节，超过总量上限 ${limits.maxTotalBytes}`)
      break
    }
  }
  return problems
}
