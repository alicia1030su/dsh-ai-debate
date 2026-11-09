/**
 * 扫描命中的**脱敏**表示（v0.2.39 发布安全收口 §1）。
 *
 * ## 为什么需要单独一个模块
 *
 * 两个扫描器原来都把命中的整行放进 `sample`，然后在终端、异常信息、JSON 里原样打印。
 * 这等于把「发现泄露」变成「再泄露一次」：CI 日志是公开的，`--json` 的产物会被贴进
 * issue，异常栈会被上传到各种收集器。一条真的 Cookie 被抓到之后，最不该做的事就是
 * 再把它写进日志。
 *
 * 所以所有对外可见的命中描述都经过这里。它**只接受**路径、规则名与位置，不接受内容；
 * 调用方没有参数可以把匹配到的字节带出去。这不是靠「记得别打印」，是靠类型/接口
 * 上没有那条通路。
 *
 * ## 什么算「必要的非敏感信息」
 *
 * - 路径：知道去哪个文件改。
 * - 规则名：知道命中哪一条（是 AWS key 还是私钥）。
 * - 行号 / 列号（文本）或字节偏移（二进制）：能直接跳过去。
 *
 * **不包含**：匹配到的子串、它的前后缀、整行内容、命中长度。前缀也不行 —— 一把钥匙的
 * 前四个字符仍然是钥匙材料的一部分，而长度也能缩小猜测范围。
 */

/**
 * @typedef {object} Finding
 * @property {string} path 归档内路径
 * @property {string} rule 规则名（不含任何命中内容）
 * @property {'content' | 'name' | 'type'} kind 命中类别
 * @property {number} [line] 1 起的行号（文本文件）
 * @property {number} [column] 1 起的列号（文本文件，命中起点）
 * @property {number} [offset] 0 起的字节偏移（二进制文件）
 */

/**
 * 内容命中。
 *
 * @param {{ path: string, rule: string, line?: number, column?: number, offset?: number }} input
 * @returns {Finding}
 */
export function contentFinding(input) {
  /** @type {Finding} */
  const finding = { path: input.path, rule: input.rule, kind: 'content' }
  if (input.line !== undefined) {
    finding.line = input.line
    if (input.column !== undefined) finding.column = input.column
  } else if (input.offset !== undefined) {
    finding.offset = input.offset
  }
  return finding
}

/**
 * 文件名/目录名命中。路径本身就是判定依据，不涉及文件内容。
 *
 * @param {{ path: string, rule: string, kind?: 'name' | 'type' }} input
 * @returns {Finding}
 */
export function pathFinding(input) {
  return { path: input.path, rule: input.rule, kind: input.kind ?? 'name' }
}

/**
 * 一行可读的位置描述：`path:line:column` / `path@offset` / `path`。
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(finding) {
  if (finding.line !== undefined) {
    return finding.column === undefined
      ? `${finding.path}:${finding.line}`
      : `${finding.path}:${finding.line}:${finding.column}`
  }
  if (finding.offset !== undefined) return `${finding.path}@${finding.offset}`
  return finding.path
}
