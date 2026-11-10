/**
 * 敏感变更的审核锚点与授权读取（v0.3.0 issue #32）。
 *
 * ## 为什么授权不在本地文件里
 *
 * 一个由流水线自己能写出来的「批准文件」不是授权，是自证。所以这里只做两件事：
 *
 * 1. **读** GitHub 上维护者提交的 review（`pulls/{n}/reviews`），它带 `commit_id`、
 *    作者与提交时间 —— 这三样都不是本地能编出来的；
 * 2. 把「停下来时被审阅的那份代码」记成锚点（head / tree / 每个改动路径的 blob），
 *    恢复时用它比对合并结果。
 *
 * 本模块没有任何写 GitHub 的函数。`ship.mjs` 也不调用任何创建 review 的接口 ——
 * 授权必须由维护者在 PR 页面上留下，流水线只能读。这条约束有测试盯着。
 *
 * ## 授权评论的格式
 *
 * 维护者在 PR 的 review 里写：
 *
 * ```text
 * ship-approval: v1
 * pr: 35
 * head: b64fa225ba8195dccd2796b4c59fa612ebef9008
 * scope: scripts/lib/zip-index.mjs, scripts/scan-archive.mjs
 * note: 我审阅了归档完整性修复，确认只收紧检查、没有新增豁免。
 * ```
 *
 * `commit_id` 必须等于 `head`。这由 GitHub 记录，review 提交后再推新提交，
 * `commit_id` 不会跟着变 —— 于是「审核 A、合并 B」在数据上就可分辨。
 */

/** 授权评论的格式版本。格式变了就加一，旧评论不会被误读。 */
export const APPROVAL_COMMENT_VERSION = 'v1'

const MARKER = `ship-approval: ${APPROVAL_COMMENT_VERSION}`

/**
 * 解析一条 PR review 的正文。
 *
 * 刻意严格：缺字段、格式不对、head 不是完整 40 位，一律返回 null。宽松解析会让
 * 「看起来像授权」的文本被当成授权，而这条记录的用途是阻止发布，宁可漏认不可误认。
 *
 * @param {string} body review 正文
 * @returns {{pr: number, head: string, scope: string[], note: string}|null}
 */
export function parseApprovalComment(body) {
  const text = String(body ?? '')
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(MARKER)) return null

  const field = (name) => {
    const prefix = `${name}:`
    const line = lines.find((item) => item.startsWith(prefix))
    return line === undefined ? null : line.slice(prefix.length).trim()
  }

  const prText = field('pr')
  const head = field('head')
  const scopeText = field('scope')
  const note = field('note')

  if (prText === null || !/^\d+$/.test(prText)) return null
  if (head === null || !/^[0-9a-f]{40}$/.test(head)) return null
  if (scopeText === null) return null
  if (note === null || note.length < 10) return null

  const scope = scopeText
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (scope.length === 0) return null

  return { pr: Number(prText), head, scope, note }
}

/**
 * 从 PR 的 review 列表里找出可核对的那一条授权。
 *
 * 判据全部来自 GitHub 的记录：
 * - 作者必须是维护者（仓库 owner，或显式给出的维护者列表）；
 * - review 必须是提交过的（`submitted_at` 可解析），且 `commit_id` 等于评论里写的 head；
 * - 评论里的 PR 编号必须等于当前 PR；
 * - `commit_id` 必须等于审核锚点的 head —— 这由调用方传入 `reviewedHead`。
 *
 * 找不到就返回 `{ok:false, problems}`，绝不「先用合并事件顶着」。
 *
 * @param {object} input
 * @param {number} input.prNumber 当前 PR
 * @param {string} input.reviewedHead 审核锚点记录的 head
 * @param {Array<object>} input.reviews `pulls/{n}/reviews` 的返回
 * @param {string[]} input.maintainers 允许的维护者登录名（小写）
 * @param {(head: string) => string|null} input.treeOfHead 查 head 对应的 tree
 * @returns {{ok: boolean, approval: object|null, problems: string[]}}
 */
