/**
 * v0.3.0 P0：敏感规则覆盖完整 + 授权必须绑定最终代码（issue #31 / #32）。
 *
 * ## 这两条为什么必须一起测
 *
 * #31 是「改判定不会停」：#29 把扫描的核心判定搬进 `scripts/lib/zip-index.mjs`，
 * 而 `classifySensitive` 只认两个入口脚本。于是修改「什么算违规」的文件，
 * 不会触发任何敏感闸门 —— PR 会被自动合并。
 *
 * #32 是「停了也白停」：`ship.mjs` 在 `pr.state === 'MERGED'` 时把合并事件当成授权，
 * 不校验合并的提交是不是被审阅的那个。授权 A、推 B、合并 B、`--resume` 发 B。
 *
 * 两条合起来的后果是：既可能悄悄改掉判定，也可能把旧批准复用到新代码上。
 *
 * ## 这里的断言都对着「真实文件集合」验证，不是对着写死的名单
 *
 * 「导入闭包」那一条从敏感入口出发解析真实 `import`，要求闭包里每个本地模块都被某条
 * 规则命中。这样 v0.3.1 再加一个 `scripts/lib/zip-budget.mjs` 时，忘了登记会直接变红，
 * 而不是等下一次「改了没事」的事故来告诉她。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ship-core / ship-review 是 .mjs，测试类型检查基线里没有它们的声明
import {
  APPROVAL_SCHEMA,
  SCAN_RULE_FILES,
  classifySensitive,
  compareReviewedContent,
  judgeMergeGate,
  judgeResumeAuthorization,
  parseApproval,
} from '../scripts/lib/ship-core.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  findMaintainerApproval,
  parseApprovalComment,
  readBlobsAt,
  readChangedEntries,
} from '../scripts/lib/ship-review.mjs'

const ROOT = join(import.meta.dirname, '..')

/**
 * 摘要文本，与 `ship.mjs` 里 `captureReviewAnchor` 记录的形状一致。
 * 不用 `git rev-parse`：这条测试要证明的是**判定**，不是读取。
 */
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const TREE_A = '1'.repeat(40)

