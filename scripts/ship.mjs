#!/usr/bin/env node
/**
 * 统一的交付入口：一条命令走完「分支 → 验证 → 提交 → 推送 → PR → 自动合并 → 标签 → Release → 核验」。
 *
 * ## 这个脚本存在的原因
 *
 * v0.2.16 的交付是靠一段一次性的对话脚本拼出来的：手工建分支、手工镜像同步、手工算差异、
 * 手工打标签。它成功过，但每一步的「为什么这么做」只存在于那次对话里。下一次要复用，只能
 * 重新读一遍对话记录 —— 那不是流水线，那是一次性的手艺。
 *
 * 所以这里把流程写成代码。要求它有两条容易被忽略的性质：
 *
 * 1. **幂等**：跑第二次不能变成两件事。分支、PR、标签、Release 都只能有一个，
 *    判断依据来自远端事实（`git ls-remote`、`gh pr list`、`gh release view`），
 *    不来自本地状态文件里「我以为做过了」。
 * 2. **可恢复**：中断在任意一步，重跑能从那里接着走，而不是从头再来一遍副作用。
 *    状态写在 `.ship/state.json`，每个阶段转移都落盘。
 *
 * ## 它会停下来等人的地方
 *
 * 任务书 §四 要求：涉及权限策略、Actions 写权限、凭据存储、认证方式、安全边界或真实平台
 * 自动发帖的改动，必须先出 PR 再停。判断规则在 `scripts/lib/ship-core.mjs` 的
 * `classifySensitive()`，这里只负责执行「停」这个动作 —— PR 照建、CI 照跑，只是不开自动合并。
 *
 * ## 它绝对不做的事
 *
 * - 不用 `--admin` 绕过检查（有测试盯着这一条）
 * - 不移动已存在的标签
 * - 不覆盖已存在的 Release
 * - 不把失败报告成成功
 *
 * 用法：
 *   node scripts/ship.mjs                    # 走完整流程
 *   node scripts/ship.mjs --dry-run          # 只做本地验证，不碰远端
 *   node scripts/ship.mjs --resume           # 从状态文件记录的阶段继续
 *   node scripts/ship.mjs --status           # 打印当前状态与状态报告路径
 *   node scripts/ship.mjs --slug archive-fix # 自定义分支后缀
 *   node scripts/ship.mjs --skip-tests       # 跳过测试（只用于演练异常路径）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  STAGE_LABELS,
  RECOVERY,
  advanceState,
  branchForVersion,
  classifySensitive,
  createShipState,
  decideRelease,
  decideTag,
  nextStep,
  restoreState,
  tagForVersion,
} from './lib/ship-core.mjs'
import {
  artifactOf,
  assertReportConsistent,
  createStatusReport,
  parseTestSummary,
  statusFileName,
} from './lib/delivery-status.mjs'

const root = process.cwd()
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback = null) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const DRY_RUN = has('--dry-run')
const RESUME = has('--resume')
const STATUS_ONLY = has('--status')
const SKIP_TESTS = has('--skip-tests')
const SLUG = valueOf('--slug', 'auto')
const OVERRIDE_VERSION = valueOf('--version')

/** 检查/等待的轮询间隔与总时限。给人看的数字，改这里就够了。 */
const POLL_INTERVAL_MS = Number(process.env.SHIP_POLL_MS ?? 15000)
const WAIT_TIMEOUT_MS = Number(process.env.SHIP_WAIT_MS ?? 45 * 60 * 1000)

const stateDir = join(root, '.ship')
const statePath = join(stateDir, 'state.json')

// --- 小工具 ---------------------------------------------------------------

/**
 * 跑一个外部命令，返回结果而不是抛异常。
 *
 * 抛异常的写法会让「命令失败」和「脚本自己崩了」长得一样，而这两件事的恢复建议完全不同。
 */
function run(command, commandArgs, options = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      cwd: options.cwd ?? root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    }
  }
}

/**
 * 解析 gh 的输出。
 *
 * `gh` 在 Windows 下的输出可能是 UTF-16LE（本仓库踩过好几次：`gh run view --json`、
 * `gh ... --jq` 都中过），所以先看 BOM 再决定怎么解 —— 直接 `JSON.parse` 会得到
 * `Unexpected token '\u0000'` 之类完全看不出原因的错。
 */
function decodeCommandOutput(text) {
  const raw = String(text ?? '')
  if (raw.startsWith('\uFEFF')) return raw.slice(1)
  // UTF-16LE 被按 UTF-8 读时，每个 ASCII 字符后面会跟一个 NUL，特征很明显。
  if (raw.length > 2 && raw[1] === '\u0000') {
    return Buffer.from(raw, 'utf8').toString('utf16le')
  }
  return raw
}

function parseJson(text, fallback) {
  const decoded = decodeCommandOutput(text).trim()
  if (decoded === '') {
    if (fallback !== undefined) return fallback
    throw new StageFailure('wait_checks', '期望 JSON 输出，实际为空')
  }
  try {
    return JSON.parse(decoded.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (fallback !== undefined) return fallback
    throw new StageFailure('wait_checks', `解析 gh 输出失败：${error.message}`)
  }
}

function parseJsonArray(text) {
  const value = parseJson(text, [])
  return Array.isArray(value) ? value : []
}

/**
 * ruleset 的 `conditions.ref_name.include` 是否覆盖某个分支。
 *
 * 只需要认三种情况：空（等于全部）、`~DEFAULT_BRANCH`、以及字面分支名。
 * 用 `**` 之类通配的 ruleset 会被判为不覆盖而不是默认覆盖 —— 宁可停下来问人，
 * 也不要把「我不确定它管不管 main」当成「它管」。
 */
function refMatches(conditions, branch) {
  const include = conditions?.ref_name?.include
  if (include === null || include === undefined) return true
  if (!Array.isArray(include) || include.length === 0) return true
  return include.some((pattern) => pattern === branch || pattern === '~DEFAULT_BRANCH' || pattern === '~ALL')
}

/** 失败即退出：带阶段名、原因与恢复建议，然后写状态报告。 */
class StageFailure extends Error {
  constructor(stage, reason, extra = {}) {
    super(reason)
    this.stage = stage
    this.reason = reason
    this.extra = extra
  }
}

function log(message) {
  console.log(`[ship] ${message}`)
}

function step(stage, message) {
  console.log(`\n[ship] ── ${STAGE_LABELS[stage] ?? stage} ── ${message}`)
}

/** 原子写：先写临时文件再改名，中断时读者看到的要么是旧的完整文件，要么是新的。 */
function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// --- 状态与报告 -----------------------------------------------------------

let state = null
let report = null

function saveState() {
  // 状态文件同时是「这一次交付已经证明了什么」的记录，所以测试计数与产物必须一起落盘。
  // 第一版没有同步这两项：`--resume` 跳过验证阶段后 `report.tests` 还是空骨架，
  // 最后那份交付状态报告即使发布成功也会被自洽检查判成「测试数为 0」—— 一次成功的
  // 真机发布，就这样被自己的报告判成失败。
  if (report !== null && report.tests !== null) state.tests = report.tests
  if (report !== null && report.artifacts.length > 0) state.artifacts = report.artifacts
  writeJsonAtomic(statePath, state)
  writeJsonAtomic(join(stateDir, statusFileName(state.version)), report)
}

function loadState(version) {
  if (!existsSync(statePath)) return null
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    return restoreState(raw, { version })
  } catch {
    // 状态文件坏了不该让流水线瘫掉：当成「没有状态」从预检开始，是安全的方向。
    return null
  }
}

