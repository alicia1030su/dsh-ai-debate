/**
 * v0.2.17 §五 —— DSH 兼容性与业务保护：插件「装上去」和「跑起来」之间那段没人测的路。
 *
 * 前面几十个测试文件都在测「逻辑对不对」。它们全绿，插件依然可能是一个装进 DSH 之后
 * 根本挂不上、或者挂上了但用户改设置没反应、或者把真实平台的失败写成「验收通过」的东西。
 * 这个文件专门钉那一段：
 *
 * ## 1. 配置 schema 与历史配置迁移（`src/config.ts`）
 *
 * 用户升级插件时，profile 里躺着的是**上个版本写下的**配置。三种事故都真发生过：
 * 新增一个 schema 字段却忘了加默认值（`DEFAULT_CONFIG` 少一个键 → 手搭的测试上下文与
 * Host 给的上下文形状不一致）；旧档案里有个拼错的枚举值（`personaStyle: "veteran"`），
 * 而解析代码把它原样带进策略判断；以及 `.volatile()` 字段以 `{ get() }` 引用形式传入时
 * 没被解开，于是「关闭插件」这个动作静默失效。这里不测 schemastery 的校验行为，只测
 * `resolveConfig()` 这个**运行时归一化**层对历史/脏数据的态度：脏值退回默认，
 * 未知字段丢弃，字符串 trim，**不崩**。
 *
 * ## 2. 历史存储状态兼容（`src/store.ts`）
 *
 * 状态文件里最要紧的不是会话，是 `dedupe` 台账：它记着「这个召唤已经回过了」。
 * 读文件时把「版本不认识」当成「空库继续跑」，等于把台账清空 —— 下一次同一个召唤进来，
 * 插件会在众目睽睽之下再回一遍。所以 `validateStore()` 对新版本/旧版本/非对象一律拒绝，
 * 拒绝原因还得带上那个版本号，用户才知道该拿哪个版本打开它。这条不是洁癖：
 * 它决定了一个坏文件是「停下来让人修」还是「静默重发」。
 *
 * ## 3. 安装/升级后的入口与打包一致性（`package.json` + 磁盘）
 *
 * `main` / `types` / `exports` 里写着一个不存在的路径时，`tsc` 全绿、测试全绿、发布全绿，
 * 只有装插件的人看到「插件加载失败」。`files` 白名单同样：漏了 `client/client.cjs`，
 * Web GUI 的配置页就整块消失；多带了 `src/`，装插件的人会拿到一份和他的 `lib/` 不同步的源码。
 *
 * `dependencies` 只允许 `@deepseek-ai/` 前缀这一条，防的是 v0.2.16 之前的真实事故：
 * 插件在 `dependencies` 里带了自己的 DSH 核心运行时模块版本（rc.2 / rc.5 的差距），
 * 于是「装一个插件」变成了「顺带把 Host 的核心模块换成另一个版本」，两边对不上就崩。
 * 插件只能声明 peer 依赖，版本由 Host 决定。
 *
 * ## 4. bundle patch 与 settings 命名空间三方一致（`cordis.patch.yml`）
 *
 * patch 顶部注释写着三处必须一致：row `id`、settings namespace（`src/index.ts` 的 `name`）、
 * `package.json` 的包名。任一处写错，Plugins 页就不会长出「配置」控件，配置页永远不出现，
 * 而没有任何报错 —— 用户只会说「这插件没有设置」。另一半：patch 的 `config:` 块里如果配了
 * schema 不认识的键，用户改了设置会被 `resolveConfig()` 静默丢掉，设置页看起来保存成功。
 *
 * ## 5. 真实平台调用的三档区分（`src/platforms/weibo/`）
 *
 * v0.2.15 的教训：`evidence.level === 'live_call'` 被当成「验证过了」。一次成功调用只证明
 * 命令能跑，**不证明返回的回复真的挂在被请求的那条评论下面**；把这两件事混成一个徽章，
 * 就是「把 mock 写成真实读取成功」的低配版。所以这里钉住：档位词汇只有四个，
 * `live_call` 的措辞里不许出现「已验证可用」，`fully_verified` 只能由带父子关系证据的
 * 显式构造给出，`capabilityEvidence()` 的调用点不许把它写死。
 *
 * 断言的都是「结构性质」，不是具体文案或行号：文案会改，结构不该改。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config, DEFAULT_CONFIG, resolveConfig, splitIds } from '../lib/config.js'
import { capabilityEvidence } from '../lib/platforms/weibo/invocation-plan.js'
import { describeEvidenceLevel } from '../lib/platforms/weibo/provider.js'
import { TERMINAL_STATES, emptyStore, validateStore } from '../lib/store.js'

const ROOT = join(import.meta.dirname, '..')

function readText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** package.json 里这个测试用到的字段。不引 `resolveJsonModule`，那会把产物也搬进测试。 */
interface PackageShape {
  readonly name: string
  readonly version: string
  readonly main?: string
  readonly types?: string
  readonly exports: Record<string, string | Record<string, string>>
  readonly files: readonly string[]
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly engines?: Record<string, string>
}