describe('#31：扫描判定的全部来源都必须触发敏感审核', () => {
  it('三个新增的辅助模块都被 scan-rules 命中', () => {
    for (const path of [
      'scripts/lib/zip-index.mjs',
      'scripts/lib/scan-finding.mjs',
      'scripts/lib/fixture-allowlist.mjs',
    ]) {
      const result = classifySensitive([{ path }])
      assert.equal(result.sensitive, true, `${path} 必须触发敏感审核`)
      assert.equal(result.reasons[0].id, 'scan-rules', `${path} 应当归在 scan-rules`)
    }
  })

  it('SCAN_RULE_FILES 里的每个文件都真的存在', () => {
    // 名单里写一个不存在的路径，看起来「覆盖了」，实际永远匹配不到 —— 另一种形式的漏检。
    // `zip-index.mjs` 由 PR #35 引入，本分支（P0 修复）还没合它，所以单独标注为待合并，
    // 而不是从名单里删掉 —— 删掉才是漏检。
    const pending = ['scripts/lib/zip-index.mjs']
    const listed = [
      ...SCAN_RULE_FILES,
      'scripts/lib/archive-verify.mjs',
      'scripts/lib/git-objects.mjs',
      'scripts/lib/import-scan.mjs',
    ]
    for (const path of listed) {
      if (pending.includes(path) && !existsSync(join(ROOT, path))) continue
      assert.equal(existsSync(join(ROOT, path)), true, `${path} 在敏感名单里但仓库里没有这个文件`)
    }
  })

  it('只改辅助模块的注释也要停：路径级判定不看行内容', () => {
    const result = classifySensitive([{ path: 'scripts/lib/zip-index.mjs', addedLines: ['// 说明'], removedLines: [] }])
    assert.equal(result.sensitive, true)
  })

  it('导入闭包：敏感入口能走到的本地模块，必须全部被规则命中', () => {
    /**
     * 从每个敏感入口出发，解析相对 import，递归收集闭包。
     *
     * 只跟 `./` `../` 这类相对路径：`node:*` 与第三方包不是本仓库的判定代码，
     * 改它们的风险由 lockfile 与依赖审查承担。
     */
    const importsOf = (file: string): string[] => {
      const text = readFileSync(join(ROOT, file), 'utf8')
      const found = []
      const pattern = /(?:from|import)\s+'([^']+)'/g
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1]
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
        const resolved = join(file, '..', specifier).split('\\').join('/')
        const normalised = resolved.replace(/\/\.\//g, '/')
        if (existsSync(join(ROOT, normalised))) found.push(normalised)
      }
      return found
    }

    const entrypoints = [
      'scripts/audit-leaks.mjs',
      'scripts/scan-archive.mjs',
      'scripts/source-zip.mjs',
      'scripts/pack.mjs',
      'scripts/verify-source-archive.mjs',
      'scripts/verify-install.mjs',
      'scripts/release-dry-run.mjs',
      'scripts/ci-guard.mjs',
      'scripts/version.mjs',
      'scripts/ship.mjs',
    ]

    const closure = new Set<string>()
    const queue: string[] = [...entrypoints]
    while (queue.length > 0) {
      const file = queue.pop() as string
      for (const dependency of importsOf(file)) {
        if (closure.has(dependency)) continue
        closure.add(dependency)
        queue.push(dependency)
      }
    }

    const uncovered = [...closure].filter((path: string) => !classifySensitive([{ path }]).sensitive)
    assert.deepEqual(
      uncovered,
      [],
      `这些模块在敏感入口的导入闭包里，但改动它们不会停下：${uncovered.join('、')}。` +
        '要么加进对应的敏感名单，要么证明它不含判定（并把入口拆开）。',
    )
  })

  it('反向：普通脚本与工具模块不该被扫进来', () => {
    // 名单越宽，守卫越快被绕过。这三条钉住「挡风险不是挡工作」。
    for (const path of [
      'scripts/clean.mjs',
      'scripts/verify.mjs',
      'scripts/lib/delivery-status.mjs',
    ]) {
      if (path === 'scripts/lib/delivery-status.mjs') {
        // delivery-status 属于 ship-logic，这里只确认它没有被误归到扫描规则。
        const result = classifySensitive([{ path }])
        assert.equal(result.sensitive, true)
        assert.notEqual(result.reasons[0].id, 'scan-rules')
        continue
      }
      assert.equal(classifySensitive([{ path }]).sensitive, false, `${path} 不该被拦`)
    }
  })
})

describe('#32：授权必须绑定最终代码', () => {
  const approvalFor = (overrides = {}) => ({
    schema: APPROVAL_SCHEMA,
    kind: 'maintainer-authorization',
    pr: 35,
    head: HEAD_A,
    tree: TREE_A,
    scope: ['scripts/lib/zip-index.mjs', 'scripts/scan-archive.mjs'],
    approver: 'alicia1030su',
    statement: '我审阅了归档完整性修复，确认只收紧检查、没有新增豁免。',
    approvedAt: '2026-11-09T15:00:00Z',
    ...overrides,
  })

  const review = {
    pr: 35,
    head: HEAD_A,
    tree: TREE_A,
    paths: ['scripts/lib/zip-index.mjs', 'scripts/scan-archive.mjs'],
    reasons: [
      { id: 'scan-rules', path: 'scripts/lib/zip-index.mjs' },
      { id: 'scan-rules', path: 'scripts/scan-archive.mjs' },
    ],
    allPaths: [
      { path: 'scripts/lib/archive-verify.mjs', blob: 'b1' },
      { path: 'scripts/lib/zip-index.mjs', blob: 'b2' },
      { path: 'scripts/scan-archive.mjs', blob: 'b3' },
    ],
  }

  const mergedPr = (overrides = {}) => ({
    number: 35,
    state: 'MERGED',
    headRefOid: HEAD_A,
    mergedAt: '2026-11-09T16:00:00Z',
    ...overrides,
  })

  it('正常路径：授权 A、合并 A，允许继续', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr(),
      review,
      approval: approvalFor(),
    })
    assert.equal(verdict.allowed, true, verdict.reason)
    assert.equal(verdict.blocked, false)
  })

  it('审核 A → 推送 B → 合并 B：必须拒绝', () => {
    // 这是 issue #32 描述的那条真实路径。旧实现在这里会直接打标签发版。
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr({ headRefOid: HEAD_B }),
      review,
      approval: approvalFor(),
    })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /审核后 PR 头变成了|重新审核/, verdict.reason)
  })

  it('授权写的是 B、审核锚点是 A：拒绝（授权与锚点不一致）', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr({ headRefOid: HEAD_A }),
      review,
      approval: approvalFor({ head: HEAD_B }),
    })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /授权与审核锚点不一致/)
  })

  it('没有审核锚点：拒绝（不能凭合并事实推断审核完成）', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr(),
      review: null,
      approval: approvalFor(),
    })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /没有审核锚点/)
  })

  it('没有授权记录：拒绝，并说明合并事实不是授权', () => {
    const verdict = judgeResumeAuthorization({ sensitive: true, pr: mergedPr(), review, approval: null })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /合并事实本身不是授权/)
  })

  it('授权属于别的 PR：拒绝', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr(),
      review,
      approval: approvalFor({ pr: 38 }),
    })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /授权记录属于 PR #38/)
  })

  it('授权范围漏了被审核的敏感路径：拒绝', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr(),
      review,
      approval: approvalFor({ scope: ['scripts/lib/zip-index.mjs'] }),
    })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /没有覆盖被审核的敏感路径/)
  })

  it('授权在合并之后才补：拒绝（事后追认不是审阅）', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr(),
      review,
      approval: approvalFor({ approvedAt: '2026-11-09T17:00:00Z' }),
    })
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /晚于合并时间/)
  })

  it('非敏感变更不需要授权，也不因为「有授权」就被拦', () => {
    const verdict = judgeResumeAuthorization({ sensitive: false, pr: mergedPr(), review: null, approval: null })
    assert.equal(verdict.allowed, true)
  })

  it('PR 还没合并时，敏感变更一律停在审核点', () => {
    const verdict = judgeResumeAuthorization({
      sensitive: true,
      pr: mergedPr({ state: 'OPEN' }),
      review,
      approval: approvalFor(),
    })
    assert.equal(verdict.allowed, false)
  })
})

