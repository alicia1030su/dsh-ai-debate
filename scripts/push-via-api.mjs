/**
 * 非强制 REST 推送：git 通道不通时的备用路径。
 *
 * ## 为什么要写这个
 *
 * 这台机器上 `git push` 走 HTTPS，经常被代理掐掉（`CONNECT tunnel failed, 502`），
 * 而 GitHub 的 REST API 一直通。任务书允许这种情况使用「经过验证的非强制 REST
 * 推送通道」，但要求三件事：
 *
 * 1. 父提交必须对上远端当前的 HEAD（否则就是在别人的提交上硬接）；
 * 2. 提交之后的 tree 必须与本地算出来的完全一致；
 * 3. **不许 force**：远端如果已经前进了，就停下来，不要覆盖。
 *
 * ## 它怎么做
 *
 * 用 Git Data API 逐提交重放：
 *
 *     POST /git/blobs        每个变更文件 → blob sha
 *     POST /git/trees        base_tree = 父提交的 tree，只列变更项
 *     POST /git/commits      parent = 上一个新建的提交
 *     PATCH /git/refs/...    非强制更新
 *
 * 每一步都拿本地 `git rev-parse <rev>^{tree}` 与远端返回的 tree sha 比对。
 * 对不上就中止——**宁可推不上去，也不要推一棵与本地不同的树**。
 *
 * ## 它不是什么
 *
 * 不是通用的推送工具：只处理「远端是本地历史的祖先」这一种情况（fast-forward）。
 * 遇到分叉、遇到远端已前进，它停下来并让你用真正的 git 解决。
 */

import { execFileSync } from 'node:child_process'

const API = 'https://api.github.com'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 })
}

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const message = parsed?.message ?? text.slice(0, 200)
    throw new Error(`${method} ${path} → ${response.status} ${message}`)
  }
  return parsed
}

/** 一个提交相对其父提交的变更，按 Git Data API 的格式。 */
function changesOf(commit) {
  const parent = git('rev-parse', `${commit}^`).trim()
  const raw = git('diff-tree', '-r', '--no-commit-id', '--name-status', '-z', parent, commit)
  const parts = raw.split('\u0000').filter((entry) => entry !== '')
  const changes = []
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index]
    const path = parts[index + 1]
    if (status === undefined || path === undefined) break
    if (status.startsWith('D')) {
      changes.push({ path, deleted: true })
      continue
    }
    // 重命名（R100）会多占一个字段，这里按「新增」处理：删旧的由 D 分支负责
    changes.push({ path, deleted: false })
  }
  return { parent, changes }
}

function blobOf(commit, path) {
  const content = execFileSync('git', ['show', `${commit}:${path}`], {
    encoding: 'buffer',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  })
  return content.toString('base64')
}

