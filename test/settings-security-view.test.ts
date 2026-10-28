/**
 * The security section of the settings view.
 *
 * The point of these tests is that the page must report the **effective** state.
 * A security panel that echoes the configured default while the protection is off
 * is the one failure mode that matters: it teaches the owner to stop reading it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { EMPTY_OVERLAY } from '../lib/secrets.js'
import {
  makeSettingsRoutes,
  viewOfSettings,
  type SecurityView,
  type SettingsRouteDeps,
} from '../lib/settings-routes.js'

/** A fixed security view, so the assertions are about rendering, not computation. */
function fixedSecurity(overrides: Partial<SecurityView> = {}): SecurityView {
  return {
    protectionEnabled: true,
    strictness: 'standard',
    hardRulesEnforced: true,
    inputScanning: true,
    outputGate: true,
    stanceGuard: true,
    semanticReview: false,
    counters: { last24h: 3, blocked: 2, reviewerUnavailable: 1 },
    recent: [
      { at: '2026-10-28T09:00:00.000Z', summary: '回复攻击主人', severity: 'critical', decision: 'block' },
    ],
    ...overrides,
  }
}

/** Minimal deps: enough for `viewOfSettings`, no settings service needed. */
function makeDeps(security?: () => SecurityView): SettingsRouteDeps {
  return {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => undefined,
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => undefined,
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: true, baseUrl: 'x', model: 'y', message: 'ok' }),
    checkLogin: async () => ({ ok: true, authenticated: true, message: 'ok', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({
      stopped: [],
      refused: [],
      abortedInFlight: 0,
      alreadyPublished: 0,
    }),
    ...(security === undefined ? {} : { security }),
  }
}

test('安全视图透传到达页面', async () => {
  const view = await viewOfSettings(makeDeps(() => fixedSecurity()))
  const security = view.security as SecurityView
  assert.ok(security !== undefined, '页面必须拿到 security 字段')
  assert.equal(security.protectionEnabled, true)
  assert.equal(security.strictness, 'standard')
  assert.equal(security.counters.blocked, 2)
  assert.equal(security.recent.length, 1)
})

test('未提供安全视图时不伪造一个', async () => {
  // An older Host genuinely has no security field. Inventing a default would make
  // the page show "protection on" for a build that has no such feature.
  const view = await viewOfSettings(makeDeps())
  assert.equal('security' in view, false, '没有 security 时字段应当缺席，而不是填默认值')
})

test('关闭保护时页面必须能读到 false', async () => {
  // The bug this prevents: `securityProtection: false` in config, but the panel
  // renders the schema default `true`, so the owner believes they are protected.
  const view = await viewOfSettings(
    makeDeps(() => fixedSecurity({ protectionEnabled: false, inputScanning: false })),
  )
  const security = view.security as SecurityView
  assert.equal(security.protectionEnabled, false)
  assert.equal(security.inputScanning, false)
})

test('确定性规则永远报告为生效', async () => {
  // `hardRulesEnforced` is typed as the literal `true`. Even when the master
  // switch is off, the deterministic rules still run — reporting otherwise would
  // be a lie about the one guarantee the design makes.
  const view = await viewOfSettings(
    makeDeps(() => fixedSecurity({ protectionEnabled: false })),
  )
  const security = view.security as SecurityView
  assert.equal(security.hardRulesEnforced, true)
  assert.equal(security.outputGate, true)
  assert.equal(security.stanceGuard, true)
})

test('未启用语义审核时如实报告', async () => {
  const view = await viewOfSettings(makeDeps(() => fixedSecurity({ semanticReview: false })))
  assert.equal((view.security as SecurityView).semanticReview, false)
})

test('安全视图不含任何凭据或完整帖子文本', async () => {
  const view = await viewOfSettings(
    makeDeps(() =>
      fixedSecurity({
        recent: [
          { at: '2026-10-28T09:00:00.000Z', summary: '疑似凭据泄露', severity: 'critical', decision: 'block' },
        ],
      }),
    ),
  )
  const serialized = JSON.stringify(view.security)
  // The event summary is a label; it must never carry a value that looks like a
  // secret, because this payload goes to the browser.
  assert.doesNotMatch(serialized, /sk-|m0sk_|BDUSS|STOKEN|Bearer/)
  // And no phone number or id number.
  assert.doesNotMatch(serialized, /1[3-9]\d{9}/)
  assert.doesNotMatch(serialized, /\d{17}[\dXx]/)
})

test('设置路由能正常构造并带安全依赖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-security-route-'))
  try {
    const routes = makeSettingsRoutes(makeDeps(() => fixedSecurity()))
    assert.ok(Array.isArray(routes))
    // The route family must still expose the read path the page uses.
    assert.ok(routes.some((route) => route.path.includes('/api/dsh-ai-debate')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安全页签的严格度与配置一致', async () => {
  const view = await viewOfSettings(
    makeDeps(() => fixedSecurity({ strictness: 'relaxed' })),
  )
  assert.equal((view.security as SecurityView).strictness, 'relaxed')
})