describe('#32：合并内容与被审核内容逐 blob 比对', () => {
  const reviewed = [
    { path: 'scripts/lib/zip-index.mjs', blob: 'blob-1' },
    { path: 'scripts/scan-archive.mjs', blob: 'blob-2' },
  ]

  it('内容完全相同时通过（不要求提交 SHA 相等）', () => {
    // squash 合并必然产生新提交。要求 SHA 相等会把唯一正确的路径堵死。
    const result = compareReviewedContent({ reviewed, merged: reviewed })
    assert.equal(result.ok, true)
  })

  it('某个文件内容变了就报出来', () => {
    const merged = [
      { path: 'scripts/lib/zip-index.mjs', blob: 'blob-1' },
      { path: 'scripts/scan-archive.mjs', blob: 'blob-CHANGED' },
    ]
    const result = compareReviewedContent({ reviewed, merged })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('；'), /内容与审核时不同/)
  })

  it('合并少带了文件就报出来', () => {
    const result = compareReviewedContent({ reviewed, merged: [reviewed[0]] })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('；'), /没有审核过的路径/)
  })

  it('合并多带未审核的敏感路径就报出来', () => {
    const result = compareReviewedContent({
      reviewed,
      merged: reviewed,
      extraSensitive: ['scripts/ship.mjs'],
    })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('；'), /未审核的敏感路径/)
  })
})

