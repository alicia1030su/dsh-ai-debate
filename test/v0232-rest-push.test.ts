/**
 * v0.2.32 §七：git 通道不通时的非强制 REST 推送。
 *
 * ## 为什么需要它
 *
 * 这台机器上 `git push` 走 HTTPS，经常被代理掐断（`CONNECT tunnel failed, 502`），
 * 而 GitHub REST API 一直通。任务书允许这种情况使用「经过验证的非强制 REST
 * 推送通道」，但要求三件事：核对父提交、核对远端 HEAD、核对 tree 一致。
 *
 * ## 这个文件测什么、不测什么
 *
 * **测**：脚本文本里必须存在的那些守卫——非强制、tree 校验、父提交校验。
 * 这些是「读代码就能验」的性质，写成断言是为了防止以后有人图省事把 `force`
 * 打开或把 tree 校验删掉。
 *
 * **不测**：真实推送。那会改动远端仓库，不是单元测试该做的事；本轮的真实推送
 * 是手工验证的（输出记录在交付报告里）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const scriptPath = join(import.meta.dirname, '..', 'scripts', 'push-via-api.mjs')
const source = readFileSync(scriptPath, 'utf8')

test('REST 推送必须是非强制的：不许出现 force: true', () => {
  assert.equal(
    /force:\s*true/.test(source),
    false,
    '这个脚本的路由价值就是「不会覆盖别人的提交」。一旦允许 force，它与强推没有区别',
  )
  assert.match(source, /force:\s*false/, '要显式写 false，让读代码的人看得见这个决定')
})

test('每个重放的提交都要校验 tree 与本地一致', () => {
  assert.match(
    source,
    /newTree\.sha !== localTree/,
    '必须逐个提交比对 tree：API 返回的树与本地不同，说明重放的不是同一份内容',
  )
  assert.match(source, /已中止/, '不一致时要中止，并说清为什么')
})

test('推送后要再核对一次远端的 tree', () => {
  assert.match(
    source,
    /afterCommit\.tree\.sha !== localTree/,
    '收尾要确认远端 head 的 tree 与本地一致——这条是第一版漏掉的',
  )
})

test('「已推过」的判定要比 tree，不能比 sha', () => {
  /**
   * 第一版按 sha 判断，于是每次调用都会重放一遍：API 重放出来的提交号必然与本地
   * 不同（作者/提交者时间被规范化），`remoteSha !== head` 永远成立。
   *
   * 判据必须是内容：远端 head 的 tree 等于本地 head 的 tree，就是推过了。
   */
  assert.match(
    source,
    /remoteCommitProbe\.tree\.sha === localTree/,
    '必须按 tree 判断「已一致」',
  )
})

test('基点按 tree 在本地历史里找，找不到就停', () => {
  assert.match(
    source,
    /allLocal\.find\(/,
    '远端 head 的 tree 对应本地哪个提交，那个提交才是内容意义上的基点',
  )
  assert.match(source, /两边已分叉/, '找不到就明确说分叉，不要硬接')
})

test('凭据只从环境变量读，不写在脚本里', () => {
  assert.match(source, /process\.env\.GITHUB_TOKEN/, 'token 从环境读')
  assert.equal(
    /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(source),
    false,
    '脚本里不能出现任何形似令牌的字符串',
  )
})

test('脚本不会替代 git：它明确说了自己只处理 fast-forward 情形', () => {
  assert.match(source, /请用 git 处理/, '遇到分叉要让人回到 git，而不是在这里猜')
})