function readPackage(): PackageShape {
  return JSON.parse(readText('package.json')) as PackageShape
}

/**
 * 取 `cordis.patch.yml` 里 `- id:` 的值。
 *
 * 只处理我们自己的这一份补丁，所以不引 YAML 解析器：为了读两行结构去加一个运行时依赖，
 * 比测试本身更容易出问题。
 */
function patchRowId(text: string): string {
  const match = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(text)
  assert.ok(match, 'cordis.patch.yml 里找不到 `- id: …` 行')
  return match[1]
}

/** 按缩进把 `config:` 块切成 `{ key, raw }`；raw 是冒号右边没解过的标量文本。 */
function patchConfigEntries(text: string): { key: string; raw: string }[] {
  const entries: { key: string; raw: string }[] = []
  let configIndent: number | null = null

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    if (configIndent === null) {
      if (/^config:\s*$/.test(trimmed)) configIndent = indent
      continue
    }
    // 缩进回到 config 的层级或更浅，说明这块结束了。
    if (indent <= configIndent) break

    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed)
    if (match !== null) entries.push({ key: match[1], raw: match[2] })
  }
  return entries
}

/** 把补丁里的标量文本解成 JS 值：`''` / true / false / 数字 / 裸字符串。 */
function yamlScalar(raw: string): unknown {
  const text = raw.trim()
  if (text === "''" || text === '""') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && Number.isFinite(Number(text))) return Number(text)
  return text
}

/**
 * 取源码里每一处 `capabilityEvidence(...)` **调用**的完整括号内容。
 *
 * 定义处（`export function capabilityEvidence(`）要跳过：它体内本来就有 `'fully_verified'`，
 * 那是对的 —— 这个字面量只许在那里由父子关系证据推出来。
 */
function capabilityCallSites(source: string): string[] {
  const marker = 'capabilityEvidence('
  const sites: string[] = []
  let from = 0

  for (;;) {
    const at = source.indexOf(marker, from)
    if (at === -1) break

    // 定义处的 16 个字符前缀是 `export function `。
    if (source.slice(Math.max(0, at - 20), at).includes('function ')) {
      from = at + marker.length
      continue
    }

    // 这些调用里没有字符串字面量包含括号，所以只按圆括号配对即可。
    let depth = 0
    let end = at + marker.length - 1
    for (let i = at + marker.length - 1; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    sites.push(source.slice(at, end + 1))
    from = end + 1
  }
  return sites
}

// ---------------------------------------------------------------------------
// 1. 配置 schema 与历史配置迁移
// ---------------------------------------------------------------------------

test('配置：空输入解析出的每一项都等于 DEFAULT_CONFIG', () => {
  const resolved = resolveConfig({})
  assert.deepEqual(resolved, DEFAULT_CONFIG, '空配置必须逐字段等于默认值，否则手搭上下文与 Host 上下文行为不同')
})

test('配置：schema 字段、默认值表、解析结果三者键集合完全一致', () => {
  // schemastery 的 object 把字段挂在 `dict` 上；这里只读字段名，不测它的校验行为。
  const schemaKeys = Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict)
  assert.ok(schemaKeys.length > 20, 'schema dict 没读到，后面的键集合断言会变成空集比较')

  assert.deepEqual(
    new Set(schemaKeys),
    new Set(Object.keys(DEFAULT_CONFIG)),
    'schema 加了字段却忘了给 DEFAULT_CONFIG 加默认值（或反过来）',
  )
  assert.deepEqual(
    new Set(Object.keys(resolveConfig({}))),
    new Set(schemaKeys),
    'resolveConfig 少写/多写了一个字段：少了就永远拿默认值，多了就绕过 schema',
  )
})

