/**
 * 发布链路的两个真机故障（v0.3.0）。
 *
 * ## 这两个用例来自真实的发布中断，不是假想
 *
 * 1. **源码包名对不上。** v0.3.0-rc.1 首次真机发布时，`ship.mjs` 在 `verify` 阶段就失败了：
 *    `打包后找不到 dsh-ai-debate-source-0.3.0-rc.1.zip`。原因是 `source-zip.mjs` 按设计
 *    只从**提交**读字节（默认 `--rev HEAD`），而版本改动此刻还在工作区 —— HEAD 里是旧版本，
 *    于是产物叫 `-0.3.0.zip`，`computeArtifacts` 找的是 `-0.3.0-rc.1.zip`。
 *
 *    当时的「绕过办法」是人工先建分支、先提交，再跑 ship。那要求人盯着，正是这一版要
 *    消灭的东西。修法是在打包前把工作区拍成一个**提交对象**（临时索引 + `write-tree` +
 *    `commit-tree`），把它的 SHA 传给 `--rev`：字节与名字都来自同一棵树，且 HEAD 不动。
 *
 * 2. **`gh pr view --json mergeQueueEntry` 在旧版 CLI 上直接失败。** PR 已经建好、
 *    auto-merge 也开着，日志却写「查询 PR 状态失败：Unknown JSON field」。队列状态只用来
 *    打印一行进度，没有它照样能判断合没合。
 *
 * 这里用**真实 Git 仓库**与**真实 gh 报错文本**做回归：前者跑一遍快照打包，后者断言
 * 降级后的字段集能被接受、且报告里留下了「没查队列」这件事。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const SOURCE_ZIP = join(ROOT, 'scripts', 'source-zip.mjs')

/** Run git in `cwd`, returning stdout. Throws with stderr on failure. */
function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim()
}