/** 记录一次阶段失败。写报告是唯一的「汇报」动作，终端输出只是它的摘要。 */
function fail(stage, reason, recovery = RECOVERY[stage] ?? []) {
  throw new StageFailure(stage, reason, { recovery })
}

// --- 预检 -----------------------------------------------------------------

function preflight() {
  step('preflight', '读取版本、确认工具与远端')

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = OVERRIDE_VERSION ?? pkg.version
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail('preflight', `package.json 的 version 不是三段数字：${version}`)
  }

  const gitVersion = run('git', ['--version'])
  if (gitVersion.code !== 0) fail('preflight', '找不到 git 命令：确认 git 已安装且在 PATH 里')

  const ghVersion = run('gh', ['--version'])
  if (ghVersion.code !== 0) fail('preflight', '找不到 gh 命令：确认 GitHub CLI 已安装且在 PATH 里')

  const auth = run('gh', ['auth', 'status'])
  if (auth.code !== 0) {
    fail('preflight', 'gh 未登录。请在浏览器完成 gh auth login 后再跑，不要把 Token 交给脚本。')
  }

  const repoView = run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])
  if (repoView.code !== 0) fail('preflight', `读不到远端仓库信息：${repoView.stderr.trim()}`)
  const repoInfo = parseJson(repoView.stdout)
  const repo = repoInfo.nameWithOwner
  const defaultBranch = repoInfo.defaultBranchRef?.name ?? 'main'

  const currentBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const headSha = run('git', ['rev-parse', 'HEAD'])

  state = createShipState({ version })
  report = createStatusReport({ version })
  report.github.repo = repo
  report.github.baseSha = headSha.code === 0 ? headSha.stdout.trim() : null
  report.github.branch = currentBranch.code === 0 ? currentBranch.stdout.trim() : null
  report.stage = 'preflight'
  report.notes.push(`默认分支：${defaultBranch}`)

  log(`版本 ${version}，仓库 ${repo}，默认分支 ${defaultBranch}`)

  return { version, repo, defaultBranch }
}

// --- 本地验证 -------------------------------------------------------------

/**
 * 跑一套完整的本地验证。
 *
 * 顺序是有讲究的：先编译（最快的失败），再类型检查，再测试，最后打包与扫描。
 * 把最可能失败的放前面，是为了让人在一分钟内知道坏在哪，而不是等测试跑完再说。
 */
function verify(version) {
  step('verify', '编译、类型检查、全部测试、凭据扫描、打包与归档校验')

  const tsc = run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'])
  if (tsc.code !== 0) fail('verify', `编译失败：\n${tsc.stdout}${tsc.stderr}`)

  // 测试代码的类型检查走棘轮脚本，不是裸 tsc。
  //
  // 原来这里是 `tsc -p tsconfig.test.json`，和 ci.yml 犯的是同一个错：那份配置曾继承了基配置
  // 的 `exclude`，`include` 加不回来，于是它「编译成功」但一个测试文件都没检查。修好之后
  // 露出 316 条历史类型错误（mock 与真实类型的结构性偏差），一次性清零不现实、关掉闸门
  // 等于回到绿得毫无意义 —— 所以记基线、只许变少。这里必须调同一个脚本，
  // 否则本机声明「类型检查通过」而 CI 走的是另一套规则。
  const typecheck = run(process.execPath, [join(root, 'scripts', 'test-typecheck.mjs')])
  if (typecheck.code !== 0) fail('verify', `类型检查失败：\n${typecheck.stdout}${typecheck.stderr}`)
  report.checks.typecheck = true

  if (SKIP_TESTS) {
    report.notes.push('跳过了测试（--skip-tests）：本次运行不能作为发布依据')
    report.unverified.push('全部自动化测试（--skip-tests）')
  } else {
    runTests()
  }

  // 打包前先删旧产物：留着上一次的 tgz 会让「这次真的生成了吗」变成一个无法回答的问题。
  const tarball = `dsh-ai-debate-${version}.tgz`
  const sourceZip = `dsh-ai-debate-source-${version}.zip`
  for (const name of [tarball, sourceZip]) {
    const path = join(root, name)
    if (existsSync(path)) rmSync(path, { force: true })
  }

  const pack = run(process.execPath, ['scripts/pack.mjs'])
  if (pack.code !== 0) fail('verify', `打包失败：\n${pack.stdout}${pack.stderr}`)
  const zip = run(process.execPath, ['scripts/source-zip.mjs', '--out', '.'])
  if (zip.code !== 0) fail('verify', `生成源码包失败：\n${zip.stdout}${zip.stderr}`)

  // 凭据扫描必须在打包之后：`audit-leaks.mjs` 检查的是**磁盘上的 tgz 与工作树**。
  // 升版本号之后新 tgz 还没生成，它会直接 ENOENT。第一版把这一步放在打包前面，
  // 因为当时工作区里恰好留着上一版的 tgz，所以没暴露 —— 换个版本号就立刻失败。
  // 这也是「顺序」本身的 bug：扫一个还不存在的产物，本来就不该算通过。
  const leaks = run(process.execPath, ['scripts/audit-leaks.mjs'])
  if (leaks.code !== 0) {
    report.checks.leakScan = false
    fail('verify', `凭据扫描命中：\n${leaks.stdout}${leaks.stderr}`)
  }
  report.checks.leakScan = true

  for (const name of [tarball, sourceZip]) {
    const path = join(root, name)
    if (!existsSync(path)) fail('verify', `打包后找不到 ${name}`)

    // 扫描用的是独立规则的那一份，不是打包脚本自己的自检。
    const scan = run(process.execPath, ['scripts/scan-archive.mjs', name])
    if (scan.code !== 0) {
      if (name === tarball) report.checks.installArchive = false
      else report.checks.sourceArchive = false
      fail('verify', `${name} 扫描未通过：\n${scan.stdout}${scan.stderr}`)
    }
    if (name === tarball) report.checks.installArchive = true
    else report.checks.sourceArchive = true
  }

  const guard = run(process.execPath, ['scripts/ci-guard.mjs', '--require-archive'])
  if (guard.code !== 0) fail('verify', `CI 守卫未通过：\n${guard.stdout}${guard.stderr}`)

  const versionCheck = run(process.execPath, ['scripts/version.mjs', 'check'])
  if (versionCheck.code !== 0) {
    fail('verify', `版本一致性未通过：\n${versionCheck.stdout}${versionCheck.stderr}`)
  }

  // 哈希必须现读磁盘算，不能抄打包脚本的输出 —— 抄来的是「它以为写对了」。
  report.artifacts = computeArtifacts(version).artifacts
  log(
    `产物：${tarball} ${report.artifacts[0].sha256.slice(0, 12)}… / ${sourceZip} ${report.artifacts[1].sha256.slice(0, 12)}…`,
  )
}

