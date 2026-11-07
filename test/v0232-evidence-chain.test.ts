/**
 * v0.2.32 §六：发布证据链。
 *
 * ## 上一轮反复出错的到底是什么
 *
 * 不是「忘了写 SHA」，而是**三个不同的东西共用了同一个词**：
 *
 *   1. 我测的是哪一份代码？（提交 / 树）
 *   2. 现在分支上最新的是哪一份？（会变）
 *   3. 发出去的包里是什么？（哈希）
 *
 * 前两轮把它们都叫 `commitSha`，于是出现两种错误：
 *
 * - 交付记录里写 `47ebcee`，而分支头是 `5d7b523`——记录的是**上一版的合并提交**；
 * - 报告里写死 PR 头提交号，改一次报告它就前进一次，永远写不准。
 *
 * 这个文件把三者分开：
 *
 * - `testedTreeSha`：不可变，绑在证据里；
 * - `finalCodeTreeSha`：可算，用代码树，不用提交号（合并产生新提交但内容没变时
 *   不该逼人重跑）；
 * - `packageSha256`：算出来，可核对。
 *
 * ## 还有一条硬规则：**不许改证据去迁就记录**
 *
 * 如果证据里的树与最终代码不一致，正确做法是重跑验收，不是把证据里的旧值
 * 改成新值。所以这里提供的是**判定**，不是**修正**：`bindingVerdict()` 只回答
 * 「这两份是不是同一份代码」，不写任何东西。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EvidenceCollector } from './gui/evidence.ts'

/** 工作树根（这个文件在 `test/` 下，所以往上一级）。 */
const repoRoot = join(import.meta.dirname, '..')

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false }).trim()
}

test('证据里记的是**代码树**，不只是提交号', () => {
  const head = EvidenceCollector.headOf(repoRoot)
  assert.match(head.sha, /^[0-9a-f]{40}$/, `HEAD 应当是一个提交号，实际 ${head.sha}`)
  assert.match(head.tree, /^[0-9a-f]{40}$/, `tree 应当是一个树号，实际 ${head.tree}`)

  // 与 git 自己算的对一遍——不自证
  assert.equal(head.sha, git('rev-parse', 'HEAD'))
  assert.equal(head.tree, git('rev-parse', 'HEAD^{tree}'))
})

test('同一个代码树可以有多个提交：树号相同即代表内容相同', () => {
  /**
   * 这条解释的是**为什么必须用树号对齐**。
   *
   * `git commit --allow-empty` 产生了一个新提交，但代码树一模一样。
   * 如果发布链路用提交号比对，这种情况会被判成「必须重跑验收」——
   * 而实际上一个字节都没变。
   */
  const dir = mkdtempSync(join(tmpdir(), 'v0232-tree-'))
  const run = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).trim()

  run('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
  run('add', '-A')
  run('commit', '-q', '-m', 'first')

  const before = EvidenceCollector.headOf(dir)
  run('commit', '-q', '--allow-empty', '-m', 'empty commit')
  const after = EvidenceCollector.headOf(dir)

  assert.notEqual(after.sha, before.sha, '提交号必须变')
  assert.equal(after.tree, before.tree, '代码树不该变——这正是「用树对齐」的意义')
})

test('一次证据必须同时说清「测了什么代码」与「用什么脚本测的」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v0232-evidence-'))
  const startedAt = '2026-11-07T00:00:00.000Z'
  const collector = new EvidenceCollector({
    script: 'demo.ts',
    scriptVersion: '2026-11-07.1',
    pageUrl: 'dsh-app://app/',
    cdpPort: 9000,
    appPort: 9001,
    startedAt,
  })

  const bundle = collector.finish({
    outDir: dir,
    cwd: repoRoot,
    stages: [
      { name: '甲', status: 'passed' },
      { name: '乙', status: 'passed' },
    ],
  })

  assert.match(bundle.testedTreeSha, /^[0-9a-f]{40}$/, '证据里必须有树号')
  assert.equal(bundle.testSuite.script, 'demo.ts')
  assert.equal(bundle.testSuite.scriptVersion, '2026-11-07.1')
  assert.equal(bundle.startedAt, startedAt, '开始时间由调用方给，不能自己偷偷记')
  assert.ok(Date.parse(bundle.endedAt) >= Date.parse(startedAt), '结束时间不能早于开始时间')

  // 兼容字段仍然在：老的报告读取路径不该因为这次改动就断
  assert.equal(bundle.script, 'demo.ts')
  assert.equal(bundle.scriptVersion, '2026-11-07.1')
})

test('有 skipped 时证据必须点名是哪几条：「跳过」不算通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v0232-evidence-'))
  const collector = new EvidenceCollector({
    script: 'demo.ts',
    scriptVersion: '2026-11-07.1',
    pageUrl: 'dsh-app://app/',
    cdpPort: 9000,
    appPort: 9001,
    startedAt: new Date().toISOString(),
  })

  const bundle = collector.finish({
    outDir: dir,
    cwd: repoRoot,
    stages: [
      { name: '甲', status: 'passed' },
      { name: '乙', status: 'skipped' },
      { name: '丙', status: 'skipped' },
    ],
  })

  assert.equal(bundle.stages.skipped, 2)
  assert.deepEqual(bundle.skippedReasons, ['乙', '丙'], '必须点名，而不是只给一个数字')
})