describe('#32：授权记录解析与维护者 review 读取', () => {
  it('完整的 review 文本能被解析', () => {
    const body = [
      'ship-approval: v1',
      'pr: 35',
      `head: ${HEAD_A}`,
      'scope: scripts/lib/zip-index.mjs, scripts/scan-archive.mjs',
      'note: 我审阅了归档完整性修复，确认只收紧检查、没有新增豁免。',
    ].join('\n')
    const parsed = parseApprovalComment(body)
    assert.deepEqual(parsed, {
      pr: 35,
      head: HEAD_A,
      scope: ['scripts/lib/zip-index.mjs', 'scripts/scan-archive.mjs'],
      note: '我审阅了归档完整性修复，确认只收紧检查、没有新增豁免。',
    })
  })

  it('缺字段、head 不完整、note 太短：一律不认', () => {
    assert.equal(parseApprovalComment('随便一句 LGTM'), null)
    assert.equal(parseApprovalComment('ship-approval: v1\npr: 35\nhead: abc\nscope: a.js\nnote: ok'), null)
    assert.equal(
      parseApprovalComment(`ship-approval: v1\npr: 35\nhead: ${HEAD_A}\nscope: a.js\nnote: ok`),
      null,
    )
  })

  it('维护者 review 的 commit_id 必须等于评论绑定的 head', () => {
    const treeOfHead = (head: string): string | null => (head === HEAD_A ? TREE_A : null)
    const base = {
      id: 1,
      state: 'APPROVED',
      user: { login: 'alicia1030su' },
      body: [
        'ship-approval: v1',
        'pr: 35',
        `head: ${HEAD_A}`,
        'scope: scripts/lib/zip-index.mjs',
        'note: 我审阅了归档完整性修复，确认只收紧检查、没有新增豁免。',
      ].join('\n'),
      submitted_at: '2026-11-09T15:00:00Z',
    }

    const good = findMaintainerApproval({
      prNumber: 35,
      reviewedHead: HEAD_A,
      reviews: [{ ...base, commit_id: HEAD_A }],
      maintainers: ['alicia1030su'],
      treeOfHead,
    })
    assert.equal(good.ok, true)
    const granted = good.approval as { head: string, tree: string } | null
    assert.equal(granted?.head, HEAD_A)
    assert.equal(granted?.tree, TREE_A)

    // GitHub 记录的是 review 提交那一刻的 commit；之后推了新提交，它不会跟着变。
    const drifted = findMaintainerApproval({
      prNumber: 35,
      reviewedHead: HEAD_A,
      reviews: [{ ...base, commit_id: HEAD_B }],
      maintainers: ['alicia1030su'],
      treeOfHead,
    })
    assert.equal(drifted.ok, false)
    assert.match(drifted.problems.join('；'), /GitHub 记录的 review 提交/)
  })

  it('非维护者写的同一段文本不算授权', () => {
    const result = findMaintainerApproval({
      prNumber: 35,
      reviewedHead: HEAD_A,
      reviews: [
        {
          id: 2,
          state: 'APPROVED',
          commit_id: HEAD_A,
          user: { login: 'some-agent' },
          body: [
            'ship-approval: v1',
            'pr: 35',
            `head: ${HEAD_A}`,
            'scope: scripts/lib/zip-index.mjs',
            'note: 我审阅了归档完整性修复，确认只收紧检查、没有新增豁免。',
          ].join('\n'),
          submitted_at: '2026-11-09T15:00:00Z',
        },
      ],
      maintainers: ['alicia1030su'],
      treeOfHead: () => TREE_A,
    })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('；'), /没有来自维护者的授权 review/)
  })

  it('流水线里没有创建 review 的代码：授权只能由维护者提交', () => {
    // 如果 ship 自己能发 review，那它就能给自己发批准 —— 这条断言钉住「不能」。
    const source = [
      readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8'),
      readFileSync(join(ROOT, 'scripts', 'lib', 'ship-review.mjs'), 'utf8'),
    ].join('\n')

    assert.doesNotMatch(source, /gh['"]?\s*,\s*\[['"]pr['"]\s*,\s*['"]review['"]/,
      'ship 不得调用 gh pr review')
    assert.doesNotMatch(source, /pulls\/[^'"`]*\/reviews['"`]\s*,\s*['"]--method['"]\s*,\s*['"]POST['"]/,
      'ship 不得向 reviews 接口 POST')
    assert.doesNotMatch(source, /--approve\b/, 'ship 不得使用 --approve')
    assert.doesNotMatch(source, /\bapprovePullRequest\b|submitReview/, 'ship 不得调用任何提交 review 的接口')
  })

  it('授权记录的字段缺一项就不可解析', () => {
    const good = parseApproval({
      schema: APPROVAL_SCHEMA,
      kind: 'maintainer-authorization',
      pr: 35,
      head: HEAD_A,
      tree: TREE_A,
      scope: ['a'],
      approver: 'alicia1030su',
      statement: '批准这六个文件的归档完整性修复，范围仅限收紧检查。',
      approvedAt: '2026-11-09T15:00:00Z',
    })
    assert.equal(good.ok, true)

    const missingScope = parseApproval({
      schema: APPROVAL_SCHEMA,
      kind: 'maintainer-authorization',
      pr: 35,
      head: HEAD_A,
      tree: TREE_A,
      scope: [],
      approver: 'alicia1030su',
      statement: '批准这六个文件的归档完整性修复，范围仅限收紧检查。',
      approvedAt: '2026-11-09T15:00:00Z',
    })
    assert.equal(missingScope.ok, false)
  })
})