/**
 * 跑全部自动化测试，并把真实计数记进报告。
 *
 * 单独抽出来是为了 `--resume`：状态文件里没有测试计数时（老版本写的状态文件、
 * 或者上一轮根本没跑到验证），续跑必须**真的跑一遍**再填。猜一个数字、或者把
 * 「没重跑」写成「没跑过」，都会让最后那份交付报告变成假证据。
 */
function runTests() {
  const tests = run(process.execPath, ['--experimental-transform-types', '--test', 'test/**/*.test.ts'])
  const summary = parseTestSummary(`${tests.stdout}\n${tests.stderr}`)
  if (tests.code !== 0) {
    report.checks.tests = false
    report.tests = summary
    fail('verify', `测试失败（${summary.failed ?? '?'} 项）\n${tailLines(tests.stdout, 40)}`)
  }
  if (!summary.consistent || summary.total === 0) {
    fail('verify', `测试汇总不自洽：${JSON.stringify(summary)}。零测试跑完也算通过，所以这里直接判失败。`)
  }
  report.checks.tests = true
  report.tests = {
    files: readdirSync(join(root, 'test')).filter((name) => name.endsWith('.test.ts')).length,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
  }
  log(`测试 ${summary.total} 项通过（跳过 ${summary.skipped} 项）`)
}

/**
 * 现读磁盘算出两个产物的字节数与哈希。
 *
 * `--resume` 会跳过验证阶段，如果这里不重新算一遍，`report.artifacts` 就是空的，
 * 后面的附件核验会对一个空列表循环、然后「通过」—— 一个空列表永远满足「每个附件都对得上」。
 */
function computeArtifacts(version) {
  const tarball = `dsh-ai-debate-${version}.tgz`
  const sourceZip = `dsh-ai-debate-source-${version}.zip`

  const entries = []
  const missing = []
  for (const [name, kind] of [
    [tarball, 'install'],
    [sourceZip, 'source'],
  ]) {
    const absolute = join(root, name)
    if (!existsSync(absolute)) {
      missing.push(name)
      continue
    }
    entries.push(artifactOf({ name, bytes: statSync(absolute).size, sha256: sha256File(absolute), kind }))
  }

  return { artifacts: entries, missing }
}

function tailLines(text, count) {
  const lines = String(text).trim().split(/\r?\n/)
  return lines.slice(-count).join('\n')
}

// --- Git 阶段 -------------------------------------------------------------

/**
 * 收集相对某个 base 的全部改动，供敏感判定使用。
 *
 * 这里有个容易漏的地方：`git diff` **不包含未跟踪文件**。于是「新建一个
 * `.github/workflows/*.yml`」或「新建 `src/security/xxx.ts`」会被判成不敏感，
 * 自动合并上去 —— 而这恰好是最该拦的一类改动。所以未跟踪文件单独列出来，
 * 当成整文件新增。
 */
function collectChanges(base) {
  const names = run('git', ['diff', '--name-only', base])
  if (names.code !== 0) return []
  const tracked = names.stdout.trim().split(/\r?\n/).filter(Boolean)

  const others = run('git', ['ls-files', '--others', '--exclude-standard'])
  const untracked = others.code === 0 ? others.stdout.trim().split(/\r?\n/).filter(Boolean) : []

  const normalize = (path) => path.split('\\').join('/')

  const changes = tracked.map((path) => {
    const diff = run('git', ['diff', base, '--', path])
    const lines = diff.stdout.split(/\r?\n/)
    return {
      path: normalize(path),
      addedLines: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')),
      removedLines: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')),
    }
  })

  for (const path of untracked) {
    let addedLines = null
    try {
      const absolute = join(root, path)
      // 大文件与二进制不需要逐行读；判敏感性主要看路径，这里只是尽力而为。
      if (statSync(absolute).size <= 2 * 1024 * 1024) {
        addedLines = readFileSync(absolute, 'utf8')
          .split(/\r?\n/)
          .map((line) => `+${line}`)
      }
    } catch {
      addedLines = null
    }
    changes.push({ path: normalize(path), addedLines, removedLines: [] })
  }

  return changes
}

