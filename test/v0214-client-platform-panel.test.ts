/**
 * v0.2.14 §九：客户端必须保留并渲染平台块。
 *
 * ## 这个文件防的是真实界面验收里抓到的那一类缺陷
 *
 * 单元测试断言了路由返回 `platforms`，路由确实返回了。客户端 `refreshStatus()` 也**真的拿到了**
 * 那个响应——但它只存了 `this.status`，没有把 `status.platforms` 复制到 `platformBlocks`，
 * 而面板读的是后者。于是：
 *
 * - Host：正确，返回 1 个平台、7 行状态
 * - Client 数据层：正确，响应里有 platforms
 * - **渲染：全空**，每个平台都显示「没有提供实时诊断」
 *
 * 这是「数据端到端都存在，最后一跳丢掉了」。它只能被真实界面验收发现，所以这里用源码级断言
 * 把最后一跳钉住 —— 不是模拟渲染，是检查那条赋值真的在。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const CLIENT = readFileSync(join(import.meta.dirname, '..', 'client', 'client.cjs'), 'utf8')

test('客户端：refreshStatus 把 status.platforms 存进 platformBlocks（§九.1）', () => {
  // The exact line the live run proved was missing. Without it the panel renders "no live
  // diagnostic" for every platform while the Host sends real state.
  assert.match(
    CLIENT,
    /this\.platformBlocks\s*=\s*Array\.isArray\(blocks\)\s*\?\s*blocks\s*:\s*undefined/,
    'refreshStatus 必须保存平台块',
  )
  assert.match(CLIENT, /const blocks = this\.status && this\.status\.platforms/, '平台块来自同一响应')
})

test('客户端：platformBlocks 有初始值，不会渲染成未定义错误（§九.10）', () => {
  assert.match(CLIENT, /this\.platformBlocks = undefined/, 'store 要初始化这个字段')
  assert.match(CLIENT, /platformBlocks: this\.platformBlocks/, '快照要带出去给组件读')
})

test('客户端：refreshPlatforms 用 POST 触发受控重探（§九.3）', () => {
  assert.match(CLIENT, /async refreshPlatforms\(\)/, '必须有刷新方法')
  assert.match(CLIENT, /action:\s*'refresh-platforms'/, '刷新要打这个动作')
  // The platform list in the answer replaces the cache; a failure must not look like success.
  assert.match(CLIENT, /this\.probes = \{\s*\.\.\.this\.probes,\s*platforms:\s*\{\s*state:\s*'failed'/, '失败要标记为 failed')
})

test('客户端：PlatformLiveBlock 存在并渲染 lines（§九.5/§九.8）', () => {
  assert.match(CLIENT, /function PlatformLiveBlock\(props\)/, '组件必须存在')
  assert.match(CLIENT, /Array\.isArray\(live\.lines\) \? live\.lines : \[\]/, '逐条渲染，不丢弃字段')
  // The unknown state must not render as a green badge.
  assert.match(CLIENT, /line\.state === 'not_implemented'/, '未知要单独处理')
  assert.match(CLIENT, /t\('platformLiveUnknown'\)/, '未知要有可读文案')
})

test('客户端：平台未回答时说明「没有提供实时诊断」，不是静默（§九.5）', () => {
  assert.match(CLIENT, /platformLiveNone/, '缺块要有文案')
  assert.match(CLIENT, /platformLiveFailed/, '失败要有文案')
})

test('客户端：诊断文本里不出现任何凭据形状（§九.9）', () => {
  // The page must never echo a cookie or key. Scan the rendered strings for credential shapes.
  const credentialShapes = [/BDUSS=[A-Za-z0-9]{10,}/, /\bST=[A-Za-z0-9]{8,}/, /sk-[A-Za-z0-9]{16,}/]
  for (const shape of credentialShapes) {
    assert.equal(shape.test(CLIENT), false, `客户端源码里不该出现凭据形状：${shape}`)
  }
})

test('客户端：打开页面时就拉取平台状态，不必等用户点刷新（§九.2）', () => {
  // The live run's second finding: `refreshStatus` stored the blocks, but nothing called it on
  // mount, so the panel said "no live diagnostic" for every platform until the owner pressed
  // refresh. Data present in the API, wrong on first open.
  assert.match(CLIENT, /Promise\.allSettled/, 'load() 要同时拉 settings 与 status')
  assert.match(CLIENT, /callJson\(ROUTE_STATUS\)/, 'status 必须在首次加载时请求')
  // A status failure must not blank the form: allSettled, not all.
  assert.match(
    CLIENT,
    /if \(settingsResult\.status === 'rejected'\) throw settingsResult\.reason/,
    '只有设置加载失败才算整页失败',
  )
})