describe('#32：真实 Git 仓库上的行为回归（审核 A → 推 B → 合并 B）', () => {
  /**
   * 用真实提交而不是构造的 blob：这条要证明的是「git 读出来的内容」与判定能对上，
   * 包括 squash 合并生成新提交这一事实。
   */
  const makeRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-auth-'))
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'test'])
    git(['config', 'core.autocrlf', 'false'])
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'scan.txt'), '旧规则\n')
    git(['add', '-A'])
    git(['commit', '-m', 'base'])
    return { dir, git }
  }

  const write = (dir: string, path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }

  const runIn = (dir: string) => (args: string[]) => {
    try {
      return { code: 0, stdout: execFileSync('git', args, { cwd: dir, encoding: 'utf8' }) }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string }
      return { code: failure.status ?? 1, stdout: String(failure.stdout ?? '') }
    }
  }

  const buildReview = (dir: string, head: string) => {
    const run = runIn(dir)
    const changed = readChangedEntries(run, `main...${head}`, head)
    assert.equal(changed.ok, true)
    return {
      pr: 1,
      head,
      tree: run(['rev-parse', `${head}^{tree}`]).stdout.trim(),
      paths: ['scripts/scan.txt'],
      allPaths: changed.entries,
    }
  }

  const approvalFor = (review: { head: string, tree: string }) => ({
    schema: APPROVAL_SCHEMA,
    kind: 'maintainer-authorization',
    pr: 1,
    head: review.head,
    tree: review.tree,
    scope: ['scripts/scan.txt'],
    approver: 'alicia1030su',
    statement: '批准这次扫描规则收紧，范围仅限 scripts/scan.txt。',
    approvedAt: new Date(Date.now() - 3600_000).toISOString(),
  })

  it('审核 A → 推送 B → 合并 B：--resume 必须拒绝发布', () => {
    const { dir, git } = makeRepo()
    git(['checkout', '-b', 'feature'])
    write(dir, 'scripts/scan.txt', '规则 A\n')
    git(['add', '-A'])
    git(['commit', '-m', 'A'])
    const headA = git(['rev-parse', 'HEAD']).trim()
    const review = buildReview(dir, headA)
    const approval = approvalFor(review)

    // 批准之后又推了 B —— 这正是 issue #32 的失败路径。
    write(dir, 'scripts/scan.txt', '规则 B\n')
    git(['add', '-A'])
    git(['commit', '-m', 'B'])
    const headB = git(['rev-parse', 'HEAD']).trim()

    git(['checkout', 'main'])
    git(['merge', '--squash', 'feature'])
    git(['commit', '-m', 'squash B'])
    const merged = git(['rev-parse', 'HEAD']).trim()
    const mergedEntries = readChangedEntries(runIn(dir), `${merged}^1..${merged}`, merged)

    const gate = judgeMergeGate({
      sensitive: true,
      pr: { number: 1, state: 'MERGED', headRefOid: headB, mergedAt: new Date().toISOString() },
      review,
      approval,
      mergedEntries: mergedEntries.entries,
      extraSensitive: [],
    })
    assert.equal(gate.allowed, false, '对 A 的批准不能被用来发布 B')
    assert.match(gate.reason, /审核后 PR 头变成了|旧授权已失效/, gate.reason)
  })

  it('正常授权 A → 合并 A：squash 生成新提交也允许（比内容不比 SHA）', () => {
    const { dir, git } = makeRepo()
    git(['checkout', '-b', 'feature'])
    write(dir, 'scripts/scan.txt', '规则 A\n')
    git(['add', '-A'])
    git(['commit', '-m', 'A'])
    const headA = git(['rev-parse', 'HEAD']).trim()
    const review = buildReview(dir, headA)
    const approval = approvalFor(review)

    git(['checkout', 'main'])
    git(['merge', '--squash', 'feature'])
    git(['commit', '-m', 'squash A'])
    const merged = git(['rev-parse', 'HEAD']).trim()

    // 前置条件：squash 的提交号与被审核 head 必然不同。要求 SHA 相等的实现会在这里误判。
    assert.notEqual(merged, headA)

    const mergedEntries = readChangedEntries(runIn(dir), `${merged}^1..${merged}`, merged)
    const gate = judgeMergeGate({
      sensitive: true,
      pr: { number: 1, state: 'MERGED', headRefOid: headA, mergedAt: new Date().toISOString() },
      review,
      approval,
      mergedEntries: mergedEntries.entries,
      extraSensitive: [],
    })
    assert.equal(gate.allowed, true, gate.reason)
  })

  it('基线在审核后前进：tree 不同但被审核路径的内容相同 → 允许', () => {
    const { dir, git } = makeRepo()
    git(['checkout', '-b', 'feature'])
    write(dir, 'scripts/scan.txt', '规则 A\n')
    git(['add', '-A'])
    git(['commit', '-m', 'A'])
    const headA = git(['rev-parse', 'HEAD']).trim()
    const review = buildReview(dir, headA)
    const approval = approvalFor(review)

    // main 上先落了另一个无关 PR，再 squash 合并 A。
    git(['checkout', 'main'])
    write(dir, 'other.txt', '别的 PR\n')
    git(['add', '-A'])
    git(['commit', '-m', 'other'])
    git(['merge', '--squash', 'feature'])
    git(['commit', '-m', 'squash A on newer base'])
    const merged = git(['rev-parse', 'HEAD']).trim()

    const mergedEntries = readChangedEntries(runIn(dir), `${merged}^1..${merged}`, merged)
    const gate = judgeMergeGate({
      sensitive: true,
      pr: { number: 1, state: 'MERGED', headRefOid: headA, mergedAt: new Date().toISOString() },
      review,
      approval,
      mergedEntries: mergedEntries.entries,
      extraSensitive: [],
    })
    assert.equal(gate.allowed, true, gate.reason)
  })

  it('合并时多带了未审核的敏感路径：拒绝', () => {
    const { dir, git } = makeRepo()
    git(['checkout', '-b', 'feature'])
    write(dir, 'scripts/scan.txt', '规则 A\n')
    git(['add', '-A'])
    git(['commit', '-m', 'A'])
    const headA = git(['rev-parse', 'HEAD']).trim()
    const review = buildReview(dir, headA)
    const approval = approvalFor(review)

    // 合并前又往分支上加了第二个敏感文件，但授权范围没覆盖它。
    write(dir, 'scripts/other-rule.txt', '偷偷加一条\n')
    git(['add', '-A'])
    git(['commit', '-m', 'B'])
    const headB = git(['rev-parse', 'HEAD']).trim()

    git(['checkout', 'main'])
    git(['merge', '--squash', 'feature'])
    git(['commit', '-m', 'squash B'])
    const merged = git(['rev-parse', 'HEAD']).trim()
    const mergedEntries = readChangedEntries(runIn(dir), `${merged}^1..${merged}`, merged)

    const gate = judgeMergeGate({
      sensitive: true,
      pr: { number: 1, state: 'MERGED', headRefOid: headB, mergedAt: new Date().toISOString() },
      review,
      approval,
      mergedEntries: mergedEntries.entries,
      extraSensitive: ['scripts/other-rule.txt'],
    })
    assert.equal(gate.allowed, false)
  })
})

describe('#32：从真实仓库读 blob，不受工作区影响', () => {
  it('readBlobsAt / readChangedEntries 在真实仓库上给出稳定结果', () => {
    // 用 HEAD 自己对自己：改动清单必须为空，blob 必须与 `rev-parse` 一致。
    // 这条测的是「读取实现没写错」，不依赖网络与远端。
    const run = (args: string[]) => {
      try {
        return { code: 0, stdout: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }) }
      } catch (error) {
        const failure = error as { status?: number; stdout?: string }
        return { code: failure.status ?? 1, stdout: String(failure.stdout ?? '') }
      }
    }

    const head = run(['rev-parse', 'HEAD']).stdout.trim()
    const same = readChangedEntries(run, `${head}...${head}`, head)
    assert.equal(same.ok, true)
    assert.deepEqual(same.entries, [])

    const blobs = readBlobsAt(run, head, ['package.json'])
    assert.equal(blobs.length, 1)
    assert.match(blobs[0].blob ?? '', /^[0-9a-f]{40}$/)
  })
})