function ensureBranch(version, defaultBranch) {
  step('branch', `从最新 ${defaultBranch} 建功能分支`)

  const branch = branchForVersion(version, SLUG)

  const fetch = run('git', ['fetch', 'origin', '--prune'])
  if (fetch.code !== 0) fail('branch', `git fetch 失败：${fetch.stderr.trim()}`)

  const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const currentBranch = current.code === 0 ? current.stdout.trim() : ''

  if (currentBranch === branch) {
    log(`已在分支 ${branch}，复用`)
    return { branch }
  }

  // 分支已经存在（本机或远端）就切过去，不重建 —— 重建会丢掉上一轮已经推上去的提交。
  const localExists = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
  const remoteExists = run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch]).code === 0

  if (localExists) {
    const checkout = run('git', ['checkout', branch])
    if (checkout.code !== 0) fail('branch', `切换分支失败：${checkout.stderr.trim()}`)
    log(`本地已有分支 ${branch}，复用`)
  } else if (remoteExists) {
    const checkout = run('git', ['checkout', '-b', branch, `origin/${branch}`])
    if (checkout.code !== 0) fail('branch', `检出远端分支失败：${checkout.stderr.trim()}`)
    log(`远端已有分支 ${branch}，复用`)
  } else {
    const create = run('git', ['checkout', '-b', branch, `origin/${defaultBranch}`])
    if (create.code !== 0) fail('branch', `创建分支失败：${create.stderr.trim()}`)
    log(`已从 origin/${defaultBranch} 创建 ${branch}`)
  }

  return { branch }
}

function commitAll(version, branch) {
  step('commit', '提交本地改动')

  const status = run('git', ['status', '--porcelain'])
  const changed = status.stdout.trim().split(/\r?\n/).filter(Boolean)
  if (changed.length === 0) {
    log('没有需要提交的改动')
    return { committed: false }
  }

  const add = run('git', ['add', '-A'])
  if (add.code !== 0) fail('commit', `git add 失败：${add.stderr.trim()}`)

  // 提交前再看一眼暂存区：`git add -A` 之后发现暂存了不该提交的东西，比推上去再发现便宜得多。
  const staged = run('git', ['diff', '--cached', '--name-only'])
  const stagedPaths = staged.stdout.trim().split(/\r?\n/).filter(Boolean)
  const forbidden = stagedPaths.filter((path) =>
    /(^|\/)(\.env$|\.env\.local$|id_rsa|id_ed25519|\.netrc$|\.npmrc$|\.git-credentials$)/.test(path),
  )
  if (forbidden.length > 0) {
    fail('commit', `暂存区里有不该提交的凭据文件：${forbidden.join(', ')}`)
  }

  const message = `v${version}: ${SLUG === 'auto' ? '自动交付' : SLUG}`
  const commit = run('git', ['commit', '-m', message])
  if (commit.code !== 0) fail('commit', `git commit 失败：${commit.stdout}${commit.stderr}`)

  const sha = run('git', ['rev-parse', 'HEAD'])
  const head = sha.stdout.trim()
  log(`已提交 ${head.slice(0, 12)}（${changed.length} 个文件）`)
  return { committed: true, head }
}

function pushBranch(branch) {
  step('push', `推送 ${branch}`)

  const remoteBranch = run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch])
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim()

  if (remoteBranch.code === 0 && remoteBranch.stdout.trim().startsWith(head)) {
    log('远端分支已经指向同一提交，跳过推送')
    return
  }

  // 普通推送，永不 force：覆盖远端分支会丢掉别人（或上一轮）的提交。
  const push = run('git', ['push', '-u', 'origin', branch])
  if (push.code !== 0) fail('push', `推送失败：${push.stdout}${push.stderr}`)
  log('推送完成')
}

function ensurePullRequest(version, branch, defaultBranch) {
  step('pull_request', '创建或复用 PR')

  const existing = run('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,url,title,isDraft',
  ])
  if (existing.code !== 0) fail('pull_request', `查询 PR 失败：${existing.stderr.trim()}`)

  const open = parseJsonArray(existing.stdout)
  if (open.length > 0) {
    log(`已有 PR #${open[0].number}，复用`)
    return { number: open[0].number, url: open[0].url, state: 'OPEN', created: false }
  }

  // 续跑时会碰到 PR 已经被人工合并的情况。只看 `--state open` 会以为「没有 PR」，
  // 于是要么重建一个（对已合并的分支重建 PR 会失败），要么再拦一次人工授权 ——
  // 而人工合并本身就已经是那次授权，再要求一次等于让人永远卡在这一步。
  const merged = run('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,url,mergeCommit'])
  if (merged.code === 0) {
    const closed = parseJsonArray(merged.stdout)
    if (closed.length > 0) {
      log(`PR #${closed[0].number} 已被合并，跳过创建`)
      return {
        number: closed[0].number,
        url: closed[0].url,
        state: 'MERGED',
        mergeCommit: closed[0].mergeCommit?.oid ?? null,
        created: false,
      }
    }
  }

  const body = buildPullRequestBody(version)
  const create = run('gh', [
    'pr',
    'create',
    '--base',
    defaultBranch,
    '--head',
    branch,
    '--title',
    `v${version}: 自动交付`,
    '--body',
    body,
  ])
  if (create.code !== 0) fail('pull_request', `创建 PR 失败：${create.stdout}${create.stderr}`)

  const view = run('gh', ['pr', 'view', branch, '--json', 'number,url'])
  if (view.code !== 0) fail('pull_request', `PR 已创建但读不回编号：${view.stderr.trim()}`)
  const info = parseJson(view.stdout)
  log(`已创建 PR #${info.number}`)
  return { number: info.number, url: info.url, created: true }
}

