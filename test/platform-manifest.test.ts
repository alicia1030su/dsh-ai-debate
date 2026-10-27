/**
 * Platform manifests and the settings view they feed.
 *
 * Two properties matter here, and both are about *not* lying:
 *
 * - a manifest never claims `supported`, because no Weibo/Zhihu/Xiaohongshu/Douyin
 *   adapter exists in this build;
 * - the settings view marks every manifest row `implemented: false` while the one
 *   real adapter is `implemented: true`, so the page cannot render a plan as a
 *   feature.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLATFORM_MANIFESTS,
  manifestOf,
  douyinManifest,
  weiboManifest,
  xiaohongshuManifest,
  zhihuManifest,
} from '../lib/platforms/manifests.js'
import { CAPABILITY_NAMES, stateOf } from '../lib/platforms/contracts.js'

test('每个未来平台都有一份 manifest，且 id 与显示名齐全', () => {
  assert.equal(PLATFORM_MANIFESTS.length, 4)
  for (const manifest of PLATFORM_MANIFESTS) {
    assert.equal(manifest.id.length > 0, true, '平台 id 不能为空')
    assert.equal(manifest.displayName.length > 0, true, `${manifest.id} 缺少显示名`)
    assert.equal(manifest.urlShapes.length > 0, true, `${manifest.id} 至少要写一种链接形状`)
    assert.equal(manifest.prerequisites.length > 0, true, `${manifest.id} 要说明实现前置条件`)
    assert.equal(manifest.constraints.length > 0, true, `${manifest.id} 要说明已知约束`)
  }
  assert.equal(manifestOf('weibo')?.displayName, '微博')
  assert.equal(manifestOf('nope'), undefined)
})

test('没有实现的平台绝不能声明任何 supported 能力', () => {
  // The whole point of a manifest-only platform: it describes what *would* be
  // needed, and claims nothing. A `supported` row here would be an untested
  // promise rendered on the settings page.
  for (const manifest of PLATFORM_MANIFESTS) {
    for (const name of CAPABILITY_NAMES) {
      const declaration = stateOf(manifest.capabilities, name)
      assert.notEqual(
        declaration.state,
        'supported',
        `${manifest.id} 的 ${name} 不能是 supported：本版本没有它的适配器`,
      )
      assert.equal(
        declaration.reason.length > 0,
        true,
        `${manifest.id} 的 ${name} 必须有原因，不能是一句空的「不支持」`,
      )
    }
  }
})

test('每个能力名在 manifest 里都有一行，不会因为漏写而显示成可用', () => {
  for (const manifest of PLATFORM_MANIFESTS) {
    for (const name of CAPABILITY_NAMES) {
      // `stateOf` falls back to `unavailable` for a missing row, so this asserts
      // the *matrix* really carries it rather than relying on the fallback.
      assert.notEqual(
        manifest.capabilities.capabilities[name],
        undefined,
        `${manifest.id} 缺少 ${name} 这一行`,
      )
    }
  }
})

test('权限不足的能力写明所需权限，而不是只写一句不可用', () => {
  // Weibo publishing is the clearest case: it is not unavailable by design, it
  // requires a write scope plus the platform's AI-content labelling rule.
  const publish = stateOf(weiboManifest.capabilities, 'comment.publish')
  assert.equal(publish.state, 'permission_required')
  assert.equal((publish.requiredPermissions ?? []).length > 0, true, '必须写明需要什么权限')
  assert.match(publish.reason, /AI|标识/, '微博发布要提到 AI 内容标识要求')
})

test('知乎的发表能力降级为手动候选，而不是假装能发', () => {
  const publish = stateOf(zhihuManifest.capabilities, 'comment.publish')
  assert.equal(publish.state, 'permission_required')
  assert.match(publish.reason, /手动发布|候选/, '没有合法发表能力时应说明降级为手动候选')
})

test('小红书与抖音只到 manifest，没有承诺任何读写能力', () => {
  for (const manifest of [xiaohongshuManifest, douyinManifest]) {
    assert.equal(manifest.research, 'survey', `${manifest.id} 的研究阶段应是最初的调研`)
    for (const name of CAPABILITY_NAMES) {
      assert.equal(
        stateOf(manifest.capabilities, name).state,
        'unavailable',
        `${manifest.id} 的 ${name} 不应有任何承诺`,
      )
    }
  }
})

test('微博把转发引用当成独立关系，不写进 reply 树', () => {
  // A forward is not a parent-child reply; conflating them corrupts the dispute
  // reconstruction, which is the one thing this plugin cannot get wrong.
  assert.match(weiboManifest.conversationShape, /转发/, '必须提到转发')
  assert.match(weiboManifest.conversationShape, /独立|不能当成父/, '必须说明它不是父子回复')
})

test('知乎把问题与答主分开，问题作者不是争论参与者', () => {
  assert.match(zhihuManifest.conversationShape, /问题/, '必须提到问题节点')
  assert.match(zhihuManifest.conversationShape, /答主|回答/, '必须说明回答者才是发言者')
})

test('manifest 的 declaredAt 是生成时间，不是验证时间', () => {
  // A `lastVerifiedAt` on a manifest row would be a fiction: nothing was
  // verified. Only `declaredAt` may be set.
  for (const manifest of PLATFORM_MANIFESTS) {
    assert.equal(
      Number.isNaN(Date.parse(manifest.capabilities.declaredAt)),
      false,
      `${manifest.id} 的 declaredAt 必须是可解析时间`,
    )
    for (const name of CAPABILITY_NAMES) {
      assert.equal(
        stateOf(manifest.capabilities, name).lastVerifiedAt,
        undefined,
        `${manifest.id} 的 ${name} 不该有验证时间：从来没有验证过`,
      )
    }
  }
})