test('配置：未知字段被丢弃，不会跟着原始对象透传进运行时', () => {
  const resolved = resolveConfig({ nope: 1, another: 'x', personaStyle: 'aloof' })
  assert.equal('nope' in resolved, false, '未知字段没被丢掉：拼错的键会一直躺在配置对象里')
  assert.equal('another' in resolved, false)
  // 合法的那个必须还在，否则这条断言只是「什么都丢了」。
  assert.equal(resolved.personaStyle, 'aloof')
})

test('配置：非法枚举值退回默认，拼错的档位不会被当成有效策略', () => {
  assert.equal(resolveConfig({ personaStyle: 'x' }).personaStyle, 'tieba_veteran')
  assert.equal(resolveConfig({ logLevel: 'verbose' }).logLevel, 'info')
  assert.equal(resolveConfig({ contextPreset: 'huge' }).contextPreset, 'small')
  assert.equal(resolveConfig({ interactionMode: 'auto' }).interactionMode, 'manual')
  assert.equal(resolveConfig({ securityStrictness: 'paranoid' }).securityStrictness, 'standard')

  // 合法值必须原样保留：一律退回默认的实现也能让上面五条变绿。
  assert.equal(resolveConfig({ personaStyle: 'aloof' }).personaStyle, 'aloof')
  assert.equal(resolveConfig({ securityStrictness: 'strict' }).securityStrictness, 'strict')
  assert.equal(resolveConfig({ interactionMode: 'limited_auto' }).interactionMode, 'limited_auto')
})

test('配置：温度与输出上限被 clamp 进 schema 区间，不会原样喂给模型', () => {
  assert.equal(resolveConfig({ llmTemperature: 99 }).llmTemperature, 2)
  assert.equal(resolveConfig({ llmTemperature: -5 }).llmTemperature, 0)
  assert.equal(resolveConfig({ llmTemperature: 0.9 }).llmTemperature, 0.9, '区间内的值不能被 clamp 掉')
  assert.equal(resolveConfig({ llmTemperature: 'hot' }).llmTemperature, 0.4, '非数字退回默认')
  assert.equal(resolveConfig({ llmMaxOutputTokens: 999999 }).llmMaxOutputTokens, 32000)
  assert.equal(resolveConfig({ llmMaxOutputTokens: -1 }).llmMaxOutputTokens, 0)
})

test('配置：intensity 一类数字**没有** clamp（实测行为），只保证不变成 NaN', () => {
  // ⚠️ 这条钉的是代码的实际行为，不是 schema 的承诺：
  // `Config` 给 intensity 写了 `min(1).max(5)`，但 `resolveConfig()` 只对
  // `llmTemperature` / `llmMaxOutputTokens` 调用了 `clampNumber()`，其余数字字段只做
  // 「是数字且有限」的检查。所以 99 会原样穿过归一化层。
  // 一旦有人补上 clamp，这里会变红并提醒把注释和断言一起改成 clamp 后的值。
  const sharp = resolveConfig({ intensity: 99 })
  assert.equal(Number.isFinite(sharp.intensity), true, '至少不能是 NaN/Infinity')
  assert.equal(sharp.intensity, 99, '当前实现不 clamp intensity；这条是行为钉，不是正确性认可')

  assert.equal(resolveConfig({ intensity: 'x' }).intensity, 3, '非数字退回默认')
  assert.equal(resolveConfig({ intensity: Number.NaN }).intensity, 3, 'NaN 必须退回默认')
  assert.equal(Number.isFinite(resolveConfig({ maxLength: 1e9 }).maxLength), true)
})

test('配置：字符串字段 trim，全空白等于没配', () => {
  assert.equal(resolveConfig({ ownerUserId: '  42  ' }).ownerUserId, '42')
  assert.equal(resolveConfig({ ownerUserName: ' \t  ' }).ownerUserName, '')
  assert.equal(resolveConfig({ storeDir: '  /tmp/x  ' }).storeDir, '/tmp/x')
  assert.equal(resolveConfig({ allowedOwnerIds: ' 1, 2 ' }).allowedOwnerIds, '1, 2', '值的内部空格不能被动')
})

