/**
 * 「PR 已合并后 --resume」这条路必须有 `repo`（v0.3.0 正式发布时踩到）。
 *
 * ## 这条测试为什么值得存在
 *
 * `preflight()` 返回 `{ version, repo, defaultBranch }`，而 `main()` 曾经只解构出两个。
 * 平时跑不到，因为 `repo` 只在「PR 已合并、需要读 reviews」的分支里出现 —— 而那条分支
 * 只有「人工合并后 `--resume`」才会进入。正式版发布正好走这条路，于是：
 *
 *     ReferenceError: repo is not defined
 *
 * 一个每轮都能复现、却从来没人跑到的死路。静态检查抓不到（它是运行时才求值），
 * 端到端又太重，所以这里用源码断言把「解构要包含 repo」钉住。
 *
 * 这是**结构性断言**，不是行为断言：行为断言需要伪造整条 GitHub 流程。它防的正是
 * 「变量名写错但没人走到」这一类，代价最小。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const source = readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8')

test('main 解构 preflight 时必须同时取到 repo', () => {
  const destructure = /const\s*\{([^}]*)\}\s*=\s*preflight\(\)/.exec(source)
  assert.ok(destructure, '找不到 preflight() 的解构语句')
  const names = destructure[1].split(',').map((item) => item.trim()).filter(Boolean)
  assert.ok(names.includes('repo'), `解构里缺 repo：${names.join(', ')}`)
  assert.ok(names.includes('version'), '解构里缺 version')
  assert.ok(names.includes('defaultBranch'), '解构里缺 defaultBranch')
})

test('用到 repo 的地方都在同一个作用域里', () => {
  // 只要 `main()` 里有 `repos/${repo}` 这种用法，就必须先解构出 repo。
  // 这里把「用在 main 里」这件事与上面的解构断言绑在一起，避免有人把解构删掉却留着用法。
  assert.match(source, /repos\/\$\{repo\}/, '预期仍然用 repo 拼 API 路径')
})
