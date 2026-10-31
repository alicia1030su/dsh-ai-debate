/**
 * Release 说明的生成规则（纯函数，可离线测试）。
 *
 * ## 为什么要独立成模块
 *
 * 发布说明原本是 `release.yml` 里的一段 `awk` + 几行 `echo`。它只在那一个时刻被执行：
 * 打标签、推、等工作流跑、建 Release。也就是说，**写错一个字符也要等真发一次版才知道**。
 * v0.2.16 的发布说明里就出现过哈希对不上的情况 —— 因为生成说明的是一个 bash 片段，
 * 而「说明里的哈希」与「附件的哈希」之间没有任何机器可读的关联。
 *
 * 拆出来之后，CI 可以用 `scripts/release-dry-run.mjs` 走完同样的代码路径，只是不 `gh release create`。
 * 于是「发布说明长什么样」在 PR 阶段就能看到，而不是在标签推上去之后。
 *
 * ## 说明里必须有什么
 *
 * 1. CHANGELOG 里该版本的段落（没有段落时用兜底说明，而不是空白）
 * 2. 安装命令，且版本号与本次发布一致
 * 3. 两个附件名与各自的 SHA-256 —— 三个数字都必须是现算的，不能从别处抄
 *
 * 第 3 条是 v0.2.16 的教训：用户拿到的哈希必须能对上他刚下载的文件。
 */

/** 从 CHANGELOG 里截出 `## [version]` 段落（不含标题行本身）。段落不存在时返回空数组。 */
export function extractChangelogSection(changelog, version) {
  const lines = String(changelog ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) return []

  const section = []
  for (let index = start + 1; index < lines.length; index += 1) {
    // 下一个 `## [` 开头的二级标题就是段落边界。
    if (lines[index].startsWith('## [')) break
    section.push(lines[index])
  }

  // 去掉尾部多余空行，避免说明文件末尾拖一堆换行。
  while (section.length > 0 && section[section.length - 1].trim() === '') section.pop()
  return section
}

/** 段落在但只有空行，等于没有说明 —— 与「不存在」同样处理。 */
export function hasUsableSection(section) {
  return Array.isArray(section) && section.some((line) => line.trim() !== '')
}

/** 兜底说明：CHANGELOG 忘了写段落时，至少不能发出一个没有任何文字说明的版本。 */
export function fallbackDescription(version) {
  return [`AI代吵架 v${version}`, '', '本版本没有在 CHANGELOG.md 里写说明。']
}

/** 安装段落。所有数字都来自调用方现取的事实。 */
export function installSection({ repo, version, tarball, tarballSha256, sourceZip, sourceZipSha256 }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) {
    throw new Error(`版本号必须是三段数字，收到 ${JSON.stringify(version)}`)
  }
  if (!/^[0-9a-f]{64}$/i.test(String(tarballSha256 ?? ''))) {
    throw new Error(`${tarball} 的 SHA-256 不是 64 位十六进制`)
  }
  if (!/^[0-9a-f]{64}$/i.test(String(sourceZipSha256 ?? ''))) {
    throw new Error(`${sourceZip} 的 SHA-256 不是 64 位十六进制`)
  }

  // 附件名里带 `..` 或斜杠意味着它不是这个名字 —— 直接拒绝，别写进说明里去误导人。
  for (const name of [tarball, sourceZip]) {
    if (/\.\.|\//.test(String(name ?? ''))) {
      throw new Error(`附件名不合法：${JSON.stringify(name)}`)
    }
  }

  return [
    '',
    '---',
    '',
    '### 安装',
    '',
    '```bash',
    `dsh plugin --profile <profile> add github:${repo}#v${version}`,
    '# 或使用下方附件',
    `dsh plugin --profile <profile> add ./${tarball}`,
    '```',
    '',
    `- 安装包 \`${tarball}\` SHA-256：\`${tarballSha256.toLowerCase()}\``,
    `- 源码包 \`${sourceZip}\` SHA-256：\`${sourceZipSha256.toLowerCase()}\``,
  ]
}

/**
 * 组装完整说明。
 *
 * 顺序固定：CHANGELOG 段落 → 安装段。固定顺序让 CI 里的 dry-run 能做逐行比对，
 * 而不是只能断言「里面有某个词」。
 */
export function buildReleaseNotes({ changelog, repo, version, tarball, tarballSha256, sourceZip, sourceZipSha256 }) {
  const section = extractChangelogSection(changelog, version)
  const body = hasUsableSection(section) ? section : fallbackDescription(version)

  const notes = [...body, ...installSection({ repo, version, tarball, tarballSha256, sourceZip, sourceZipSha256 })]
  return `${notes.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * 校验一份已经写好的说明是否自洽。
 *
 * 这是 dry-run 与真实发布共用的最后一道：说明里必须真的写着它声称的那些东西。
 * 返回问题列表（空数组表示通过），而不是抛异常 —— 调用方要一次列出全部问题。
 */
export function checkReleaseNotes(notes, { version, tarball, tarballSha256, sourceZip, sourceZipSha256, repo }) {
  const text = String(notes ?? '')
  const problems = []

  if (text.trim() === '') {
    problems.push('发布说明是空的')
    return problems
  }

  if (!text.includes(`github:${repo}#v${version}`)) {
    problems.push(`说明里没有指向 v${version} 的安装命令`)
  }
  if (!text.includes('dsh plugin --profile <profile> add')) {
    problems.push('说明里没有安装命令')
  }

  for (const [label, name, sha] of [
    ['安装包', tarball, tarballSha256],
    ['源码包', sourceZip, sourceZipSha256],
  ]) {
    if (!text.includes(name)) problems.push(`说明里没有提到${label} ${name}`)
    if (!text.includes(String(sha).toLowerCase())) problems.push(`说明里没有${label}的 SHA-256`)
  }

  // 占位文本是「看起来有哈希，其实没验」的典型形状，出现即失败。
  for (const placeholder of ['TBD', 'TODO', '待补充', '<sha>', 'PLACEHOLDER', '$SHA256']) {
    if (text.includes(placeholder)) problems.push(`说明里出现了占位文本 ${placeholder}`)
  }

  // 安装包哈希不该出现两次不一致的写法（大小写混杂会让人对不上）。
  const hashMentions = text.match(/[0-9a-fA-F]{64}/g) ?? []
  if (hashMentions.some((hash) => hash !== hash.toLowerCase())) {
    problems.push('说明里出现了大写形式的 SHA-256，容易与校验工具的输出对不上')
  }

  return problems
}