test('配置：类型不对的值退回默认而不是抛异常（脏 profile 不能让插件挂不上）', () => {
  assert.equal(resolveConfig({ ownerUserName: 123 }).ownerUserName, '')
  assert.equal(resolveConfig({ enabled: 'yes' }).enabled, true)
  assert.equal(resolveConfig({ maxLength: null }).maxLength, 150)
  assert.equal(resolveConfig({ llmTemperature: {} }).llmTemperature, 0.4)

  // 整体输入是 null/undefined 时也得有结果：Host 在首次挂载时确实会传空。
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
})

test('配置：.volatile() 的 { get() } 引用被 unwrap，get() 返回 null 时退回默认', () => {
  assert.equal(resolveConfig({ enabled: { get: () => false } }).enabled, false, 'volatile 引用没解开会让「关闭」失效')
  assert.equal(resolveConfig({ enabled: { get: () => null } }).enabled, true)
  assert.equal(resolveConfig({ ownerUserId: { get: () => ' 7 ' } }).ownerUserId, '7')
  assert.equal(
    resolveConfig({ enabled: { get: () => 'false' } }).enabled,
    true,
    'get() 返回非布尔仍退回默认，不能把字符串 "false" 当假',
  )
})

test('配置：splitIds 认半角/全角逗号与空白，空串得到空数组', () => {
  assert.deepEqual(splitIds('a, b，c  d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(splitIds(''), [])
  assert.deepEqual(splitIds('  , ， '), [])
  assert.deepEqual(splitIds('x'), ['x'])
})

// ---------------------------------------------------------------------------
// 2. 历史存储状态兼容
// ---------------------------------------------------------------------------

test('存储：emptyStore 是 version 1，五个集合都是空数组', () => {
  const store = emptyStore()
  assert.equal(store.version, 1)
  assert.deepEqual(store.sessions, [])
  assert.deepEqual(store.dedupe, [])
  assert.deepEqual(store.usage, [])
  assert.deepEqual(store.security, [])
  assert.deepEqual(store.approvals, [])
})

test('存储：空文档通过校验，且校验结果自己就是一份完整文档', () => {
  const result = validateStore(emptyStore())
  assert.equal(result.ok, true, '连插件自己写的空文档都读不回来，那是读路径坏了')
  if (!result.ok) return
  assert.deepEqual(result.data, emptyStore(), '校验后的字段不能比 emptyStore 少（少一个就会在下次保存时丢掉）')
})

test('存储：缺 version 被判为损坏，原因里点名 version', () => {
  const result = validateStore({ sessions: [], dedupe: [] })
  assert.equal(result.ok, false, '没有 version 就无从判断格式，不能当成空库继续跑')
  if (result.ok) return
  assert.match(result.reason, /version/)
})

test('存储：未来版本与更老的版本都拒绝，不降级也不自动迁移', () => {
  // 未来版本可能带着本版本不认识的字段，静默降级会把它们写没；更老的版本需要迁移函数，
  const future = validateStore({ ...emptyStore(), version: 2 })
  assert.equal(future.ok, false, '未来版本必须拒绝：降级会丢掉未知字段')
  if (!future.ok) {
    assert.match(future.reason, /version/)
    assert.match(future.reason, /2/, '原因里要带上那个版本号，用户才知道该拿哪个版本打开')
  }

  // 而这里还没有任何迁移函数，所以同样是拒绝。
  const older = validateStore({ ...emptyStore(), version: 0 })
  assert.equal(older.ok, false, '旧版本必须拒绝：没有迁移函数时自动「修好」等于猜')
  if (!older.ok) assert.match(older.reason, /version/)
})

test('存储：非对象输入只返回失败，不抛异常', () => {
  for (const value of [null, 'x', [], 42, undefined, true]) {
    const result = validateStore(value)
    assert.equal(result.ok, false, `${JSON.stringify(value) ?? 'undefined'} 不该通过校验`)
    if (!result.ok) assert.match(result.reason, /不是对象/)
  }
})

test('存储：带 legacyOwnerKey 的旧去重记录仍能通过校验', () => {
  // `legacyOwnerKey` 是 pre-0.1.5 用来记「这条记录从哪来」的昵称，现代码不读它做判断。
  // 校验器要是把它当成未知字段拒绝，所有老档案会在升级后一次读不出来。
  const legacyRow = {
    key: 'tieba/2/3',
    platform: 'tieba',
    threadId: '2',
    ownerKey: 'old-name',
    triggerPostId: '3',
    sessionId: 's1',
    legacyOwnerKey: '旧昵称',
  }
  const result = validateStore({ version: 1, sessions: [], dedupe: [legacyRow] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.data.dedupe.length, 1)
  assert.equal(result.data.dedupe[0].legacyOwnerKey, '旧昵称', '来源字段要原样保留，否则事后无法解释这条记录')
})

test('存储：终态恰好三个，多一个少一个都会改变「还有什么能自动继续」', () => {
  assert.deepEqual(
    [...TERMINAL_STATES],
    ['PUBLISHED', 'FAILED', 'CANCELLED'],
    '终态清单变了：prune 与「还能不能自动重试」都读它',
  )
})

// ---------------------------------------------------------------------------
// 3. 入口与打包一致性
// ---------------------------------------------------------------------------

test('打包：main / types / exports 指向的文件都在磁盘上', () => {
  const pkg = readPackage()

  for (const rel of [pkg.main ?? '', pkg.types ?? '']) {
    assert.ok(rel !== '', '缺少 main 或 types 声明')
    assert.equal(existsSync(join(ROOT, rel)), true, `${rel} 不存在：装完插件 Host 找不到入口`)
  }

  const root = pkg.exports['.'] as Record<string, string>
  for (const key of ['types', 'default']) {
    assert.ok(root?.[key], `exports["."].${key} 缺失`)
    assert.equal(existsSync(join(ROOT, root[key])), true, `exports["."].${key} → ${root[key]} 不存在`)
  }

  const client = pkg.exports['./client']
  assert.equal(typeof client, 'string', 'exports["./client"] 必须是单一路径（浏览器半的入口）')
  assert.equal(existsSync(join(ROOT, client as string)), true, `浏览器半入口 ${String(client)} 不存在：Web GUI 配置页会整块消失`)
})

test('打包：files 白名单带着运行必需的文件', () => {
  const files = readPackage().files
  for (const need of [
    'lib/**/*.js',
    'lib/**/*.d.ts',
    'client/client.cjs',
    'cordis.patch.yml',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ]) {
    assert.equal(files.includes(need), true, `files 里缺少 ${need}：安装包里会没有它`)
  }
})

test('打包：files 不携带源码、测试与脚本', () => {
  const files = readPackage().files
  for (const entry of files) {
    const segments = entry.split('/')
    for (const forbidden of ['src', 'test', 'scripts', 'node_modules']) {
      assert.equal(segments.includes(forbidden), false, `files 里的 ${entry} 让安装包带上 ${forbidden}/`)
    }
    assert.doesNotMatch(entry, /^\.\/(src|test|scripts)(\/|$)/, `files 里的 ${entry} 指向源码目录`)
  }
})

test('打包：engines 声明 Node >=22.18.0 与 DSH 下限', () => {
  const engines = readPackage().engines ?? {}
  assert.equal(engines.node, '>=22.18.0', 'Node 下限：--experimental-transform-types 需要 22.7+，取维护中的 22.18')
  assert.ok(engines.dsh, '缺少 engines.dsh：装到哪个 Host 版本上算兼容，得有个声明')
  assert.match(engines.dsh, /^>=/, 'engines.dsh 必须是下限约束，不能是精确版本')
})

test('打包：运行时依赖只允许 @deepseek-ai/ 前缀（v0.2.16 前出现过核心模块 rc 版本冲突）', () => {
  const pkg = readPackage()

  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    assert.equal(
      name.startsWith('@deepseek-ai/'),
      true,
      `dependencies 里的 ${name} 不是 DSH 作用域的包：装插件时会顺带把第三方运行时塞进 profile`,
    )
    assert.equal(typeof range === 'string' && range.length > 0, true, `${name} 的版本范围是空的`)
  }

  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    assert.equal(name.startsWith('@deepseek-ai/'), true, `peerDependencies 里的 ${name} 不是 DSH 作用域的包`)
  }
})

test('打包：提交的入口文件存在、非空，且确实是本插件', () => {
  const entry = readText('lib/index.js')
  assert.ok(entry.length > 1000, 'lib/index.js 太小，可能是空文件或占位')
  assert.match(entry, /export const name = ['"]dsh-ai-debate['"]/, '入口里没有插件 name：Loader 认不出它')
  assert.match(entry, /export const inject = /, '入口里没有 inject 声明')

  const types = readText('lib/index.d.ts')
  assert.ok(types.length > 100, 'lib/index.d.ts 太小，types 指向的就是它')
})

// ---------------------------------------------------------------------------
// 4. bundle patch 与 settings 命名空间三方一致
// ---------------------------------------------------------------------------

test('bundle：patch 的 row id、settings 命名空间、包名三处一致', () => {
  const rowId = patchRowId(readText('cordis.patch.yml'))
  const pkgName = readPackage().name

  const indexSource = readText('src/index.ts')
  const nameMatch = /export const name = '([^']+)'/.exec(indexSource)
  assert.ok(nameMatch, 'src/index.ts 里找不到 `export const name = …`')
  const namespace = nameMatch[1]

  assert.equal(rowId, pkgName, 'row id 与包名不一致：Plugins 页不会长出「配置」控件')
  assert.equal(namespace, rowId, 'settings 命名空间与 row id 不一致：配置页永远打不开')
  assert.equal(namespace, pkgName)
})

test('bundle：patch 的 config 键全部被 schema 认识', () => {
  const entries = patchConfigEntries(readText('cordis.patch.yml'))
  assert.ok(entries.length > 10, `只解析出 ${entries.length} 个 config 键，解析器可能失效了`)

  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const { key } of entries) {
    assert.equal(known.has(key), true, `patch 里配了 schema 不认识的字段 ${key}：用户改它不会有任何效果`)
  }
})

