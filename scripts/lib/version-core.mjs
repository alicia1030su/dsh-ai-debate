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
  /**
   * 版本号里允许一个预发布后缀（`-rc.1`）。
   *
   * 加这个后缀是必要的：v0.3.0 的候选版就叫 `0.3.0-rc.1`，如果正则只认三段数字，
   * README 里写 `#v0.3.0-rc.1` 会被**整段不匹配** —— 于是 `checkReadme` 报「找不到
   * 任何版本上下文」，而真正的原因是它根本没看见。那种失败看起来像文档没写，
   * 实际是规则读不懂。
   *
   * 后缀只放行 `-<字母数字.>` 这一段，不接受任意字符：`0.2.17-rc.1.2` 可以，
   * `0.2.17-beta+meta` 不行（构建元数据不该出现在安装命令里）。
   */
  const pattern =
    /#v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)|releases\/tag\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)|dsh-ai-debate-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz|dsh-ai-debate-source-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.zip/g
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
 * README 的渠道上限：每一类上下文最多同时出现两个版本。
 *
 * ## 为什么从「只能一个」改成「最多两个」（v0.3.0）
 *
 * 规则原本是「四处上下文全指向当前版本」。那条规则的用处是抓「发了版忘了改文档」——
 * v0.2.16 就是这么翻车的：安装命令是新的、附件名还是旧的，用户装到上一个版本还以为是新的。
 *
 * 但现在文档必须同时说清两条渠道：**稳定版**（Latest，给普通用户）与**候选版**
 * （Pre-release，给测试者）。候选版存在期间，README 里必然同时出现 `0.2.39` 与
 * `0.3.0-rc.1`。继续要求「只能一个」只有两个下场：要么把文档写瘸（只提一个渠道），
 * 要么把校验关掉。前者害用户，后者害自己。
 *
 * ## 放宽的边界：只放宽数量，不放宽「当前版本必须出现」
 *
 * 每一类上下文里**必须**包含 `expected`（本次要发布的那个版本）。这一条把老规则的
 * 主要作用原样保留：
 *
 * - 忘了改文档 → 各类里只有旧版本，`expected` 不在集合里 → 报错；
 * - 只改了安装命令、漏了附件名 → 那一类的集合里没有 `expected` → 报错，且指名是哪一类；
 * - 两个以上版本混进来（历史版本没清干净）→ 报错。
 *
 * 唯一放过的新情况是「恰好两个版本，其中一个是当前要发的那个」。另一个是谁，
 * 校验器不猜——它可能是稳定版，也可能就是上一个候选版，两种都合理。
 * 「那个版本是不是 Latest」是 GitHub 的事实，不是 README 能证明的，所以不在这里判。
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
    if (versions.size > 2) {
      problems.push(`README 的${kind}出现了三个以上版本：${[...versions].join('、')}`)
      continue
    }
    if (!versions.has(expected)) {
      const seen = [...versions].join('、')
      problems.push(
        `README 的${kind}没有指向当前版本 ${expected}（只看到 ${seen}）：` +
          '发版时最容易漏的就是这一类',
      )
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
  // 预发布后缀里也有点（`0.3.0-rc.1`），必须一起转义，否则 `rc.1` 会被当通配符。
  const escaped = from.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&')
  return text
    .replace(new RegExp(`#v${escaped}(?![\\d.])`, 'g'), `#v${to}`)
    .replace(new RegExp(`releases/tag/v${escaped}(?![\\d.])`, 'g'), `releases/tag/v${to}`)
    .replace(new RegExp(`dsh-ai-debate-${escaped}\\.tgz`, 'g'), `dsh-ai-debate-${to}.tgz`)
    .replace(new RegExp(`dsh-ai-debate-source-${escaped}\\.zip`, 'g'), `dsh-ai-debate-source-${to}.zip`)
}

/**
 * 拆版本号：主版本三段 + 可选预发布后缀。
 *
 * 返回 `null` 表示不是合法版本号。**「合法」与「可发布」是两件事**：
 * 这里只回答形状对不对，是否允许发 Release 由调用方判断。
 */
export function parseVersion(version) {
  const text = String(version ?? '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(text)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: text,
  }
}

/**
 * 是不是预发布版本。
 *
 * 判定只有一个依据：版本号里有没有 `-后缀`。不看时间、不看分支名 —— 那些都会让
 * 「这个版本会不会被标成 Latest」变成一件需要推断的事，而它应该是查表。
 */
export function isPrerelease(version) {
  const parsed = parseVersion(version)
  return parsed !== null && parsed.prerelease !== null
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