export function findMaintainerApproval({ prNumber, reviewedHead, reviews, maintainers, treeOfHead }) {
  const problems = []
  const allowed = new Set((maintainers ?? []).map((name) => String(name).toLowerCase()))

  const candidates = []
  for (const review of reviews ?? []) {
    const login = String(review?.user?.login ?? '').toLowerCase()
    if (!allowed.has(login)) continue
    const state = String(review?.state ?? '')
    if (state !== 'APPROVED' && state !== 'COMMENTED') continue

    const parsed = parseApprovalComment(review?.body)
    if (parsed === null) continue

    if (parsed.pr !== prNumber) {
      problems.push(`#${prNumber}：一条授权评论写的是 PR #${parsed.pr}，编号不符`)
      continue
    }
    if (review?.commit_id !== parsed.head) {
      problems.push(
        `#${prNumber}：授权评论绑定 ${parsed.head.slice(0, 12)}，但 GitHub 记录的 review 提交是 ` +
          `${String(review?.commit_id ?? '（空）').slice(0, 12)}`,
      )
      continue
    }
    if (reviewedHead !== null && parsed.head !== reviewedHead) {
      problems.push(
        `#${prNumber}：授权绑定 ${parsed.head.slice(0, 12)}，而审核锚点是 ` +
          `${String(reviewedHead).slice(0, 12)}：授权与这次审核不是同一份代码`,
      )
      continue
    }

    const tree = treeOfHead(parsed.head)
    if (tree === null) {
      problems.push(`#${prNumber}：读不到 ${parsed.head.slice(0, 12)} 的 tree，无法核对授权内容`)
      continue
    }

    candidates.push({
      schema: 1,
      kind: 'maintainer-authorization',
      pr: parsed.pr,
      head: parsed.head,
      tree,
      scope: parsed.scope,
      approver: login,
      statement: parsed.note,
      approvedAt: String(review?.submitted_at ?? ''),
      reviewId: review?.id ?? null,
    })
  }

  if (candidates.length === 0) {
    if (problems.length === 0) {
      problems.push(
        `#${prNumber}：没有来自维护者的授权 review（格式见 docs/v0.3.0-release-automation.md）。` +
          '合并事实本身不是授权。',
      )
    }
    return { ok: false, approval: null, problems }
  }

  // 多条时取最新的一条；它仍然要过 `judgeResumeAuthorization` 的绑定检查。
  candidates.sort((left, right) => Date.parse(right.approvedAt) - Date.parse(left.approvedAt))
  return { ok: true, approval: candidates[0], problems }
}

/**
 * 读一个提交上每个路径的 blob（内容指纹）。
 *
 * 用 `git rev-parse <rev>:<path>` 而不是读文件：它回答的是「这个提交里这个路径指向哪个
 * blob」，不受工作区行尾、编码、未提交改动影响。
 *
 * @param {(args: string[]) => {code: number, stdout: string}} run 执行 git 的函数
 * @param {string} rev 提交
 * @param {string[]} paths 路径
 * @returns {Array<{path: string, blob: string|null}>}
 */
export function readBlobsAt(run, rev, paths) {
  const entries = []
  for (const path of [...paths].sort()) {
    const result = run(['rev-parse', `${rev}:${path}`])
    entries.push({ path, blob: result.code === 0 ? result.stdout.trim() : null })
  }
  return entries
}

/**
 * 列出一段改动里的路径与目标提交上的 blob。
 *
 * `range` 用三点形式（`origin/main...head`）：两点会把基线前进带来的反向改动也算进来，
 * 而审核锚点要记的是「这个 PR 自己改了什么」。
 *
 * `--no-renames` 是必要的：重命名会被拆成「删除 + 新增」，而授权范围按路径登记，
 * 重命名后的新路径本来就应该出现在审核清单里。
 *
 * @param {(args: string[]) => {code: number, stdout: string}} run
 * @param {string} range 例如 `origin/main...abc123`
 * @param {string} to 目标提交（读 blob 用）
 * @returns {{ok: boolean, entries: Array<{path: string, blob: string|null}>, problems: string[]}}
 */
export function readChangedEntries(run, range, to) {
  const diff = run(['diff', '--name-status', '--no-renames', range])
  if (diff.code !== 0) {
    return { ok: false, entries: [], problems: [`读不出 ${range} 的改动清单`] }
  }

  const rows = diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status, path: rest.join('\t') }
    })

  const entries = []
  for (const row of rows) {
    if (row.path === '') continue
    const blob = run(['rev-parse', `${to}:${row.path}`])
    entries.push({ path: row.path, blob: blob.code === 0 ? blob.stdout.trim() : null })
  }
  return { ok: true, entries, problems: [] }
}
