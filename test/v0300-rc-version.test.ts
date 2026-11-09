/**
 * 预发布版本号（v0.3.0 §四）。
 *
 * ## 这一组防的是什么
 *
 * 一个 `0.3.0-rc.1` 的标签，在 `gh release create` 不带 `--prerelease` 时会被打成
 * **Latest 正式版**：页面看起来是正式发布，用户下到的却是候选。这件事最难发现的地方
 * 在于它不报错 —— 版本号写得对、标签打得对、CI 全绿，只有「这是不是 Pre-release」
 * 这一个布尔值错了。
 *
 * 所以判定被拆成两层，各自可测：
 *
 * 1. `parseVersion` / `isPrerelease` 只回答「形状对不对、有没有后缀」；
 * 2. `version.mjs check` 在版本是预发布时，额外要求工作流里有 `--prerelease`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkReadme,
  isPrerelease,
  parseVersion,
  readmeVersions,
  rewriteReadme,
} from '../scripts/lib/version-core.mjs'

const REPO = join(import.meta.dirname, '..')

test('版本解析：三段数字与预发布都认，其它一律 null', () => {
  assert.deepEqual(parseVersion('0.3.0'), {
    major: 0,
    minor: 3,
    patch: 0,
    prerelease: null,
    raw: '0.3.0',
  })
  assert.deepEqual(parseVersion('0.3.0-rc.1'), {
    major: 0,
    minor: 3,
    patch: 0,
    prerelease: 'rc.1',
    raw: '0.3.0-rc.1',
  })

  for (const bad of ['0.3', 'v0.3.0', '0.3.0.1', '', null, undefined, 'abc', '0.3.0-']) {
    assert.equal(parseVersion(bad as never), null, `${String(bad)} 不该被当成合法版本号`)
  }
})

test('预发布判定只看后缀，不看别的', () => {
  assert.equal(isPrerelease('0.3.0-rc.1'), true)
  assert.equal(isPrerelease('0.3.0-rc.10'), true)
  assert.equal(isPrerelease('0.3.0-beta'), true)
  assert.equal(isPrerelease('0.3.0'), false)
  assert.equal(isPrerelease('1.0.0'), false)
  // 不合法的版本号不是预发布，也不是正式版 —— 它什么都不是，由 parseVersion 判 null。
  assert.equal(isPrerelease('nonsense'), false)
})

test('README 抽取：预发布后缀能被认出来（旧正则整段看不见）', () => {
  const text = [
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.3.0-rc.1',
    'https://github.com/alicia1030su/dsh-ai-debate/releases/tag/v0.3.0-rc.1',
    '`dsh-ai-debate-0.3.0-rc.1.tgz`',
    '`dsh-ai-debate-source-0.3.0-rc.1.zip`',
  ].join('\n')
  const found = readmeVersions(text)
  assert.equal(found.size, 4, '四种上下文都要被认出来')
  for (const [kind, versions] of found) {
    assert.deepEqual([...versions], ['0.3.0-rc.1'], `${kind} 解析错了`)
  }
})

test('README 一致性：预发布版本能对齐', () => {
  const text = 'dsh plugin add github:x#v0.3.0-rc.1\nreleases/tag/v0.3.0-rc.1'
  assert.deepEqual(checkReadme(text, '0.3.0-rc.1'), [])
  // 指向 rc 却说是正式版，必须报出来。
  const problems = checkReadme(text, '0.3.0')
  assert.ok(problems.length > 0, '版本不一致必须报错')
})

test('README 改写：预发布里的点要被转义，不能当通配符', () => {
  const before = '#v0.3.0-rc.1 and 0.3.0-rcX1 should not change'
  const after = rewriteReadme(before, '0.3.0-rc.1', '0.3.0')
  assert.match(after, /#v0\.3\.0\b/)
  assert.match(after, /0\.3\.0-rcX1/, '不该把 rc.1 里的点当通配符去改别的字符')
})

test('工作流：发布步骤按版本号条件带 --prerelease（否则 rc 会被打成 Latest）', () => {
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.ok(
    workflow.includes('--prerelease'),
    'release.yml 的 gh release create 没有 --prerelease；发预发布版本会被标成 Latest 正式版',
  )

  // 不能无条件加：正式版必须是正式 Release，不该被标成 Pre-release。
  // 判据必须是版本号里的后缀，而不是分支名、时间或环境变量。
  assert.match(workflow, /PRERELEASE_FLAG/, '需要有一个按条件取值的标志变量')
  assert.match(
    workflow,
    /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-\[0-9A-Za-z\.\]\+\$/,
    '判定必须基于版本号里的预发布后缀',
  )

  /**
   * 最要紧的一条：**标志变量必须真的出现在 `gh release create` 的命令行里**。
   *
   * 只断言「文件里有 --prerelease 这个词」是不够的 —— 那段变量算出来却没用上，
   * 测试照样绿，rc 照样被标成 Latest。这里按命令块检查：`gh release create` 到
   * 第一个非续行结束之间的文本，必须包含 `$PRERELEASE_FLAG`。
   */
  // 注意：`gh release create` 这个词在注释里也出现过两次，所以必须找**真正的命令行**
  // ——它以 `gh release create "v` 开头（后面接 tag）。第一版找的是第一次出现，
  // 落在注释上，于是取出来的「命令块」是空的，断言失败但原因完全不对。
  const commandIndex = workflow.indexOf('gh release create "v')
  assert.ok(commandIndex !== -1, '找不到 gh release create 的实际命令行')
  const commandBlock = workflow.slice(commandIndex).split('\n').reduce(
    (acc: { lines: string[]; done: boolean }, line: string) => {
      if (acc.done) return acc
      acc.lines.push(line)
      if (!line.trimEnd().endsWith('\\')) acc.done = true
      return acc
    },
    { lines: [], done: false },
  ).lines.join('\n')
  assert.match(
    commandBlock,
    /\$PRERELEASE_FLAG/,
    'gh release create 的命令行必须带上这个标志，算了不用等于没算',
  )

  /**
   * 三态而不是两态：`0.3`、`0.3.0.1` 这类写坏的版本号必须**拒绝发布**，
   * 不能被归进「正式版」然后以 Latest 的身份发出去。
   */
  assert.match(
    workflow,
    /elif \[\[ "\$VERSION" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/,
    '正式版必须是显式的第二个分支，剩下的才走拒绝',
  )
  assert.match(workflow, /拒绝发布/, '非法版本号必须让这一步失败')
})