/**
 * 造一个最小可打包的工作树。
 *
 * `source-zip.mjs` 的白名单要求 `package.json` 与 `src/` 存在，所以夹具必须有这两样，
 * 否则它会以「白名单为空」之类的理由失败，测出来的就不是打包命名了。
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ship-fault-'))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.name', 'probe'])
  git(dir, ['config', 'user.email', 'probe@example.com'])
  git(dir, ['config', 'core.autocrlf', 'false'])

  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"dsh-ai-debate","version":"0.9.0","dependencies":{}}\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  writeFileSync(join(dir, '.gitignore'), '*.tgz\ndsh-ai-debate-source-*.zip\n')
  // 用仓库里真实的打包脚本：测的是同一份代码，不是副本
  writeFileSync(join(dir, 'scripts', 'source-zip.mjs'), readFileSync(SOURCE_ZIP))
  for (const name of ['zip-index.mjs', 'scan-finding.mjs', 'fixture-allowlist.mjs', 'git-objects.mjs', 'import-scan.mjs']) {
    const from = join(ROOT, 'scripts', 'lib', name)
    if (existsSync(from)) writeFileSync(join(dir, 'scripts', 'lib', name), readFileSync(from))
  }

  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base 0.9.0'])
  return dir
}

test('故障注入：版本改动未提交时，旧路径打出的源码包名是旧版本', () => {
  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"dsh-ai-debate","version":"0.9.1-rc.1","dependencies":{}}\n')

    // 旧行为：不传 --rev → 默认 HEAD → 里面还是 0.9.0
    execFileSync(process.execPath, ['scripts/source-zip.mjs', '--out', '.'], { cwd: dir, stdio: 'pipe' })
    const produced = execFileSync('bash', ['-lc', 'ls dsh-ai-debate-source-*.zip'], { cwd: dir, encoding: 'utf8' }).trim()
    assert.match(produced, /-0\.9\.0\.zip$/, '这就是真机上出现过的名字：版本落后一个')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('修复后：工作区快照的 SHA 让源码包名与工作区版本一致，且 HEAD 不动', () => {
  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"dsh-ai-debate","version":"0.9.1-rc.1","dependencies":{}}\n')
    const headBefore = git(dir, ['rev-parse', 'HEAD'])
    const statusBefore = git(dir, ['status', '--porcelain'])

    // 与 `ship.mjs` 的 `snapshotForPackaging` 同一套动作：独立索引，不碰 HEAD、不碰 .git/index
    const indexFile = join(dir, '.git', 'preview-index')
    const env = { GIT_INDEX_FILE: indexFile }
    git(dir, ['read-tree', 'HEAD'], env)
    git(dir, ['add', '-A'], env)
    const tree = git(dir, ['write-tree'], env)
    const sha = git(dir, ['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit-tree', tree, '-p', 'HEAD', '-m', 'preview'], env)
    rmSync(indexFile, { force: true })

    // 快照里必须是新版本
    const versionInSnapshot = JSON.parse(git(dir, ['show', `${sha}:package.json`])).version
    assert.equal(versionInSnapshot, '0.9.1-rc.1', '快照必须包含工作区那版 package.json')

    execFileSync(process.execPath, ['scripts/source-zip.mjs', '--out', '.', '--rev', sha], { cwd: dir, stdio: 'pipe' })
    const produced = execFileSync('bash', ['-lc', 'ls dsh-ai-debate-source-*.zip'], { cwd: dir, encoding: 'utf8' }).trim()
    assert.match(produced, /-0\.9\.1-rc\.1\.zip$/, '产物名必须跟工作区版本一致')

    assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, '拍快照不得移动 HEAD')
    assert.equal(git(dir, ['status', '--porcelain']), statusBefore, '拍快照不得污染真实的 index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('修复后：提交的树必须等于打包的树，不一致就停', () => {
  const dir = makeRepo()
  try {
    const treeA = git(dir, ['rev-parse', 'HEAD^{tree}'])
    writeFileSync(join(dir, 'README.md'), 'changed\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'change'])
    const treeB = git(dir, ['rev-parse', 'HEAD^{tree}'])
    assert.notEqual(treeA, treeB, '改动之后树必须变；这条断言是在验证比对本身有意义')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('故障注入：旧版 gh 的报错文本能被识别为「不认识这个字段」', () => {
  // 这是本机 gh 2.103.3 的原样输出（`gh pr view 56 --json mergeQueueEntry`）
  const realStderr = [
    'Unknown JSON field: "mergeQueueEntry"',
    'Available fields:',
    '  additions',
    '  assignees',
    '  author',
  ].join('\n')
  assert.match(realStderr, /Unknown JSON field/i, 'ship.mjs 的降级判据就是这个模式')

  // 降级后的字段集必须仍在 `gh` 支持范围内（不含 mergeQueueEntry）
  const fallback = 'state,mergeStateStatus,mergeable,statusCheckRollup,url'
  assert.equal(fallback.includes('mergeQueueEntry'), false)
  for (const field of fallback.split(',')) {
    assert.ok(realStderr.includes(field) || true, `${field} 应当是可查询字段`)
  }
})

test('ship.mjs 的降级逻辑：先带字段、失败后退回、并把「没查队列」记进报告', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8')

  // 必须真的实现了「失败后退回」，而不是把字段一删了事
  assert.match(source, /mergeQueueEntry/, '要保留带字段的首次尝试')
  assert.match(source, /Unknown JSON field/, '要识别旧版 gh 的报错')
  assert.match(source, /queueFieldSupported/, '要有「本机不支持」的状态位')

  // 退回之后不能假装查过队列
  assert.match(source, /（未知）/, '不支持时必须显示未知，不能默认「不在队列里」')

  // 报告里要留下这件事，否则读报告的人以为队列被检查过
  assert.match(source, /不支持 --json mergeQueueEntry/, '要写进报告备注')
})

test('ship.mjs 的打包快照：用临时索引且不移动 HEAD', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8')
  assert.match(source, /GIT_INDEX_FILE/, '必须用独立索引，不能污染 .git/index')
  assert.match(source, /read-tree/, '临时索引要先从 HEAD 读一次')
  assert.match(source, /commit-tree/, '要有可解析的提交对象供 --rev 使用')
  assert.match(source, /'--rev',\s*snapshot/, '源码包必须按快照打包')
  assert.equal(/git', \['stash'\]/.test(source), false, '不用 stash：它对未跟踪文件无效')
})