/**
 * 证据绑定判定。
 *
 * 这不是产品代码，是**核对规则的最小实现**：报告与脚本共用同一套判断，
 * 免得「报告里说一致、脚本里说重跑」。
 */
function bindingVerdict(input: {
  readonly testedCodeSha: string
  readonly finalCodeSha: string
  readonly headDirty: boolean
}): { readonly ok: boolean; readonly why: string } {
  if (input.headDirty) {
    return { ok: false, why: '验收时工作树是脏的：跑的代码不在任何提交里，无法核对' }
  }
  if (input.testedCodeSha !== input.finalCodeSha) {
    return {
      ok: false,
      why: `要发的代码变了（测的是 ${input.testedCodeSha.slice(0, 8)}，最终是 ${input.finalCodeSha.slice(0, 8)}）：必须重跑`,
    }
  }
  return { ok: true, why: '要发的代码与验收时一致' }
}

test('绑定判定：工作树脏时一律不一致（跑的代码不在任何提交里）', () => {
  const dirty = bindingVerdict({ testedCodeSha: 'a'.repeat(40), finalCodeSha: 'a'.repeat(40), headDirty: true })
  assert.equal(dirty.ok, false, '工作树脏时必须判不一致')
  assert.match(dirty.why, /脏|不在任何提交/, '理由要能让人知道该做什么')
})

test('打包产物的哈希可复算：同一条命令两次算同一个值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v0232-sha-'))
  const file = join(dir, 'artifact.tgz')
  writeFileSync(file, 'pretend this is a tarball\n', 'utf8')

  const sha = (path: string): string => {
    const hash = createHash('sha256')
    hash.update(execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}))`], {
      encoding: 'buffer',
      shell: false,
    }))
    return hash.digest('hex')
  }

  const first = sha(file)
  const second = sha(file)
  assert.equal(first, second, '同一个文件两次哈希必须相同')
  assert.match(first, /^[0-9a-f]{64}$/)
})

test('代码指纹只看运行时会变的文件：改文档不动它，改 src 一定动它', () => {
  /**
   * ## 这一条解决的是自引用循环
   *
   * 用整棵树当判定标准时，写验收报告本身就会让树变——于是刚跑完的证据立刻
   * 「过期」，重跑一次再写报告又过期。任务书把这叫「交付记录形成自我引用的循环」。
   *
   * 代码指纹只覆盖 `src`/`client`/`lib`/`package.json`：
   * 文档、测试、脚本怎么改都不动它。判定问的是「要发的代码被跑过没有」，
   * 不是「工作区一个字节都没动过」。
   */
  const dir = mkdtempSync(join(tmpdir(), 'v0232-codesha-'))
  const run = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).trim()

  run('init', '-q')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  writeFileSync(join(dir, 'package.json'), '{}\n', 'utf8')
  writeFileSync(join(dir, 'README.md'), '# one\n', 'utf8')
  run('add', '-A')
  run('commit', '-q', '-m', 'base')

  const base = EvidenceCollector.codeShaOf(dir)
  // 树号要用**这个临时仓库**的，不能用外层仓库的辅助函数
  const treeOf = (): string => run('rev-parse', 'HEAD^{tree}')
  const baseTree = treeOf()

  // 只改文档
  writeFileSync(join(dir, 'README.md'), '# two\n', 'utf8')
  run('add', '-A')
  run('commit', '-q', '-m', 'docs only')
  assert.equal(
    EvidenceCollector.codeShaOf(dir),
    base,
    '只改文档时代码指纹不能变——否则「写完报告证据就过期」的循环无法打破',
  )
  assert.notEqual(treeOf(), baseTree, '整棵树确实变了')

  // 改 src
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n', 'utf8')
  run('add', '-A')
  run('commit', '-q', '-m', 'code change')
  assert.notEqual(EvidenceCollector.codeShaOf(dir), base, '改 src 之后代码指纹必须变')
})

test('代码指纹可指定历史 revision：两份证据能互相比', () => {
  /**
   * 验收跑在提交 A，之后又有提交 B。要回答「B 有没有动过代码」，
   * 就得能分别算出两者——只算 `HEAD` 的接口做不到这件事。
   */
  const first = EvidenceCollector.codeShaOf(repoRoot, 'HEAD')
  assert.match(first, /^[0-9a-f]{40}$/)
  assert.equal(EvidenceCollector.codeShaOf(repoRoot, 'HEAD'), first, '同一 revision 两次必须相同')
})

test('判定改用代码指纹：文档改动不要求重跑，代码改动要求重跑', () => {
  const same = bindingVerdict({ testedCodeSha: 'a'.repeat(40), finalCodeSha: 'a'.repeat(40), headDirty: false })
  assert.equal(same.ok, true)

  const docDrift = bindingVerdict({ testedCodeSha: 'a'.repeat(40), finalCodeSha: 'a'.repeat(40), headDirty: false })
  assert.equal(docDrift.ok, true, '代码没变就不必重跑，哪怕整棵树变了')

  const codeDrift = bindingVerdict({ testedCodeSha: 'a'.repeat(40), finalCodeSha: 'b'.repeat(40), headDirty: false })
  assert.equal(codeDrift.ok, false, '代码变了必须重跑')
  assert.match(codeDrift.why, /重跑/)
})
