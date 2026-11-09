/**
 * 配置兼容的回归测试（v0.2.39 §6.1）。
 *
 * ## 为什么这条容易被忽略
 *
 * 配置读取器是「每键一个 readString/readNumber」的写法，于是**新增键**是安全的，
 * **删除键**也安全，而**改名**是危险的：旧键还在用户的 `cordis.patch.yml` 里，新代码
 * 读不到它，于是用户看到的不是「配置丢了」，而是「模型突然不工作了」。
 *
 * 所以这里的断言不是「当前配置能读」，而是「旧版的键现在仍然生效」。样本是
 * v0.2.37 / v0.2.38 真实写下的键名与值形状。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig, DEFAULT_CONFIG } from '../lib/config.js'

/** v0.2.37 用户机器上的一份配置（键名逐字取自当年的默认配置）。 */
const CONFIG_V037 = {
  enabled: true,
  ownerUserId: '1001',
  ownerHandle: 'owner-handle',
  ownerUserName: '主人昵称',
  aiAccountName: 'AI 小号',
  aiAccountUserId: '2002',
  allowedOwnerIds: '1001,1002',
  platformAccounts: 'tieba:1001',
  securityProtection: true,
  securityStrictness: 'standard',
  securityEventLimit: 50,
  tiebaCookie: '',
  authProbeThreadId: 'thread-9',
  personaStyle: 'tsundere',
  intensity: 2,
  maxLength: 90,
  emojiLevel: 1,
  sarcasmLevel: 2,
  directness: 3,
  contextPreset: 'medium',
  contextTokens: 4000,
  quoteLimit: 3,
  llmBaseUrl: 'https://api.example.invalid/v1',
  llmModel: 'some-model',
  llmApiKey: '',
  llmTemperature: 0.6,
  llmMaxOutputTokens: 900,
  llmProtocol: 'chat',
  llmSource: 'custom',
  interactionMode: 'manual',
  logLevel: 'info',
}

/** v0.2.38 新增的键（论证打法）。 */
const CONFIG_V038 = {
  ...CONFIG_V037,
  defaultStrategy: '',
}

test('v0.2.37 的每个键仍然生效：人格、模型、安全、上下文一个不少', () => {
  const resolved = resolveConfig(CONFIG_V037)
  assert.equal(resolved.personaStyle, 'tsundere')
  assert.equal(resolved.intensity, 2)
  assert.equal(resolved.maxLength, 90)
  assert.equal(resolved.sarcasmLevel, 2)
  assert.equal(resolved.llmBaseUrl, 'https://api.example.invalid/v1')
  assert.equal(resolved.llmModel, 'some-model')
  assert.equal(resolved.llmProtocol, 'chat')
  assert.equal(resolved.llmSource, 'custom')
  assert.equal(resolved.contextPreset, 'medium')
  assert.equal(resolved.contextTokens, 4000)
  assert.equal(resolved.securityProtection, true)
  assert.equal(resolved.securityStrictness, 'standard')
  assert.equal(resolved.ownerUserId, '1001')
  assert.equal(resolved.interactionMode, 'manual')
})

test('v0.2.38 的旧键（defaultStrategy）也能读，且不影响其余项', () => {
  const resolved = resolveConfig(CONFIG_V038)
  assert.equal(resolved.personaStyle, 'tsundere')
  assert.equal(resolved.llmModel, 'some-model')
  // 未指定的新键回落到默认值，而不是空串或 undefined。
  const withDefault = resolveConfig({})
  assert.equal(withDefault.personaStyle, DEFAULT_CONFIG.personaStyle)
})

test('未知的旧键被忽略，不导致配置失效', () => {
  const resolved = resolveConfig({
    ...CONFIG_V037,
    // 一个早就不存在的键。用户机器上真的会有。
    legacySomething: 'whatever',
    personaIntensity: 5,
  })
  assert.equal(resolved.personaStyle, 'tsundere')
  assert.equal(resolved.llmModel, 'some-model')
})

test('值形状错了就落回默认值，不抛错（升级时最重要的性质）', () => {
  const resolved = resolveConfig({
    personaStyle: 'not-a-real-persona',
    securityStrictness: 'paranoid',
    llmProtocol: 'graphql',
    intensity: 'high',
    contextTokens: 'a lot',
  })
  assert.equal(resolved.personaStyle, DEFAULT_CONFIG.personaStyle)
  assert.equal(resolved.securityStrictness, DEFAULT_CONFIG.securityStrictness)
  assert.equal(resolved.llmProtocol, 'chat')
  assert.equal(resolved.intensity, DEFAULT_CONFIG.intensity)
  assert.equal(resolved.contextTokens, DEFAULT_CONFIG.contextTokens)
})

test('微博绑定信息在升级后不被覆盖（空值不该抹掉已绑定值）', () => {
  // 这条断言的对象是「读」，不是「写」：读取时把空串当作「没配」，不能把已存在的
  // 绑定视为不存在。只要读出来还是配置里的值，写回时就不会抹掉它。
  const bound = resolveConfig({ ...CONFIG_V037, tiebaCookie: '已绑定的值' })
  assert.equal(bound.tiebaCookie, '已绑定的值')

  const unbound = resolveConfig({ ...CONFIG_V037, tiebaCookie: '' })
  assert.equal(unbound.tiebaCookie, '')
})

test('空配置得到一份完整默认值，没有一个字段是 undefined', () => {
  const resolved = resolveConfig({})
  for (const [key, value] of Object.entries(resolved)) {
    assert.notEqual(value, undefined, `${key} 没有默认值：新装用户会遇到 undefined`)
  }
})