function buildPullRequestBody(version) {
  const tests = report.tests?.total === null ? '未运行（--skip-tests）' : `${report.tests.passed ?? '?'}/${report.tests.total ?? '?'}`

  // 发布说明从 CHANGELOG 里截当前版本段落，和 Release 工作流用的是同一段内容。
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  const section = start === -1 ? [] : lines.slice(start + 1, lines.findIndex((line, index) => index > start && line.startsWith('## [')) === -1 ? undefined : lines.findIndex((line, index) => index > start && line.startsWith('## [')))

  const sensitive = classifySensitive(collectChanges('origin/main'))
  const riskLines =
    sensitive.reasons.length === 0
      ? ['本次变更不涉及权限策略、凭据规则或真实平台发表路径。']
      : ['本次变更触及以下需要人工确认的部分，因此不会自动合并：', ...sensitive.reasons.map((r) => `- \`${r.path}\`：${r.reason}`)]

  return [
    `## v${version}`,
    '',
    ...(section.length > 0 ? section.slice(0, 40) : ['（CHANGELOG 里没有该版本段落）']),
    '',
    '## 验证',
    '',
    `- 编译：通过`,
    `- 类型检查：通过`,
    `- 自动化测试：${tests}`,
    `- 凭据扫描：通过`,
    `- 安装包与源码包扫描：通过`,
    '',
    '## 风险',
    '',
    ...riskLines,
    '',
    '---',
    '',
    '本 PR 由 `scripts/ship.mjs` 生成。合并后会自动打标签并触发现有 Release 工作流。',
  ].join('\n')
}

function enableAutoMerge(prNumber) {
  step('auto_merge', `为 PR #${prNumber} 开启 squash 自动合并`)

  // 不开自动合并也不绕过检查：`--admin` 能强推合并，但那等于把门禁关掉。
  const merge = run('gh', ['pr', 'merge', String(prNumber), '--squash', '--auto'])
  if (merge.code !== 0) {
    const text = `${merge.stdout}${merge.stderr}`
    if (/auto.?merge|enablePullRequestAutoMerge/i.test(text)) {
      fail('auto_merge', `仓库没有开启 Allow auto-merge：${text.trim()}`, [
        '到仓库 Settings → General → Pull Requests 打开 Allow auto-merge',
        '确认允许 Squash merge',
        '然后重跑 node scripts/ship.mjs --resume',
      ])
    }
    fail('auto_merge', `开启自动合并失败：${text.trim()}`)
  }
  log('已开启自动合并（等检查通过后由 GitHub 合并）')
}

/**
 * 等检查通过、由 GitHub 自己合并。
 *
 * ## 为什么开始前必须先确认"必需的检查"真的存在
 *
 * 仓库原本既没有分支保护也没有必需检查，这种情况下 `gh pr merge --auto` 会**立刻**合并 ——
 * 它没有任何东西要等。"等 CI 绿再合"在配置层面根本不成立，不管脚本里写多少等待逻辑。
 * 所以这里第一步是确认 main 的 ruleset 里真的有 `required_status_checks`。没有就停下，
 * 而不是退化成「反正 CI 绿了就直接合」：那是假门禁，任务书 §一 明确不允许。
 *
 * 顺带说明为什么**不**强依赖 merge queue：queue 会把分支按顺序重新验证一遍，对
 * 「两个 PR 各自绿、合起来红」确实有用，但它要求 CI 额外响应 `merge_group` 触发，
 * 是另一个会卡住的环节。任务书要求的是「等仓库要求的检查全部通过」，必需检查就满足这条；
 * queue 配了就顺带用，没配不影响门禁成立。
 */
