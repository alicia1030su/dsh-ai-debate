/**
 * v0.2.30 §六：离线导入在真实插件装配下的读模型。
 *
 * ## 这个文件防的是什么
 *
 * 第一次把离线流程接进真实宿主时，`/api/dsh-ai-debate/workbench?sessionId=…` 直接
 * 返回：
 *
 * ```
 * {"ok":false,"blockers":["读取工作台状态失败：平台「manual」没有注册。已注册：tieba、weibo"]}
 * ```
 *
 * 结果是**整条离线流程在页面上不存在**：步骤条、候选、编辑框、复制按钮全部不渲染，
 * 用户看到的是一句看起来像安装故障的话。而单元测试全绿——因为它们直接调
 * `workflow.ts`，从不经过「给页面算一个能力快照」那一步。
 *
 * 根因是 `capabilityFor` 用 `platforms.capabilitiesOf(platform)` 取能力矩阵，而
 * `getCapabilities` 对未注册的 id **抛错**。`manual` 按设计就不在注册表里
 * （它没有发表路径），于是「按设计没有平台」被当成「注册表坏了」。
 *
 * 所以这里断言的不是「代码不抛」，而是**页面上真的能看到那十一步**。
 *
 * ## 为什么要挂真实 Cordis 容器
 *
 * 手写 deps 的测试会让被测代码问什么就给什么，那正是上面这个缺陷能溜过去的原因。
 * 这里走 `ctx.plugin(plugin, config)`，与实际加载器同一条路径。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import { DebateStore } from '../lib/store.js'
import { parseText } from '../lib/import/manual.js'
import { toStoredImport } from '../lib/import/session.js'
import { MANUAL_STEP_ORDER } from '../lib/import/workflow.js'

const SAMPLE = `# 价格翻倍合理吗

原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。
---
路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。
路人乙：行业平均也才涨了三成，翻倍是漫天要价。
路人丙：两边都有道理，但翻倍确实夸张了。`

/** 一条已经导入、还没生成候选的会话。 */
function importedSession(now: string) {
  const parsed = parseText(SAMPLE)
  assert.ok(parsed.discussion !== undefined)
  const imported = toStoredImport(parsed.discussion, now)
  return {
    id: 'm-test-1',
    platform: 'manual',
    threadId: imported.threadId ?? 'local-thread',
    threadUrl: 'local://import/m-test-1',
    threadTitle: imported.title,
    forumName: '人工导入',
    ownerKey: '原帖作者',
    ownerName: '原帖作者',
    opponentKey: '路人丙',
    opponentName: '路人丙',
    disputeFloorPostId: imported.root.id ?? 'local:0',
    disputeFloorNumber: 0,
    triggerPostId: imported.root.id ?? 'local:0',
    state: 'REVIEWING' as const,
    statusText: '已导入',
    persona: { style: 'tieba_veteran', intensity: 2, maxLength: 240 },
    candidates: [],
    publishedPostIds: [],
    imported,
    comments: (imported.comments ?? []).map((entry) => ({
      postId: entry.id ?? '',
      authorName: entry.author,
      text: entry.text,
    })),
    createdAt: now,
    updatedAt: now,
  }
}