test('bundle：patch 的每个值经 resolveConfig 后原样保留，没有一项被退回默认', () => {
  const parsed: Record<string, unknown> = {}
  for (const { key, raw } of patchConfigEntries(readText('cordis.patch.yml'))) parsed[key] = yamlScalar(raw)

  assert.deepEqual(
    resolveConfig(parsed),
    { ...DEFAULT_CONFIG, ...parsed },
    'patch 里配的值被归一化层改掉了：要么写错了枚举，要么字段名对不上',
  )

  // 上面那条报错只给笼统的 diff，这里点名几个最容易写错的。
  const resolved = resolveConfig(parsed)
  assert.equal(resolved.personaStyle, parsed.personaStyle)
  assert.equal(resolved.contextPreset, parsed.contextPreset)
  assert.equal(resolved.interactionMode, parsed.interactionMode)
  assert.equal(resolved.llmTemperature, parsed.llmTemperature)
  assert.equal(resolved.enabled, parsed.enabled)
})

test('bundle：patch 里没有任何凭据', () => {
  const patch = readText('cordis.patch.yml')
  assert.equal(patch.includes('BDUSS='), false, 'patch 里出现了贴吧 Cookie')
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(patch), false, 'patch 里出现了形似 API key 的串')
  assert.equal(patch.includes('Bearer '), false, 'patch 里出现了 Bearer 令牌')

  // 凭据字段可以被 schema 认识（老 profile 要用），但绝不能出现在 patch 的默认值里。
  const keys = patchConfigEntries(patch).map((entry) => entry.key)
  assert.equal(keys.includes('tiebaCookie'), false, 'patch 不该给 Cookie 配默认值')
  assert.equal(keys.includes('llmApiKey'), false, 'patch 不该给 API key 配默认值')
})