async function waitForMerge(prNumber) {
  step('wait_checks', `等待 PR #${prNumber} 的检查通过并合并`)

  const repo = run('gh', ['repo', 'view', '--json', 'squashMergeAllowed,nameWithOwner,defaultBranchRef'])
  if (repo.code !== 0) fail('wait_checks', `查询仓库设置失败：${repo.stderr.trim()}`)
  const repoInfo = parseJson(repo.stdout)
  if (repoInfo.squashMergeAllowed !== true) {
    fail('wait_checks', '仓库没有允许 Squash merge，auto-merge 无法按约定工作', [
      '到 Settings → General → Pull Requests 打开 Allow squash merging',
      '本流程固定用 squash：一条历史对应一个 PR，回溯时不用在合并节点里找',
    ])
  }

  const base = repoInfo.defaultBranchRef?.name ?? 'main'
  const rulesets = run('gh', ['api', `repos/${repoInfo.nameWithOwner}/rulesets`])
  const rulesetIds = rulesets.code === 0 ? parseJsonArray(rulesets.stdout).map((r) => r.id) : []

  let requiredChecks = []
  let hasMergeQueue = false
  for (const id of rulesetIds) {
    const detail = run('gh', ['api', `repos/${repoInfo.nameWithOwner}/rulesets/${id}`])
    if (detail.code !== 0) continue
    const body = parseJson(detail.stdout, {})
    if (Array.isArray(body.conditions?.ref_name?.include) && !refMatches(body.conditions, base)) continue
    for (const rule of body.rules ?? []) {
      if (rule.type === 'required_status_checks') {
        for (const check of rule.parameters?.required_status_checks ?? []) {
          requiredChecks.push(check.context)
        }
      }
      if (rule.type === 'merge_queue') hasMergeQueue = true
    }
  }

  if (requiredChecks.length === 0) {
    fail('wait_checks', `${base} 上没有必需的检查，"等 CI 通过再合并"没有强制执行者`, [
      `打开 https://github.com/${repoInfo.nameWithOwner}/settings/rules/new?target=branch&enforcement=active`,
      `Target branches 填 ${base}，勾选 Require status checks to pass，选上 CI 的「编译与测试（Node 22.18）」与「编译与测试（Node 24）」`,
      '不要勾 Require approvals：本仓库只有一个维护者，勾了会让 auto-merge 永远等不到人',
      '保存后重跑 node scripts/ship.mjs --resume',
    ])
  }
  log(`必需检查 ${requiredChecks.length} 项：${requiredChecks.join('、')}${hasMergeQueue ? '（另有 merge queue）' : ''}`)

  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let lastState = ''

  while (Date.now() < deadline) {
    const view = run('gh', [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'state,mergeStateStatus,mergeable,mergeQueueEntry,statusCheckRollup,url',
    ])
    if (view.code !== 0) fail('wait_checks', `查询 PR 状态失败：${view.stderr.trim()}`)

    const info = parseJson(view.stdout)
    const rollup = info.statusCheckRollup ?? []
    const failed = rollup.filter(
      (check) => check.conclusion === 'FAILURE' || check.conclusion === 'CANCELLED',
    )
    const done = rollup.filter((check) => check.status === 'COMPLETED').length
    const queueState = info.mergeQueueEntry?.state ?? '（不在队列里）'
    const summary = `${info.state} 检查 ${done}/${rollup.length} 队列 ${queueState}`

    if (summary !== lastState) {
      log(`PR #${prNumber}：${summary}`)
      lastState = summary
    }

    if (info.state === 'MERGED') {
      const merged = run('gh', ['pr', 'view', String(prNumber), '--json', 'mergeCommit,mergedAt'])
      const commit = parseJson(merged.stdout, {}).mergeCommit?.oid ?? null
      log(`PR 已合并${commit === null ? '' : `（合并提交 ${commit.slice(0, 7)}）`}`)
      return { merged: true, mergeCommit: commit }
    }

    // 检查失败要立刻报，不能等到超时：那时候日志已经被后续运行挤走了。
    if (failed.length > 0) {
      const names = failed.map((check) => `${check.name ?? check.context}（${check.conclusion}）`).join('、')
      fail('wait_checks', `检查失败：${names}`, [
        '到 Actions 页面读失败日志，找到第一个红的那一步',
        '修复后推送到同一分支，merge queue 会重新验证',
        '不要关闭检查或使用 --admin 绕过',
      ])
    }

    if (info.state === 'CLOSED') fail('wait_checks', 'PR 被关闭，没有合并')

    await sleep(POLL_INTERVAL_MS)
  }

  fail('wait_checks', `等了 ${Math.round(WAIT_TIMEOUT_MS / 60000)} 分钟仍未合并`, [
    '到 PR 页面确认检查是否卡住',
    '确认 merge queue 里还有这条 PR（被踢出去的话要重新入队）',
    '必要时人工合并后重跑 node scripts/ship.mjs --resume',
  ])
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- 标签与发布 -----------------------------------------------------------

function createTag(version, tagDecision, defaultBranch) {
  const tag = tagForVersion(version)
  step('tag', `在 ${defaultBranch} 上处理标签 ${tag}`)

  if (tagDecision.action === 'reuse') {
    log(`标签 ${tag} 已指向本次提交，跳过`)
    return { tag, created: false }
  }
  if (tagDecision.action === 'refuse') fail('tag', tagDecision.reason)

  const checkout = run('git', ['checkout', defaultBranch])
  if (checkout.code !== 0) fail('tag', `切换分支失败：${checkout.stderr.trim()}`)
  const pull = run('git', ['pull', '--ff-only', 'origin', defaultBranch])
  if (pull.code !== 0) fail('tag', `更新本地分支失败：${pull.stderr.trim()}`)

  const treeVersion = run('git', ['show', `origin/${defaultBranch}:package.json`])
  if (treeVersion.code === 0) {
    const remoteVersion = parseJson(treeVersion.stdout).version
    if (remoteVersion !== version) {
      fail('tag', `合并后的 ${defaultBranch} 上 package.json 是 ${remoteVersion}，与要发布的 ${version} 不一致`)
    }
  }

  const create = run('git', ['tag', '-a', tag, '-m', `v${version}：${SLUG === 'auto' ? '自动交付' : SLUG}`])
  if (create.code !== 0) fail('tag', `创建标签失败：${create.stderr.trim()}`)

  const push = run('git', ['push', 'origin', tag])
  if (push.code !== 0) fail('tag', `推送标签失败：${push.stdout}${push.stderr}`)

  const objectSha = run('git', ['rev-list', '-n', '1', tag]).stdout.trim()
  log(`已推送标签 ${tag}（指向 ${objectSha.slice(0, 12)}）`)
  return { tag, created: true }
}

async function waitForRelease(version) {
  const tag = tagForVersion(version)
  step('release', `等待 Release ${tag}`)

  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const view = run('gh', ['release', 'view', tag, '--json', 'url,tagName,assets,publishedAt,body'])
    if (view.code === 0) {
      const info = parseJson(view.stdout)
      log(`Release 已创建：${info.url}`)
      return info
    }

    // 工作流可能已经失败：先看有没有对应的失败运行，有就直接报出来，不干等 45 分钟。
    //
    // 必须按标签过滤：`gh run list --workflow Release` 返回的是**所有版本**的发布运行，
    // 历史上任何一次失败的发布都会在这里被当成「这一次失败了」。第一次真机演练就
    // 撞上：标签刚推上去、本次运行还在跑，它却报出 41160299089 —— 那是 v0.2.16 早先
    // 一次失败的运行。发布历史越长，这个误判越必然出现。
    const runs = run('gh', [
      'run',
      'list',
      '--workflow',
      'Release',
      '--limit',
      '10',
      '--json',
      'databaseId,status,conclusion,headBranch,displayTitle',
    ])
    if (runs.code === 0) {
      const failed = parseJsonArray(runs.stdout).find(
        (item) => item.headBranch === tag && (item.conclusion === 'failure' || item.conclusion === 'cancelled'),
      )
      if (failed !== undefined) {
        fail('release', `Release 工作流失败（Run ${failed.databaseId}）`, [
          `到 Actions 查看 Run ${failed.databaseId} 的日志`,
          '修复后重跑 node scripts/ship.mjs --resume',
          '不要删除已推送的标签，也不要手工覆盖 Release',
        ])
      }
    }

    await sleep(POLL_INTERVAL_MS)
  }

  fail('release', `等了 ${Math.round(WAIT_TIMEOUT_MS / 60000)} 分钟仍未看到 Release`)
}