function fakeWebServer() {
  const routes: { path: string; handler: unknown; kind: string }[] = []
  return {
    routes,
    register(route: { path: string; handler: unknown; kind: string }) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** 真实容器 + 一个已导入会话的 store，返回路由表。 */
async function mountWithImportedSession(dir: string) {
  // 先把会话写进 store 文件，再挂载插件——挂载后 store 才 ready，届时读到的就是它。
  const seed = new DebateStore({ dir, maxSessions: 20 })
  await seed.ready()
  const now = '2026-11-06T00:00:00.000Z'
  await seed.mutate((data) => ({ ...data, sessions: [importedSession(now) as never] }))

  const app = new Context()
  const server = fakeWebServer()
  app.provide('webServer', server)
  app.provide('tools', { register: () => () => {} })
  app.provide('systemPrompt', { section: () => () => {} })
  // 会话认证由宿主提供，测试里给一个「不拒绝」的实现。缺了它，`authorize` 会
  // 按设计返回 403（「没有任何东西能证明这是主人的浏览器」），所有读取都读不到——
  // 那是另一条正确的拒绝路径，不是本文件要测的东西。
  app.provide('connection', { requestRejection: () => undefined })

  const fiber = app.plugin(plugin, {
    enabled: true,
    storeDir: dir,
    announceToAgent: false,
  })
  await fiber
  return { fiber, server }
}

/** 调用一条 GET 路由。 */
async function callGet(
  routes: readonly { path: string; handler: unknown }[],
  path: string,
  query: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route !== undefined, `${path} 没有注册`)
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => {
      status = code
      return response
    },
    end: (chunk?: string) => {
      payload = typeof chunk === 'string' ? chunk : ''
      return response
    },
  } as never
  const request = {
    method: 'GET',
    url: `${path}${query}`,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:51271', origin: 'http://127.0.0.1:51271' },
  } as never
  await (route.handler as (req: unknown, res: unknown) => Promise<void>)(request, response)
  return { status, json: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

test('人工导入的会话能读到工作台，而不是「平台没有注册」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v0230-wb-'))
  let fiber: { dispose(): Promise<void> } | undefined
  try {
    const mounted = await mountWithImportedSession(dir)
    fiber = mounted.fiber as never

    const result = await callGet(
      mounted.server.routes,
      '/api/dsh-ai-debate/workbench',
      '?sessionId=m-test-1',
    )

    // 第一条断言就是缺陷本身：这条路由曾经返回「平台「manual」没有注册」，
    // 于是整个页面画不出任何东西。断言的是那句话不再出现——而不是
    // 「blockers 为空」，因为一个还没选目标的会话本来就有别的 legitimate 阻断项。
    const blockers = (result.json.blockers ?? []) as readonly string[]
    assert.equal(
      blockers.some((line) => /没有注册/.test(line)),
      false,
      `工作台仍然报「平台没有注册」：${JSON.stringify(blockers)}`,
    )
    assert.equal(result.json.ok, true)
    assert.equal(result.json.sessionId, 'm-test-1')
    assert.equal(result.json.platform, 'manual')
  } finally {
    await fiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('导入会话的十一步进度真的渲染出来，而不是空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v0230-wb-'))
  let fiber: { dispose(): Promise<void> } | undefined
  try {
    const mounted = await mountWithImportedSession(dir)
    fiber = mounted.fiber as never

    const result = await callGet(
      mounted.server.routes,
      '/api/dsh-ai-debate/workbench',
      '?sessionId=m-test-1',
    )
    const flow = result.json.manualFlow as
      | { step: string; steps: { id: string; done: boolean; current: boolean }[] }
      | undefined
    assert.ok(flow !== undefined, 'manualFlow 必须存在，否则页面画不出进度')
    assert.deepEqual(
      flow.steps.map((entry) => entry.id),
      [...MANUAL_STEP_ORDER],
      '步骤顺序必须与工作流一致',
    )
    // 刚导入、还没有候选 → 当前步骤是 generate。
    assert.equal(flow.step, 'generate')
    // 只能有一个当前步骤，且当前步骤本身不算「已完成」。
    assert.equal(flow.steps.filter((entry) => entry.current).length, 1)
    assert.equal(flow.steps.find((entry) => entry.current)?.id, 'generate')
    // 会话已经存在，说明它之前的六步都发生了：导入、预览、确认、分析、选人、选人格。
    const doneBefore = flow.steps.filter((entry) => entry.done).map((entry) => entry.id)
    assert.deepEqual(doneBefore, ['import', 'preview', 'confirm', 'analyze', 'select', 'persona'])
    // 当前步骤之后的一步都不能算完成——那会把「还没做」显示成「做过了」。
    assert.equal(flow.steps.filter((entry) => entry.done && entry.id === 'generate').length, 0)
  } finally {
    await fiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('来源标识写明「人工导入 · 未经平台核验」，能力表不允许发表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v0230-wb-'))
  let fiber: { dispose(): void } | undefined
  try {
    const mounted = await mountWithImportedSession(dir)
    fiber = mounted.fiber as never

    const result = await callGet(
      mounted.server.routes,
      '/api/dsh-ai-debate/workbench',
      '?sessionId=m-test-1',
    )
    const source = result.json.source as
      | { kind: string; label: string; canProveCompleteness: boolean; allowsWrite: boolean }
      | undefined
    assert.ok(source !== undefined, '页面上必须能看到来源')
    assert.equal(source.kind, 'manual_import')
    assert.match(source.label, /人工导入/)
    assert.match(source.label, /未经平台核验/)
    assert.equal(source.canProveCompleteness, false, '导入内容无法证明完整')
    assert.equal(source.allowsWrite, false, '离线流程没有发表路径')

    // 没有候选时不能复制，并且要说清为什么。
    const flow = result.json.manualFlow as
      | { copyAllowed: boolean; copyBlockers?: readonly string[] }
      | undefined
    assert.equal(flow?.copyAllowed, false)
    assert.ok((flow?.copyBlockers ?? []).length > 0)
  } finally {
    if (fiber !== undefined) (fiber as unknown as { dispose(): Promise<void> }).dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