async function main() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
  const branch = process.env.PUSH_BRANCH ?? ''
  const target = process.env.PUSH_TARGET ?? 'HEAD'
  const token = process.env.GITHUB_TOKEN ?? ''
  if (owner === undefined || repo === undefined || branch === '' || token === '') {
    throw new Error('需要 GITHUB_REPOSITORY、PUSH_BRANCH、GITHUB_TOKEN')
  }

  const head = git('rev-parse', target).trim()
  const remote = await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  const remoteSha = remote.object.sha
  console.log(`远端 ${branch} = ${remoteSha.slice(0, 8)}`)
  console.log(`本地 ${target} = ${head.slice(0, 8)}`)

  /**
   * ## 已推过的判定必须比 tree，不能比 sha
   *
   * 这个脚本重放出来的提交 sha 与本地不同（API 会把作者/提交者时间规范化），
   * 所以第二次调用时 `remoteSha !== head` 依然成立。如果按 sha 判断「还要不要推」，
   * 每次调用都会重放一遍——而内容其实早就是同一份了。
   *
   * 判据换成 tree：远端 head 的 tree 与本地 head 的 tree 相同，就是推过了。
   */
  const localTree = git('rev-parse', `${head}^{tree}`).trim()
  const remoteCommitProbe = await api(token, 'GET', `/repos/${owner}/${repo}/git/commits/${remoteSha}`)
  if (remoteCommitProbe.tree.sha === localTree) {
    console.log(`已经一致（tree ${localTree.slice(0, 8)}）：远端提交号与本地不同，但内容完全相同`)
    return
  }

  if (remoteSha === head) {
    console.log('已经一致，无事可做')
    return
  }

  /**
   * ## 基点的找法：按 tree 认，不按 sha 认
   *
   * 这个脚本重放出来的提交号与本地不同，所以「远端 head 是不是本地 HEAD 的祖先」
   * 在第二次调用时必然不成立——尽管内容一模一样。
   *
   * 正确的判据是：**远端 head 的 tree 等于本地哪个提交的 tree**。那个提交就是
   * 内容意义上的基点，从它往后重放即可。这样：
   *
   * - 第一次推送后远端 tree 对应本地 HEAD，下次调用直接说「已一致」；
   * - 之后本地又加了提交，远端 tree 对应本地某个中间提交，从那里往后重放；
   * - 找不到任何匹配的提交，说明两边真的分叉了——停下来让人用 git 处理。
   */
  const allLocal = git('rev-list', head).trim().split('\n').filter(Boolean)
  const base = allLocal.find((commit) => git('rev-parse', `${commit}^{tree}`).trim() === remoteCommitProbe.tree.sha)
  if (base === undefined) {
    throw new Error(
      `远端 ${remoteSha.slice(0, 8)} 的 tree 在本地历史里找不到对应提交：两边已分叉，请用 git 处理`,
    )
  }
  if (base !== head && !(() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', base, head], { shell: false })
      return true
    } catch {
      return false
    }
  })()) {
    throw new Error(`基点 ${base.slice(0, 8)} 不是 ${head.slice(0, 8)} 的祖先：请用 git 处理`)
  }

  const commits = git('rev-list', '--reverse', `${base}..${head}`).trim().split('\n').filter(Boolean)
  console.log(`需要重放 ${commits.length} 个提交`)

  /**
   * 重放出来的提交只存在于远端，本地 `git rev-parse` 查不到它们的 tree。
   *
   * 所以父树的 sha 要**跟着重放走**：第一个用远端 HEAD 的 tree（API 查一次），
   * 之后每个都用上一个新建的 tree。第一版在这里用 `git rev-parse ${parent}^{tree}`，
   * 第一个提交能过、第二个就炸——因为那个父提交是刚造出来的，本地没有。
   */
  let parent = remoteSha
  const remoteCommit = await api(token, 'GET', `/repos/${owner}/${repo}/git/commits/${remoteSha}`)
  let parentTree = remoteCommit.tree.sha

  for (const commit of commits) {
    const { changes } = changesOf(commit)

    // 每个变更文件 → blob
    const tree = []
    for (const change of changes) {
      if (change.deleted) {
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
        continue
      }
      const base64 = blobOf(commit, change.path)
      const blob = await api(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: base64,
        encoding: 'base64',
      })
      const mode = git('ls-tree', commit, '--', change.path).trim().split(' ')[0] ?? '100644'
      tree.push({ path: change.path, mode, type: 'blob', sha: blob.sha })
    }

    const newTree = await api(token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: parentTree,
      tree,
    })

    // ## 树必须与本地算出来的一致，否则中止
    //
    // 这是整个脚本最重要的一行。API 返回的树与 `git rev-parse <commit>^{tree}`
    // 不同，说明重放出来的内容与本地不是同一份——那时候推上去的就是另一棵树，
    // 而所有证据都绑在本地那棵上。
    const localTree = git('rev-parse', `${commit}^{tree}`).trim()
    if (newTree.sha !== localTree) {
      throw new Error(
        `提交 ${commit.slice(0, 8)} 的树对不上：API 返回 ${newTree.sha.slice(0, 8)}，本地是 ${localTree.slice(0, 8)}。已中止。`,
      )
    }

    const message = git('log', '-1', '--format=%B', commit)
    const authorName = git('log', '-1', '--format=%an', commit).trim()
    const authorEmail = git('log', '-1', '--format=%ae', commit).trim()
    const authorDate = git('log', '-1', '--format=%aI', commit).trim()

    const created = await api(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [parent],
      author: { name: authorName, email: authorEmail, date: authorDate },
      committer: { name: authorName, email: authorEmail, date: authorDate },
    })
    console.log(`  ${commit.slice(0, 8)} → ${created.sha.slice(0, 8)}（${changes.length} 个文件，tree 一致）`)
    parent = created.sha
    parentTree = newTree.sha
  }

  // ## 非强制更新
  //
  // `force` 不传就是 false：远端如果在这期间前进了，API 会拒绝，
  // 我们停下来重来一次，而不是把它覆盖掉。
  await api(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    sha: parent,
    force: false,
  })

  /**
   * ## 收尾校验比 tree，不比 sha
   *
   * 第一版在这里断言 `after.object.sha === head`，于是一次**完全成功**的推送报了失败。
   * 那个断言问的是「提交号一样吗」，而这件事它保证不了——API 重放的提交号必然不同。
   *
   * 能保证、也真正该问的是「内容一样吗」：远端 head 的 tree 必须等于本地 head 的 tree。
   * 这一条在每个提交重放时已经校验过一次，这里再确认一次链路末尾。
   */
  const after = await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  const afterCommit = await api(token, 'GET', `/repos/${owner}/${repo}/git/commits/${after.object.sha}`)
  if (afterCommit.tree.sha !== localTree) {
    throw new Error(
      `推送后远端的 tree 是 ${afterCommit.tree.sha.slice(0, 8)}，本地是 ${localTree.slice(0, 8)}：内容不一致`,
    )
  }
  console.log(`完成：远端 ${branch} = ${after.object.sha.slice(0, 8)}（tree ${localTree.slice(0, 8)} 与本地一致）`)
  console.log(`注：重放产生的提交号与本地不同（API 规范化了作者/提交者时间），内容相同。`)
}

main().catch((error) => {
  console.error(`失败：${error.message}`)
  process.exitCode = 1
})