// ---------------------------------------------------------------------------
// 5. 真实平台调用的三档区分
// ---------------------------------------------------------------------------

const EVIDENCE_LEVELS = ['schema_only', 'live_call', 'fully_verified', 'unavailable'] as const

test('证据分级：不给任何证据时只能是最弱档 schema_only', () => {
  const evidence = capabilityEvidence({})
  assert.equal(evidence.level, 'schema_only', '遗漏证据不能变成更强的结论')
  assert.equal(evidence.commandExists, false)
  assert.equal(evidence.schemaCompatible, false)
  assert.equal(evidence.liveCallSucceeded, false)
  assert.equal(evidence.parentChildConfirmed, false)
  assert.equal(evidence.accountPermitted, 'unknown', '没有权限标记不等于有权限')
})

test('证据分级：schema 明说不支持时是 unavailable，调用成功也翻不回来', () => {
  // 这是「接口形状就否了」：真实调用再多也不能把它变成 live_call，
  // 否则一个跑得通的命令会让一个不成立的读取能力重新变成「可用」。
  const evidence = capabilityEvidence({
    schemaSaysUnavailable: true,
    liveCallSucceeded: true,
    parentChildConfirmed: true,
  })
  assert.equal(evidence.level, 'unavailable')
})

test('证据分级：档位词汇只有四个，四个都真的造得出来', () => {
  const source = readText('src/platforms/weibo/invocation-plan.ts')
  assert.match(
    source,
    /readonly level: 'schema_only' \| 'live_call' \| 'fully_verified' \| 'unavailable'/,
    'evidence.level 的联合类型变了：界面靠它表达「验证到哪一步」',
  )
  for (const level of EVIDENCE_LEVELS) {
    assert.ok(source.includes(`'${level}'`), `源码里找不到档位 ${level}`)
  }

  // 类型里写着还不够，得真能产出来 —— 否则「四档」只是注释。
  assert.equal(capabilityEvidence({ liveCallSucceeded: true }).level, 'live_call')
  assert.equal(
    capabilityEvidence({ liveCallSucceeded: true, parentChildConfirmed: true }).level,
    'fully_verified',
  )
})

