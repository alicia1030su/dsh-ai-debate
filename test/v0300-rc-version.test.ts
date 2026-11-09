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
import test from 'node:test'

import {
  checkReadme,
  isPrerelease,
  parseVersion,
  readmeVersions,
  rewriteReadme,
} from '../scripts/lib/version-core.mjs'

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

/**
 * 工作流那一条（`gh release create` 必须按版本号条件带 `--prerelease`）**不在这里**。
 *
 * 它断言的是 `.github/workflows/release.yml` 的内容，而那是 `workflow` 敏感路径 ——
 * 断言与改动必须在同一个 PR 里，否则这条测试要么先红着进 main，要么逼着 CI 红一次。
 * 所以它跟工作流改动一起，放在单独的敏感 PR 中。
 */