function verifyRelease(version, releaseInfo) {
  step('verify_release', '核验附件哈希与安装命令')

  const remoteAssets = (releaseInfo.assets ?? []).map((asset) => ({
    name: asset.name,
    sha256: null,
    bytes: asset.size,
  }))

  // RS 里的 assets 不带 sha256；本机产物我们已经算过，所以比对的是「名字和字节数」，
  // 哈希一致性在下面的下载核验里做（只有下载回来算过，才是真的核验）。
  for (const local of report.artifacts) {
    const remote = remoteAssets.find((asset) => asset.name === local.name)
    if (remote === undefined) {
      fail('verify_release', `Release 里缺少附件 ${local.name}`)
    }
    if (remote.bytes !== local.bytes) {
      fail('verify_release', `附件 ${local.name} 字节数不一致：Release ${remote.bytes}，本地 ${local.bytes}`)
    }
  }

  const body = releaseInfo.body ?? ''
  for (const local of report.artifacts) {
    if (!body.includes(local.sha256)) {
      fail('verify_release', `Release 说明里没有 ${local.name} 的 SHA-256（${local.sha256.slice(0, 12)}…）`)
    }
  }
  if (!/dsh plugin .*add/.test(body)) {
    fail('verify_release', 'Release 说明里没有安装命令')
  }

  log('附件名称、字节数与发布说明里的哈希一致')
  return { url: releaseInfo.url, tag: releaseInfo.tagName, assets: remoteAssets }
}

// --- 主流程 ---------------------------------------------------------------

