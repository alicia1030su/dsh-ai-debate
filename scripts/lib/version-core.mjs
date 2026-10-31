/**
 * 版本号一致性的判定规则（纯函数，可离线测试）。
 *
 * 命令行的执行部分在 `scripts/version.mjs`；这里只放「怎么判断一致」和「怎么改才不误伤历史」，
 * 因为这两件事需要被测试覆盖，而测试不应该去跑一个会 `process.exit` 的文件。
 */

/**
 * 从 README 的四种版本上下文里抽出实际写的版本号。
 *
 * 只看这四种，是因为它们是「文档告诉用户去装哪个版本」的唯一位置：
 *
 * - `#v0.2.16` —— `dsh plugin add github:...#v0.2.16`
 * - `releases/tag/v0.2.16` —— Release 链接
 * - `dsh-ai-debate-0.2.16.tgz` —— 安装包名
 * - `dsh-ai-debate-source-0.2.16.zip` —— 源码包名
 *
 * 其它位置的版本号（「v0.2.12 起 CLI 才真正被调用」之类）是历史叙述，改了就是造假。
 */
export function readmeVersions(text) {
  const pattern =
    /#v(\d+\.\d+\.\d+)|releases\/tag\/v(\d+\.\d+\.\d+)|dsh-ai-debate-(\d+\.\d+\.\d+)\.tgz|dsh-ai-debate-source-(\d+\.\d+\.\d+)\.zip/g
  const found = new Map()
  for (const match of text.matchAll(pattern)) {
    const version = match[1] ?? match[2] ?? match[3] ?? match[4]
    const kind = match[1] ? '安装命令' : match[2] ? 'Release 链接' : match[3] ? '安装包名' : '源码包名'
    if (!found.has(kind)) found.set(kind, new Set())
    found.get(kind).add(version)
  }
  return found
}

/**
 * README 里所有版本上下文都必须指向同一个版本。
 *
 * 分开返回而不是合并成一个集合，是为了让报错说得出「安装命令还是旧的」，
 * 而不只是「README 里有多个版本号」—— 后者需要人再翻一遍文件才知道该改哪里。
 */
export function checkReadme(text, expected) {
  const problems = []
  const found = readmeVersions(text)

  if (found.size === 0) {
    problems.push('README 里找不到任何版本上下文（安装命令 / Release 链接 / 附件名），无法确认文档指向当前版本')
    return problems
  }

  for (const [kind, versions] of found) {
    if (versions.size > 1) {
      problems.push(`README 的${kind}出现了多个版本：${[...versions].join('、')}`)
      continue
    }
    const only = [...versions][0]
    if (only !== expected) {
      problems.push(`README 的${kind}指向 ${only}，而当前版本是 ${expected}`)
    }
  }
  return problems
}

/**
 * 精确替换四种版本上下文。
 *
 * `(?![\d.])` 是必要的：`0.2.1` 是 `0.2.16` 的前缀，没有这个前瞻，
 * 从 0.2.1 升到 0.2.2 时 `v0.2.16` 会被改写成 `v0.2.26`。
 */
export function rewriteReadme(text, from, to) {
  const escaped = from.replace(/\./g, '\\.')
  return text
    .replace(new RegExp(`#v${escaped}(?![\\d.])`, 'g'), `#v${to}`)
    .replace(new RegExp(`releases/tag/v${escaped}(?![\\d.])`, 'g'), `releases/tag/v${to}`)
    .replace(new RegExp(`dsh-ai-debate-${escaped}\\.tgz`, 'g'), `dsh-ai-debate-${to}.tgz`)
    .replace(new RegExp(`dsh-ai-debate-source-${escaped}\\.zip`, 'g'), `dsh-ai-debate-source-${to}.zip`)
}

/** CHANGELOG 里有没有这个版本的段落。发布说明就是从这里截的，没有段落等于没有说明。 */
export function changelogHasVersion(text, version) {
  return new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)
}

/**
 * 在 README 里找「安装命令」区块附近是否还有旧版本残留。
 *
 * `checkReadme` 只看四种上下文；这里额外回答一个更朴素的问题：还有没有别的地方
 * 写着 `0.2.15` 这样的旧版本号，而它出现在安装说明附近。只用于提示，不用于判定失败 ——
 * 历史叙述里的版本号本来就该留着。
 */
export function staleVersionMentions(text, expected) {
  const lines = text.split(/\r?\n/)
  const stale = []
  lines.forEach((line, index) => {
    const match = /(\d+\.\d+\.\d+)/.exec(line)
    if (match === null) return
    if (match[1] === expected) return
    if (!/安装|plugin add|tgz|zip|Release|releases/i.test(line)) return
    stale.push({ line: index + 1, version: match[1], text: line.trim() })
  })
  return stale
}
