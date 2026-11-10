/**
 * v0.3.0：预发布版本要能走完整条交付链（不只是打标签那一步）。
 *
 * ## 这条测试补的是什么
 *
 * #38 让 `release.yml` 的 `gh release create` 带上了 `--prerelease`，但那条工作流之前的
 * 每一步仍然只认三段数字：
 *
 * - `ship.mjs` 的 preflight 直接拒绝 `0.3.0-rc.1` → 根本走不到打标签；
 * - `release-dry-run.mjs` 在读 `package.json` 时拒绝 → 工作流在 `gh release create` 之前就红；
 * - `release-notes.installSection` 拒绝 → 生成不了安装说明；
 * - `delivery-status.assertReportConsistent` 拒绝 → 一份 rc 的成功报告会被判不自洽。
 *
 * 四处任意一处不改，RC 就只能靠手工打标签发布 —— 而那绕开了整条审核链。
 *
 * ## 只放宽形状，不放宽语义
 *
 * `0.3`、`0.3.0.1`、`v0.3.0`、`0.3.0-` 仍然必须被拒绝。预发布后缀只允许
 * `-<字母数字.>`，不接受 `+build` 这类构建元数据（安装命令里不该出现它）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ship-core / version-core 是 .mjs，测试类型检查基线里没有它们的声明
import {
  assertSemver,
  branchForVersion,
  createShipState,
  tagForVersion,
} from '../scripts/lib/ship-core.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { assertReportConsistent, createStatusReport, STATUS_SCHEMA } from '../scripts/lib/delivery-status.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { installSection } from '../scripts/lib/release-notes.mjs'

describe('v0.3.0：预发布版本在交付链里是合法形状', () => {
  it('assertSemver 接受 rc，拒绝其它写法', () => {
    assert.equal(assertSemver('0.3.0-rc.1'), '0.3.0-rc.1')
    assert.equal(assertSemver('0.3.0'), '0.3.0')

    for (const bad of ['0.3', '0.3.0.1', 'v0.3.0', '0.3.0-', '0.3.0-beta+meta', '', null]) {
      assert.throws(() => assertSemver(bad as string), /版本号必须形如/, `${String(bad)} 应当被拒绝`)
    }
  })

  it('标签与分支名带上完整预发布后缀', () => {
    assert.equal(tagForVersion('0.3.0-rc.1'), 'v0.3.0-rc.1')
    assert.equal(branchForVersion('0.3.0-rc.1', 'auto'), 'release/v0.3.0-rc.1-auto')
  })

  it('交付状态接受 rc 版本，且文件名可回溯', async () => {
    const { statusFileName } = await import('../scripts/lib/delivery-status.mjs')
    assert.equal(statusFileName('0.3.0-rc.1'), 'delivery-status-0.3.0-rc.1.json')

    const state = createShipState({ version: '0.3.0-rc.1' })
    assert.equal(state.version, '0.3.0-rc.1')
  })

  it('安装段能生成 rc 的安装命令与附件哈希', () => {
    const lines = installSection({
      repo: 'alicia1030su/dsh-ai-debate',
      version: '0.3.0-rc.1',
      tarball: 'dsh-ai-debate-0.3.0-rc.1.tgz',
      tarballSha256: 'a'.repeat(64),
      sourceZip: 'dsh-ai-debate-source-0.3.0-rc.1.zip',
      sourceZipSha256: 'b'.repeat(64),
    }).join('\n')

    assert.match(lines, /github:alicia1030su\/dsh-ai-debate#v0\.3\.0-rc\.1/)
    assert.match(lines, /dsh-ai-debate-0\.3\.0-rc\.1\.tgz/)
    assert.match(lines, /dsh-ai-debate-source-0\.3\.0-rc\.1\.zip/)
  })

  it('成功报告在 rc 版本上仍然自洽', () => {
    const report = createStatusReport({ version: '0.3.0-rc.1' }) as unknown as Record<string, any>
    report.status = 'success'
    report.stage = 'done'
    report.github.commitSha = 'c'.repeat(40)
    report.github.tag = 'v0.3.0-rc.1'
    report.artifacts = [
      { name: 'a.tgz', bytes: 1, sha256: 'd'.repeat(64), kind: 'install' },
    ]
    report.tests = { total: 10, passed: 10, failed: 0 }
    assert.equal(report.schema, STATUS_SCHEMA)

    // 不应抛异常：rc 是合法的发布版本。
    assert.doesNotThrow(() => assertReportConsistent(report))
  })

  it('坏版本号仍然让报告不自洽', () => {
    const report = createStatusReport({ version: '0.3.0-rc.1' }) as unknown as Record<string, any>
    report.status = 'success'
    report.stage = 'done'
    report.github.commitSha = 'c'.repeat(40)
    report.github.tag = 'v0.3.0-rc.1'
    report.artifacts = [{ name: 'a.tgz', bytes: 1, sha256: 'd'.repeat(64), kind: 'install' }]
    report.tests = { total: 1, passed: 1, failed: 0 }
    report.version = '0.3.0.1'

    assert.throws(() => assertReportConsistent(report), /version 不是合法版本号/)
  })
})