async function main() {
  if (STATUS_ONLY) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const saved = loadState(pkg.version)
    if (saved === null) {
      console.log('没有可恢复的交付状态')
      return
    }
    console.log(JSON.stringify(saved, null, 2))
    return
  }

  const { version, defaultBranch } = preflight()

  // 断点续跑：状态文件说有进度就从那里接，但只接受同一版本、同一 schema。
  if (RESUME) {
    const saved = loadState(version)
    if (saved !== null) {
      state = saved
      report.stage = saved.stage
      report.github = { ...report.github, ...saved.github }
      // 上一轮已经跑过的测试与已经算过的产物要带过来。`verify` 在续跑时被跳过，
      // 不补回来的话这份交付报告会在最后一步被判成「测试数为 0」—— 那是把
      // 「这一轮没重跑」说成了「没跑过」。
      if (saved.tests !== null && saved.tests !== undefined) report.tests = saved.tests
      if (Array.isArray(saved.artifacts) && saved.artifacts.length > 0) report.artifacts = saved.artifacts
      if (saved.tests !== null && saved.tests !== undefined) {
        report.checks.tests = true
        report.notes.push(`测试计数沿用上一轮（${saved.tests.total} 项），本轮 --resume 未重跑`)
      } else if (!SKIP_TESTS) {
        // 状态文件里没有计数 —— 上一轮还没走到验证，或者状态文件来自旧版本。
        // 这时候唯一诚实的做法是真跑一遍，而不是留空或者编一个数。
        log('状态文件里没有测试计数，补跑全部测试')
        runTests()
        state.tests = report.tests
        saveState()
      }
      log(`从 ${STAGE_LABELS[saved.stage] ?? saved.stage} 继续`)
    } else {
      log('没有可用的状态文件，从头开始')
    }
  }
  saveState()

  const sensitiveCheck = () => {
    const changes = collectChanges('origin/main')
    const result = classifySensitive(changes)
    if (result.sensitive) {
      log(`检测到 ${result.reasons.length} 处需要人工确认的变更`)
      for (const reason of result.reasons) log(`  · ${reason.path}：${reason.reason}`)
    }
    return result
  }

  let branch = null
  let pr = null
  let tag = null

  try {
    // 已经走到标签之后的阶段时，跳过前面的副作用，直接接着等 —— 这是 --resume 的关键。
    const stageIndex = (name) => {
      const order = ['preflight', 'branch', 'verify', 'commit', 'push', 'pull_request', 'auto_merge', 'wait_checks', 'tag', 'release', 'verify_release', 'done']
      return order.indexOf(name)
    }
    const reached = (name) => stageIndex(state.stage) >= stageIndex(name)

    if (!reached('verify')) verify(version)
    else log('本地验证已在上一轮完成，跳过')

    // 续跑时会跳过验证阶段，产物哈希必须在这里重算，否则后面「核验附件」
    // 会对一个空列表循环然后通过 —— 空列表永远满足「每个附件都对得上」。
    const rebuilt = computeArtifacts(version)
    if (rebuilt.missing.length > 0) {
      fail('verify', `找不到本次要发布的产物：${rebuilt.missing.join('、')}。先跑 node scripts/pack.mjs 与 node scripts/source-zip.mjs --out .`)
    }
    report.artifacts = rebuilt.artifacts

    if (DRY_RUN) {
      const sensitive = sensitiveCheck()
      report.status = 'in_progress'
      report.notes.push('--dry-run：未推送、未创建 PR、未打标签、未发布')
      report.unverified.push('远端 PR、Actions 检查、标签与 Release（--dry-run）')
      if (sensitive.sensitive) {
        report.notes.push(`--dry-run：这 ${sensitive.reasons.length} 处改动按约定需要维护者授权，正式跑时会停在 PR`)
        for (const reason of sensitive.reasons) report.notes.push(`  · ${reason.path}：${reason.reason}`)
      } else {
        report.notes.push('--dry-run：没有命中敏感路径，正式跑时会启用自动合并')
      }
      advanceState(state, { to: 'commit', detail: { note: 'dry-run 停在提交前' } })
      saveState()
      console.log('\n[ship] dry-run 完成：本地验证全部通过，未触碰远端')
      console.log(`[ship] 本机两个产物：${report.artifacts.map((a) => `${a.name} ${a.bytes} B`).join(' / ')}`)
      console.log(`[ship] 敏感判定：${sensitive.sensitive ? '需要人工授权，正式跑会停在 PR' : '不敏感，正式跑会启用自动合并'}`)
      return
    }

    sensitiveCheck()

    if (!reached('commit')) {
      const branchInfo = ensureBranch(version, defaultBranch)
      branch = branchInfo.branch
      report.github.branch = branch

      const commitInfo = commitAll(version, branch)
      const head = commitInfo.head ?? run('git', ['rev-parse', 'HEAD']).stdout.trim()
      report.github.commitSha = head

      advanceState(state, { to: 'push', detail: { github: { branch, commitSha: head } } })
      saveState()
    } else {
      branch = state.github.branch ?? branchForVersion(version, SLUG)
      report.github.branch = branch
      report.github.commitSha = state.github.commitSha ?? run('git', ['rev-parse', 'HEAD']).stdout.trim()
    }

    if (!reached('pull_request')) {
      pushBranch(branch)
      advanceState(state, { to: 'pull_request' })
      saveState()
    }

    if (pr === null) {
      pr = ensurePullRequest(version, branch, defaultBranch)
      report.github.pr = { number: pr.number, url: pr.url }
      advanceState(state, { to: 'auto_merge', detail: { github: { pr: report.github.pr } } })
      saveState()
    }

    const sensitive = sensitiveCheck()
    if (pr.state === 'MERGED') {
      // 走到这里说明上一轮停在了 PR，而人是手动合并的 —— 那次合并就是授权。
      log(`PR #${pr.number} 已被合并（人工授权完成），跳过自动合并与等待检查`)
      report.github.mergedCommitSha = pr.mergeCommit ?? null
      advanceState(state, { to: 'tag', detail: { github: { mergedCommitSha: report.github.mergedCommitSha } } })
      saveState()
    } else {
      const decision = nextStep({ stage: 'pull_request', sensitive: sensitive.sensitive })
      if (decision.blocked) {
        report.status = 'blocked'
        report.stage = 'pull_request'
        report.failure = { stage: 'pull_request', reason: decision.reason, recovery: decision.recovery }
        advanceState(state, { to: 'auto_merge', status: 'blocked', detail: { note: decision.reason, blocks: sensitive.reasons } })
        saveState()
        console.log(`\n[ship] 已停在人工审核：${decision.reason}`)
        console.log(`[ship] PR：${pr.url}`)
        console.log('[ship] 确认无误后手动 squash 合并，再跑 node scripts/ship.mjs --resume')
        process.exitCode = 2
        return
      }

      if (!reached('wait_checks')) {
        enableAutoMerge(pr.number)
        advanceState(state, { to: 'wait_checks' })
        saveState()
      }

      const mergeInfo = await waitForMerge(pr.number)
      if (mergeInfo.mergeCommit) report.github.mergedCommitSha = mergeInfo.mergeCommit
      advanceState(state, { to: 'tag', detail: { github: { mergedCommitSha: mergeInfo.mergeCommit } } })
      saveState()
    }

    // 合并后重新取 main 的真实提交，用它来判断标签指向哪里。
    run('git', ['fetch', 'origin'])
    const mainSha = run('git', ['rev-parse', `origin/${defaultBranch}`]).stdout.trim()
    report.github.commitSha = mainSha

    const remoteTag = run('git', ['ls-remote', '--tags', 'origin', tagForVersion(version)])
    let tagExists = false
    let tagCommit = null
    if (remoteTag.code === 0 && remoteTag.stdout.trim() !== '') {
      tagExists = true
      // annotated tag 在 ls-remote 里给的是 tag 对象的 SHA，要用 rev-list 才能拿到提交。
      tagCommit = run('git', ['rev-list', '-n', '1', tagForVersion(version)]).stdout.trim() || null
      if (tagCommit === null) {
        run('git', ['fetch', 'origin', '--tags'])
        tagCommit = run('git', ['rev-list', '-n', '1', `origin/tags/${tagForVersion(version)}`]).stdout.trim() || null
      }
    }

    const tagDecision = decideTag({ tagExists, tagCommit, expectedCommit: mainSha })
    const tagStep = nextStep({ stage: 'tag', tagDecision })
    if (tagStep.blocked) {
      report.status = 'blocked'
      report.stage = 'tag'
      report.failure = { stage: 'tag', reason: tagStep.reason, recovery: tagStep.recovery }
      advanceState(state, { to: 'tag', status: 'blocked', detail: { note: tagStep.reason } })
      saveState()
      console.log(`\n[ship] 停：${tagStep.reason}`)
      process.exitCode = 2
      return
    }

    tag = createTag(version, tagDecision, defaultBranch)
    report.github.tag = tag.tag
    report.github.tagCommit = mainSha
    advanceState(state, { to: 'release', detail: { github: { tag: tag.tag } } })
    saveState()

    const releaseInfo = await waitForRelease(version)
    report.github.runs.release = null

    const verified = verifyRelease(version, releaseInfo)
    report.notes.push(`Release：${verified.url}`)
    report.github.releaseUrl = verified.url
    report.github.assets = verified.assets

    // 先按 success 审判自己一遍：缺提交、缺标签、附件为空、测试数为 0 都算不自洽。
    // 不通过就变成 StageFailure，好让下面统一记进失败报告 —— 直接抛原生异常的话，
    // 报告不会落盘，人只会看到一段栈。
    const problems = []
    try {
      assertReportConsistent({ ...report, status: 'success' })
    } catch (error) {
      problems.push(error.message)
    }
    if (problems.length > 0) {
      fail('verify_release', `交付状态自洽检查未通过：\n${problems.join('\n')}`)
    }

    report.status = 'success'
    report.stage = 'done'
    advanceState(state, { to: 'done', status: 'success' })
    saveState()

    console.log('\n[ship] 交付完成')
    console.log(`[ship] PR：      ${pr.url}`)
    console.log(`[ship] 标签：    ${tag.tag}`)
    console.log(`[ship] Release： ${verified.url}`)
    for (const asset of report.artifacts) {
      console.log(`[ship] 附件：    ${asset.name}  ${asset.bytes} B  ${asset.sha256}`)
    }
    console.log(`[ship] 报告：    ${join(stateDir, statusFileName(version))}`)
  } catch (error) {
    if (!(error instanceof StageFailure)) throw error

    const recovery = error.extra.recovery ?? RECOVERY[error.stage] ?? []
    report.status = 'failed'
    report.stage = error.stage
    report.failure = { stage: error.stage, reason: error.reason, recovery }

    if (state !== null) {
      advanceState(state, {
        to: error.stage,
        status: 'failed',
        detail: { note: error.reason, github: report.github },
      })
      // 报告可能因为前置条件不成立而缺字段，这里不强求自洽 —— 失败报告的价值在于说明失败。
      saveState()
    }

    console.error(`\n[ship] 失败于「${STAGE_LABELS[error.stage] ?? error.stage}」：${error.reason}`)
    if (recovery.length > 0) {
      console.error('[ship] 恢复建议：')
      for (const line of recovery) console.error(`  · ${line}`)
    }
    process.exitCode = 1
  }
}

await main()
