/**
 * v0.2.17 §3 —— README 里的版本号必须跟着发布走。
 *
 * 真实缺陷：v0.2.16 发布后，`README.md:151/158/159/163/166` 仍然写着 0.2.16 的安装命令与
 * 附件名。发版不会自动改文档，所以**每发一次版，README 就更容易把人带到上一个版本**。
 * 用户照着 README 装到旧版，然后来报「新功能没生效」—— 这类问题排查成本极高，
 * 因为双方都以为装的是新版。
 *
 * 这里的测试都在纯文本上跑，不碰真实文件：真实 README 会被这些函数改写，
 * 拿真文件做夹具会让「改对了」和「改坏了」互相掩盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  changelogHasVersion,
  checkReadme,
  readmeVersions,
  rewriteReadme,
  staleVersionMentions,
} from '../scripts/lib/version-core.mjs'

// --- 识别版本上下文 -------------------------------------------------------

test('四种版本上下文都能被认出，并分别归类', () => {
  const text = [
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16',
    'https://github.com/alicia1030su/dsh-ai-debate/releases/tag/v0.2.16',
    '下载 dsh-ai-debate-0.2.16.tgz',
    '下载 dsh-ai-debate-source-0.2.16.zip',
  ].join('\n')

  const found = readmeVersions(text)
  assert.deepEqual([...found.keys()].sort(), ['Release 链接', '安装包名', '安装命令', '源码包名'])
  for (const versions of found.values()) {
    assert.deepEqual([...versions], ['0.2.16'])
  }
})

test('历史叙述里的版本号不算「文档让人装哪个版本」', () => {
  // 这类句子必须留着原版本，改掉就是篡改历史。
  const text = [
    '从 v0.2.12 起，CLI 才真正被调用。',
    'v0.2.15 修掉了源码包泄漏。',
    '当前安装：dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16',
  ].join('\n')

  const found = readmeVersions(text)
  assert.equal(found.size, 1, '只有安装命令那一处算')
  assert.deepEqual([...found.get('安装命令')], ['0.2.16'])
})

test('一个版本上下文都不存在时要报错，不能默认通过', () => {
  // 没有上下文 = 无法确认文档指向哪一版。静默通过会让 README 悄悄脱离发布。
  const problems = checkReadme('这个 README 完全不提安装。', '0.2.17')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /找不到任何版本上下文/)
})

// --- 一致性检查 -----------------------------------------------------------

test('四处都指向当前版本时没有意见', () => {
  const text = [
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.17',
    'https://github.com/alicia1030su/dsh-ai-debate/releases/tag/v0.2.17',
    'dsh-ai-debate-0.2.17.tgz',
    'dsh-ai-debate-source-0.2.17.zip',
  ].join('\n')

  assert.deepEqual(checkReadme(text, '0.2.17'), [])
})

test('只改了安装命令、漏了附件名，要分别指出是哪一处', () => {
  // 这条直接对应 v0.2.16 的真实状况：安装命令是新的，附件名还是旧的。
  const text = [
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.17',
    'dsh-ai-debate-0.2.16.tgz',
  ].join('\n')

  const problems = checkReadme(text, '0.2.17')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /安装包名/)
  assert.match(problems[0], /0\.2\.16/)
  assert.match(problems[0], /0\.2\.17/)
})

test('同类上下文里出现两个不同版本也要报，而不是取随便一个', () => {
  const text = [
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16',
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.17',
  ].join('\n')

  const problems = checkReadme(text, '0.2.17')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /多个版本/)
})

// --- 精确改写 -------------------------------------------------------------

test('改写四种上下文，历史叙述原样保留', () => {
  const before = [
    '从 v0.2.12 起，CLI 才真正被调用。',
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16',
    'https://github.com/alicia1030su/dsh-ai-debate/releases/tag/v0.2.16',
    'dsh-ai-debate-0.2.16.tgz 与 dsh-ai-debate-source-0.2.16.zip',
  ].join('\n')

  const after = rewriteReadme(before, '0.2.16', '0.2.17')

  assert.match(after, /从 v0\.2\.12 起/, '历史叙述不能动')
  assert.match(after, /#v0\.2\.17/)
  assert.match(after, /releases\/tag\/v0\.2\.17/)
  assert.match(after, /dsh-ai-debate-0\.2\.17\.tgz/)
  assert.match(after, /dsh-ai-debate-source-0\.2\.17\.zip/)
  assert.doesNotMatch(after, /0\.2\.16/, '旧版本号应当一处不剩')
})

test('短版本号不会吃掉长版本号的前缀', () => {
  // 没有 `(?![\d.])` 的话，从 0.2.1 升到 0.2.2 时 `v0.2.16` 会被改成 `v0.2.26`。
  const before = [
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16',
    'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.1',
  ].join('\n')

  const after = rewriteReadme(before, '0.2.1', '0.2.2')

  assert.match(after, /#v0\.2\.16/, '0.2.16 必须原封不动')
  assert.match(after, /#v0\.2\.2$/, '0.2.1 要变成 0.2.2')
})

test('改写两次之后内容不会继续漂移（幂等）', () => {
  const start = 'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16'

  const once = rewriteReadme(start, '0.2.16', '0.2.17')
  const twice = rewriteReadme(once, '0.2.16', '0.2.17')

  assert.equal(twice, once, '第二次没有 0.2.16 可改，结果必须不变')
})

test('没有旧版本可改时原文一字不动', () => {
  const text = '这是一个跟版本无关的段落。\n第二行也一样。'
  assert.equal(rewriteReadme(text, '0.2.16', '0.2.17'), text)
})

test('改写只碰这四个上下文，别的数字不误伤', () => {
  const text = [
    'Node 24.22.1 与 pnpm 11.28.5 是当前实测环境。',
    '| v0.2.16 | 1067 项测试 |',
  ].join('\n')

  const after = rewriteReadme(text, '0.2.16', '0.2.17')
  assert.match(after, /Node 24\.22\.1/, '依赖版本不能被当成发布版本改掉')
  assert.match(after, /pnpm 11\.28\.5/)
  assert.match(after, /\| v0\.2\.16 \|/, '表格里的历史记录不是安装上下文，不动')
})

// --- CHANGELOG ------------------------------------------------------------

test('CHANGELOG 段落识别只认二级标题那一行', () => {
  const changelog = ['## [0.2.17] - 2026-11-01', '', '### 一、自动交付', '正文提到 0.2.16'].join('\n')

  assert.equal(changelogHasVersion(changelog, '0.2.17'), true)
  assert.equal(changelogHasVersion(changelog, '0.2.16'), false, '正文里提到不算有段落')
  assert.equal(changelogHasVersion(changelog, '0.2.18'), false)
})

test('CHANGELOG 段落匹配不会被正则元字符带跑', () => {
  const changelog = '## [1.0.0]\n\n内容\n'
  assert.equal(changelogHasVersion(changelog, '1.0.0'), true)
  assert.equal(changelogHasVersion(changelog, '1.0.00'), false)
  assert.equal(changelogHasVersion(changelog, '1x0x0'), false)
})

// --- 陈旧提及（只作提示） -------------------------------------------------

test('安装说明附近的旧版本号能被找出来，并给出行号', () => {
  const text = [
    '## 安装',
    '',
    '方式一：dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.16',
    '方式二：下载 dsh-ai-debate-0.2.15.tgz',
    '',
    '历史：v0.2.12 起 CLI 才被真正调用。',
  ].join('\n')

  const stale = staleVersionMentions(text, '0.2.17')

  assert.equal(stale.length, 2, '两行安装说明各算一条')
  assert.equal(stale[0].line, 3)
  assert.equal(stale[0].version, '0.2.16')
  assert.equal(stale[1].version, '0.2.15')
  // 「历史：v0.2.12 起…」那一行不含安装相关词，不该被当成陈旧安装说明。
  assert.ok(!stale.some((item) => item.version === '0.2.12'))
})

test('已经全是当前版本时没有陈旧提及', () => {
  const text = 'dsh plugin add github:alicia1030su/dsh-ai-debate#v0.2.17\n下载 dsh-ai-debate-0.2.17.tgz'
  assert.deepEqual(staleVersionMentions(text, '0.2.17'), [])
})