test('证据分级：live_call 的措辞不得出现「已验证可用」', () => {
  // v0.2.15 的教训：一次成功调用只证明命令能跑，不证明返回的回复挂在被请求的评论下。
  const liveCall = describeEvidenceLevel('live_call')
  assert.match(liveCall, /未核对/, 'live_call 必须点明父子关系没核对')
  assert.doesNotMatch(liveCall, /已验证可用|已确认可用|验收通过/, 'live_call 不许被写成可用')

  assert.doesNotMatch(describeEvidenceLevel('schema_only'), /已验证可用|已确认可用|验收通过/)
  // 只有 fully_verified 可以说「核对过」——顺便钉住它确实说了，否则上面只是「都不许说」。
  assert.match(describeEvidenceLevel('fully_verified'), /核对/)
})

test('证据分级：fully_verified 只能由显式构造给出，调用点不许写死它', () => {
  const source = readText('src/platforms/weibo/invocation-plan.ts')
  const callSites = capabilityCallSites(source)
  assert.ok(callSites.length >= 5, `只找到 ${callSites.length} 个 capabilityEvidence 调用点，解析可能失效了`)

  for (const call of callSites) {
    assert.equal(
      call.includes('fully_verified'),
      false,
      `调用点直接写死了 fully_verified（应交给父子关系证据推导）：${call.slice(0, 120)}`,
    )
  }
})

test('证据分级：nestedReplies 只在 fully_verified 时为真，available 不算数', () => {
  const provider = readText('src/platforms/weibo/provider.ts')
  assert.match(
    provider,
    /nestedReplies:\s*nestedClaim\?\.evidence\.level === 'fully_verified'/,
    '能力门禁必须钉在 evidence.level 上',
  )
  assert.doesNotMatch(
    provider,
    /nestedReplies:\s*nestedClaim\?\.available/,
    '不能用 available 代替：参数名吻合不等于平台能力',
  )
})

test('证据分级：test/ 里没有把 mock/fixture 的结果写成「验收通过」', () => {
  // AGENTS.md 第七节：Mock 只能写「测试覆盖」，Fixture 只能写「离线回放通过」，
  // 只有真实授权调用才能写「验收通过」。这条扫的是断言与测试名，不是注释。
  //
  // 递归扫：`test/security/` 下还有三个文件。只扫顶层正是本项目最忌讳的那种
  // 「静默跳过」—— 扫描器自己腐坏了，还报绿。
  const files = (readdirSync(join(ROOT, 'test'), { recursive: true }) as string[]).filter((name) =>
    name.endsWith('.test.ts'),
  )
  assert.ok(files.length > 50, `只扫到 ${files.length} 个测试文件，扫描本身失效了`)
  assert.ok(
    files.some((name) => name.split(/[\\/]/).includes('security')),
    '没扫到 test/security/ 下的文件：递归失效了，这层守卫会变成空转',
  )

  // 本文件的正则里就带着这些词，跳过自己。
  const self = 'v0217-dsh-compat.test.ts'
  const forbidden = /验收通过|真实读取通过|真实发布通过/

  for (const name of files) {
    if (name.split(/[\\/]/).pop() === self) continue
    const text = readFileSync(join(ROOT, 'test', name), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!/assert|test\(/.test(line)) continue
      assert.doesNotMatch(line, forbidden, `${name} 把离线结果写成了真实平台验收：${line.trim()}`)
    }
  }
})
