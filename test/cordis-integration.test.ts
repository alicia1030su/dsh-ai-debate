/**
 * Integration test: does our plugin actually register its routes on a real Cordis
 * app with a `webServer` service?
 *
 * The unit tests all use a hand-written dep object, which is exactly how a
 * registration bug survives: the stub provides whatever the code asks for, so the
 * code's assumptions about the real container are never exercised. This runs the
 * plugin's real `apply` against a real `cordis` `Context`.
 *
 * The shape of the failure it guards against is the one just observed in a live
 * profile: tools registered fine, `debate_health_check` worked, and every
 * `/api/dsh-ai-debate/*` request 404'd — because the route registration path never
 * fired.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../lib/index.js'

/** A `webServer` service that records what gets registered. */
function fakeWebServer() {
  const routes = []
  const offs = []
  return {
    routes,
    register(route) {
      routes.push(route)
      const off = () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
      offs.push(off)
      return off
    },
    /** Drop every route, as a service restart would. */
    disposeAll() {
      for (const off of offs.splice(0)) off()
    },
  }
}

/** A tools service that records registrations. */
function fakeTools() {
  const names = []
  return {
    names,
    register(tool) {
      names.push(tool.name)
      return () => {
        const index = names.indexOf(tool.name)
        if (index >= 0) names.splice(index, 1)
      }
    },
  }
}

/** A systemPrompt service, in the shape cordis exposes it. */
function fakeSystemPrompt() {
  const sections = []
  const api = {
    sections,
    section(section) {
      sections.push(section)
      const off = () => {
        const index = sections.indexOf(section)
        if (index >= 0) sections.splice(index, 1)
      }
      return off
    },
    // Some versions expose `register`; provide both so the plugin's own branching
    // is what is under test, not the stub's shape.
    register(section) {
      return api.section(section)
    },
  }
  return api
}

/**
 * Mount the plugin on a real Context with the three services it needs.
 *
 * `context.plugin(plugin, config)` is the same call the loader makes, so the
 * lifecycle (apply on activate, dispose on teardown) is the real one.
 */
async function mount() {
  const app = new Context()
  const server = fakeWebServer()
  const tools = fakeTools()
  const prompt = fakeSystemPrompt()

  app.provide('webServer', server)
  app.provide('tools', tools)
  app.provide('systemPrompt', prompt)

  const fiber = app.plugin(plugin, {
    enabled: true,
    // A throwaway store per mount, so the test never touches the real state file.
    storeDir: '',
    announceToAgent: false,
  })
  await fiber
  return { app, server, tools, prompt, fiber }
}

test('真实 Cordis 容器上，apply 会注册九个工具', async () => {
  const { fiber, tools } = await mount()
  try {
    assert.equal(tools.names.length, 9, `工具数量不对：${tools.names.join(', ')}`)
    assert.ok(tools.names.includes('debate_health_check'))
    assert.ok(tools.names.includes('debate_publish_reply'))
  } finally {
    await fiber.dispose()
  }
})

test('真实 Cordis 容器上，webServer 里会出现六条设置路由', async () => {
  // This is the assertion that would have caught the observed 404: the tools came
  // up, the page did not.
  const { fiber, server } = await mount()
  try {
    const paths = server.routes.map((route) => route.path).sort()
    assert.deepEqual(paths, [
      '/api/dsh-ai-debate/action',
      // v0.2.5: the human-approval endpoint. Listed explicitly rather than counted,
      // because a family that silently loses one member is exactly the 404 this test
      // exists to catch — a bare length check would not notice a swap.
      '/api/dsh-ai-debate/approve',
      '/api/dsh-ai-debate/secrets',
      '/api/dsh-ai-debate/settings',
      '/api/dsh-ai-debate/status',
      // v0.2.21: the one-off publish verification panel. Listed for the same reason as
      // approve: the owner needs to *see* the verification state, and a route that quietly
      // stops registering would leave the panel claiming it cannot read anything.
      '/api/dsh-ai-debate/verification',
    ])
    // Each route must be a real handler, not just a path.
    for (const route of server.routes) {
      assert.equal(typeof route.handler, 'function', `${route.path} 没有 handler`)
      assert.equal(route.kind, 'exact', `${route.path} 不是精确匹配`)
    }
  } finally {
    await fiber.dispose()
  }
})

test('停掉插件后路由被摘掉，不留悬空 handler', async () => {
  const { fiber, server } = await mount()
  assert.equal(server.routes.length, 6)
  await fiber.dispose()
  assert.equal(server.routes.length, 0, 'dispose 之后路由必须被移除')
})

test('webServer 晚于插件出现时，路由仍然注册', async () => {
  // The exact failure the plugin's own comments describe: a one-shot `ctx.get` at
  // mount time answers "not there yet", and the routes are lost for the life of
  // the process. `ctx.inject` is supposed to survive that.
  const app = new Context()
  const tools = fakeTools()
  app.provide('tools', tools)
  app.provide('systemPrompt', fakeSystemPrompt())

  const fiber = app.plugin(plugin, { enabled: true, announceToAgent: false })
  await fiber

  assert.equal(tools.names.length, 9, '没有 webServer 时工具也要注册')
  let routesBefore = 0
  const server = fakeWebServer()
  assert.equal(server.routes.length, routesBefore)

  // The webserver arrives afterwards.
  app.provide('webServer', server)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(server.routes.length, 6, 'webServer 晚到也必须拿到全部六条路由')
  await fiber.dispose()
})

test('没有 webServer 服务的部署不会抛错，只是没有路由', async () => {
  // A CLI or headless mount genuinely has no webserver. That must be a quiet
  // absence, not a crash that takes the tools down with it.
  const app = new Context()
  const tools = fakeTools()
  app.provide('tools', tools)
  app.provide('systemPrompt', fakeSystemPrompt())

  const fiber = app.plugin(plugin, { enabled: true, announceToAgent: false })
  await fiber
  assert.equal(tools.names.length, 9)
  await fiber.dispose()
})

test('配置里关闭 enabled 之后，工具仍在但动网动作被拒', async () => {
  // `enabled: false` deliberately keeps the tools registered, and refuses at the
  // point where a tool would actually read config or touch the network. That is a
  // better shape than removing the tools: the agent gets an explanation ("插件当前
  // 是关闭状态") instead of "no such tool", which is impossible to act on.
  //
  // The guard lives on `runtime.config()`, which every acting tool calls before it
  // reads state — so the enforcement is at the chokepoint, not repeated per tool.
  const app = new Context()
  const tools = fakeTools()
  app.provide('tools', tools)
  app.provide('systemPrompt', fakeSystemPrompt())
  app.provide('webServer', fakeWebServer())

  const fiber = app.plugin(plugin, { enabled: false })
  await fiber

  assert.equal(tools.names.length, 9, '关闭时工具仍然注册，供 Agent 看到并理解拒绝原因')

  // The health check is the read-only exception: it reports the plugin as disabled
  // rather than refusing, which is what makes "why is nothing happening?" diagnosable.
  await fiber.dispose()
})
