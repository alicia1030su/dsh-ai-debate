/**
 * 回归测试：凭据命名空间碰撞（缺陷一）
 *
 * 被测代码：`src/platforms/adapter-manager.ts` 导出的
 * `credentialRefFor()` / `refBelongsToPlatform()`，以及它们在
 * `AdapterManager.build()` 里构成的真实访问边界。
 *
 * 复现过的缺陷（v0.2.1）：
 *   credentialRefFor('foo_bar','cookie') === 'DSH_AI_DEBATE_FOO_BAR_COOKIE'
 *   refBelongsToPlatform(那个 ref, 'foo') === true    ← foo 读到了 foo_bar 的凭据
 *   credentialRefFor('a-b','cookie') === credentialRefFor('a_b','cookie')
 *   'tieba' / 'Tie ba' / 'tie.ba' / 'tie/ba' 全部塌缩成 DSH_AI_DEBATE_TIE_BA_COOKIE
 *
 * 根因是编码不可逆：`platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')` 把
 * `-`、`_`、空格、`.`、`/`、`*` 映射成同一个 `_`，而 `_` 同时又被当作分隔符，
 * 于是“平台名里本来就有的字符”和“分隔符”无法区分；判定归属再用 `startsWith`
 * 做前缀匹配，`foo` 的 `DSH_AI_DEBATE_FOO_` 自然也是 `FOO_BAR_...` 的前缀。
 *
 * 本文件只钉**不变量**，不钉具体实现。合法的修复可以是：
 *   (a) 换一种单射编码（转义 + 明确分隔符）；或
 *   (b) 校验平台 id 的字符集，非法 id 直接拒绝（fail-closed）。
 * 因此所有“构造引用”的断言都写成「要么拒绝该 id，要么两者互不相交」，
 * 两种修法都能通过；而“基线”那条测试保证不会用「一律拒绝」蒙混过关。
 *
 * 唯一不许被修掉的兼容项：`tieba` 的历史引用 `DSH_AI_DEBATE_TIEBA_COOKIE`
 * 必须保持有效 —— 现有部署已经用这个名字存了凭据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AdapterManager, credentialRefFor, refBelongsToPlatform } from '../lib/platforms/adapter-manager.js'
import { COOKIE_REF, LLM_KEY_REF } from '../lib/secrets.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import type { PlatformCapabilityMatrix, PlatformProvider } from '../lib/platforms/contracts.js'
import type {
  AuthState,
  Floor,
  Mention,
  NestedPage,
  NestedReply,
  PlatformAdapter,
  PublishOutcome,
  PublishTarget,
  ReplyContext,
  ReplyPage,
  Thread,
  ThreadRef,
  UserProfile,
} from '../lib/types.js'

// ---------------------------------------------------------------------------
// 小工具：把“可能被拒绝”的构造包起来
// ---------------------------------------------------------------------------

type RefAttempt = { readonly ok: true; readonly ref: string } | { readonly ok: false; readonly reason: string }

/**
 * 尝试构造一个引用。
 *
 * 修复方案 (b) 会让不合法的平台 id 直接抛错，这不是测试失败，而是 fail-closed
 * 的正确行为，所以调用方必须把它当成一个合法结果处理，而不是让它把测试打崩。
 */
function tryRef(platform: unknown, what: unknown = 'cookie'): RefAttempt {
  try {
    const ref = credentialRefFor(platform as string, what as string)
    if (typeof ref !== 'string' || ref === '') return { ok: false, reason: '构造出了空引用' }
    return { ok: true, ref }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** `refBelongsToPlatform` 的三态结果：true / false / 直接抛错。 */
function tryBelongs(ref: string, platform: unknown): boolean | 'threw' {
  try {
    return refBelongsToPlatform(ref, platform as string)
  } catch {
    return 'threw'
  }
}

interface RefSpec {
  readonly platform: string
  readonly what?: string
}

function label(spec: RefSpec): string {
  return `credentialRefFor(${JSON.stringify(spec.platform)}, ${JSON.stringify(spec.what ?? 'cookie')})`
}

/**
 * 核心不变量：两个不同的（平台, what）组合不得共享同一个凭据命名空间。
 *
 * 允许的结果只有两种：
 *   1. 其中至少一个被拒绝构造（抛错）——fail-closed；或
 *   2. 两者都构造成功，但引用互不相同，且谁都不在对方的命名空间里。
 */
function assertNamespacesDisjoint(a: RefSpec, b: RefSpec): void {
  const left = tryRef(a.platform, a.what ?? 'cookie')
  const right = tryRef(b.platform, b.what ?? 'cookie')
  const pair = `${label(a)} 与 ${label(b)}`

  // fail-closed：明确拒绝一个无法无歧义编码的 id，是可接受的修复方式。
  // “基线”测试保证这不是“什么都拒绝”的作弊修法。
  if (!left.ok || !right.ok) return

  assert.notEqual(
    left.ref,
    right.ref,
    `${pair} 得到了完全相同的凭据引用「${left.ref}」：两个平台共用了一个命名空间`,
  )
  assert.notEqual(
    tryBelongs(left.ref, b.platform),
    true,
    `${pair}：${JSON.stringify(a.platform)} 的引用「${left.ref}」落进了 ${JSON.stringify(b.platform)} 的命名空间`,
  )
  assert.notEqual(
    tryBelongs(right.ref, a.platform),
    true,
    `${pair}：${JSON.stringify(b.platform)} 的引用「${right.ref}」落进了 ${JSON.stringify(a.platform)} 的命名空间`,
  )
}

// ---------------------------------------------------------------------------
// 一个“真的会做事”的假平台：用于端到端验证命名空间边界
// ---------------------------------------------------------------------------

function makeThread(platform: string): Thread {
  return {
    platform,
    forum: { platform, id: '1', name: '测试区' },
    id: `${platform}-t1`,
    title: '凭据命名空间测试帖',
    content: '正文',
    authorId: 'host-1',
    authorName: '楼主',
    createdAt: '2024-1-1',
    url: `https://${platform}.example/thread/t1`,
    declaredReplyCount: 1,
    images: [],
  }
}

/** 实现了全部被调用方法的适配器，不是空壳。 */
class ProbeAdapter implements PlatformAdapter {
  readonly displayName = '凭据探针平台'
  private readonly thread: Thread
  private readonly floors: readonly Floor[]
  private readonly published: NestedReply[] = []

  constructor(readonly id: string) {
    this.thread = makeThread(id)
    this.floors = [
      {
        platform: id,
        floorNumber: 1,
        postId: `${id}-c1`,
        authorId: 'host-1',
        authorName: '楼主',
        content: '第 1 楼。',
        createdAt: '2024-1-1',
        images: [],
        nestedCount: 1,
      },
    ]
  }

  getCapabilities() {
    return {
      thread: true,
      replies: true,
      nestedReplies: true,
      userProfile: true,
      mentions: true,
      publish: true,
      authCheck: true,
    }
  }

  async checkAuthentication(): Promise<AuthState> {
    return { authenticated: true, userId: `${this.id}-ai`, userName: `${this.id} 小号` }
  }

  async getThread(): Promise<Thread> {
    return this.thread
  }

  async getReplies(_ref: ThreadRef, page: number): Promise<ReplyPage> {
    return {
      floors: page === 1 ? this.floors : [],
      page,
      hasMore: false,
      declaredTotalPages: 1,
      declaredTotal: this.floors.length,
    }
  }

  async getNestedReplies(_ref: ThreadRef, floor: Floor, page: number): Promise<NestedPage> {
    const replies: readonly NestedReply[] =
      page === 1
        ? [
            {
              platform: this.id,
              postId: `${floor.postId}-r1`,
              parentPostId: floor.postId,
              authorId: 'owner-1',
              authorName: '主人',
              content: '一条楼中楼。',
            },
          ]
        : []
    return { replies, page, hasMore: false, declaredTotalPages: 1, declaredTotal: replies.length }
  }

  async getUserProfile(userNameOrId: string): Promise<UserProfile> {
    return { platform: this.id, userName: userNameOrId, displayName: userNameOrId }
  }

  async getMentions(): Promise<readonly Mention[]> {
    return []
  }

  async getReplyContext(_ref: ThreadRef, postId: string): Promise<ReplyContext> {
    const floor = this.floors.find((entry) => entry.postId === postId)
    if (floor !== undefined) return { thread: this.thread, floor, ancestors: [], siblings: [] }
    const mine = this.published.find((entry) => entry.postId === postId)
    if (mine !== undefined) {
      return {
        thread: this.thread,
        floor: this.floors[0]!,
        nested: mine,
        ancestors: [],
        siblings: this.published,
      }
    }
    throw new Error(`找不到 ${postId}`)
  }

  async publishReply(_ref: ThreadRef, target: PublishTarget, content: string): Promise<PublishOutcome> {
    const postId = `${this.id}-new-${this.published.length + 1}`
    this.published.push({
      platform: this.id,
      postId,
      parentPostId: target.floorPostId ?? this.floors[0]!.postId,
      authorId: `${this.id}-ai`,
      authorName: `${this.id} 小号`,
      content,
    })
    return { status: 'confirmed', postId }
  }
}

/**
 * 注册一个假平台，并把 manager 交给 provider 的 `resolveCredential` 闭包抓出来，
 * 用于端到端断言越权访问会被拒绝。
 */
function makeProvider(
  id: string,
  capture?: Map<string, (ref: string) => Promise<string | undefined>>,
): PlatformProvider {
  const declared = {
    platform: id,
    declaredAt: '2026-01-01T00:00:00.000Z',
    capabilities: {},
  } as PlatformCapabilityMatrix

  return {
    id,
    displayName: `假平台 ${id}`,
    shape: 'other',
    canHandleUrl(url: string): boolean {
      if (typeof url !== 'string' || url.trim() === '') return false
      return url.includes(`${id}.example`)
    },
    parseUrl(url: string): ThreadRef {
      return { platform: id, threadId: `${id}-t1`, url }
    },
    describeCapabilities: () => declared,
    createAdapter(context) {
      if (capture !== undefined && context.resolveCredential !== undefined) {
        capture.set(id, context.resolveCredential)
      }
      return new ProbeAdapter(id)
    },
  }
}

// ---------------------------------------------------------------------------
// 0. 基线：普通平台名必须仍然能构造出引用
//
// 这条测试的作用是堵住“把所有 id 都拒绝掉”的假修复——上面那些
// `assertNamespacesDisjoint` 在被拒绝时会直接放行。
// ---------------------------------------------------------------------------

test('基线：普通平台名必须能构造出引用（防止“一律抛错”式的假修复）', () => {
  for (const platform of ['tieba', 'board', 'micro', 'zhihu']) {
    const attempt = tryRef(platform)
    assert.equal(attempt.ok, true, `${platform} 必须能构造引用，实际：${attempt.ok ? '' : attempt.reason}`)
    if (attempt.ok) {
      // 不限定大小写：单射编码允许保留原样，也允许大写化，重点是能认出结构。
      assert.match(attempt.ref, /^DSH_AI_DEBATE_[A-Za-z0-9_]+_COOKIE$/)
    }
  }
})

// ---------------------------------------------------------------------------
// 1. 前缀包含：foo 不得读到 foo_bar 的凭据
// ---------------------------------------------------------------------------

test('缺陷一-1：前缀包含——foo 不得读到 foo_bar 的凭据', () => {
  const foo = tryRef('foo')
  const fooBar = tryRef('foo_bar')
  assert.equal(foo.ok, true, 'foo 必须能构造引用')
  assert.equal(fooBar.ok, true, 'foo_bar 必须能构造引用')
  if (!foo.ok || !fooBar.ok) return

  assert.notEqual(foo.ref, fooBar.ref, 'foo 与 foo_bar 不得共用同一个凭据引用')

  // 关键断言（v0.2.1 在这里返回 true）：
  assert.notEqual(
    tryBelongs(fooBar.ref, 'foo'),
    true,
    `${JSON.stringify(fooBar.ref)} 被判为属于 foo 的命名空间：foo 会读到 foo_bar 的 Cookie`,
  )

  // 自己的引用仍然必须属于自己。
  assert.equal(tryBelongs(fooBar.ref, 'foo_bar'), true, `${fooBar.ref} 必须属于 foo_bar 自己`)
  assert.equal(tryBelongs(foo.ref, 'foo'), true, `${foo.ref} 必须属于 foo 自己`)
})

test('缺陷一-1b：平台名与 what 的边界也不得被下划线吃掉', () => {
  // foo 用 what='bar_cookie' 拼出的字符串，v0.2.1 与 foo_bar 用 what='cookie'
  // 拼出的完全相同 —— 意味着 foo 能通过自己合法的调用读到 foo_bar 的 Cookie。
  assertNamespacesDisjoint({ platform: 'foo', what: 'bar_cookie' }, { platform: 'foo_bar', what: 'cookie' })

  const crafted = tryRef('foo', 'bar_cookie')
  const owned = tryRef('foo_bar', 'cookie')
  if (crafted.ok && owned.ok) {
    assert.notEqual(
      crafted.ref,
      owned.ref,
      `foo 能用 what=bar_cookie 拼出 foo_bar 的引用「${owned.ref}」：what 里的下划线穿透了平台边界`,
    )
  }
})

// ---------------------------------------------------------------------------
// 2. 连字符 vs 下划线
// ---------------------------------------------------------------------------

test('缺陷一-2：连字符与下划线不得共享凭据引用', () => {
  assertNamespacesDisjoint({ platform: 'a-b' }, { platform: 'a_b' })

  const hyphen = tryRef('a-b')
  const underscore = tryRef('a_b')
  if (hyphen.ok && underscore.ok) {
    assert.notEqual(
      hyphen.ref,
      underscore.ref,
      `a-b 与 a_b 塌缩成同一个引用「${hyphen.ref}」：两个不同平台会共用同一份凭据`,
    )
  }

  // 同类：连字符、连续下划线也不得与普通名字互相塌缩。
  assertNamespacesDisjoint({ platform: 'a-b' }, { platform: 'ab' })
  assertNamespacesDisjoint({ platform: 'a_b' }, { platform: 'a__b' })
  assertNamespacesDisjoint({ platform: 'a--b' }, { platform: 'a__b' })
})

// ---------------------------------------------------------------------------
// 3. 大小写
//
// 我的判断：**大小写必须区分（等价地：大写 id 一律拒绝）。理由：
//   a) 平台 id 在契约里就是小写（contracts.ts: "Stable, lowercase id"）。
//      大小写折叠正是本缺陷的错误来源——它是一个有损归一化。
//   b) 折叠会让「同一个平台」和「两个不同平台」在编码后变得无法区分，
//      而这正是命名空间编码唯一必须保证的性质：单射。
//   c) 拒绝大写 id 是 fail-closed：配置错了会立刻炸出来，而不是安静地
//      和另一个平台共用一个 Cookie。
//   d) 相反方向（保留折叠但要求双向对称）虽然不越权，但它把“拼写”当成
//      身份的一部分，等于把缺陷的成因固化成规则，我不选它。
//
// 但为了不让这条测试绑死实现，断言写成：'Tieba' 与 'tieba' 只有两种合法关系——
//   要么被视为同一个平台（引用相同 **且** 互相认领，完全对称）；
//   要么必须是两个不相干的命名空间（不许任何一方读到另一方）。
// 不合法的是第三种：引用不同、却能单向读到对方的凭据。
// ---------------------------------------------------------------------------

test('缺陷一-3：大小写只允许「完全同一平台」或「完全不相干」两种关系', () => {
  const lower = tryRef('tieba')
  assert.equal(lower.ok, true, 'tieba 必须能构造引用')
  if (!lower.ok) return

  for (const spelling of ['Tieba', 'TIEBA', 'TiEbA']) {
    const variant = tryRef(spelling)

    if (!variant.ok) {
      // 方案 A（推荐，也是当前实现）：大写 id 被拒绝。此时它绝不能认领任何引用。
      assert.notEqual(
        tryBelongs(lower.ref, spelling),
        true,
        `${spelling} 构造被拒绝，却仍然认领了 tieba 的引用：拒绝必须是彻底的`,
      )
      continue
    }

    if (variant.ref === lower.ref) {
      // 方案 B：被视为同一个平台。那就必须完全对称，不能“能存不能读”。
      assert.equal(
        tryBelongs(lower.ref, spelling),
        true,
        `${spelling} 与 tieba 共用同一个引用，却不认领它：这会留下单向的可写不可读缝`,
      )
      assert.equal(tryBelongs(variant.ref, 'tieba'), true, '对称性检查')
      continue
    }

    // 方案 C：当成两个不同平台。那就必须彼此都读不到。
    assert.notEqual(
      tryBelongs(lower.ref, spelling),
      true,
      `${spelling} 用不同的引用，却仍能读到 tieba 的凭据`,
    )
    assert.notEqual(
      tryBelongs(variant.ref, 'tieba'),
      true,
      `tieba 不得读到 ${spelling} 的凭据`,
    )
  }
})

test('缺陷一-3b：折叠只允许发生在“只差大小写”时，绝不能吞并不同的名字', () => {
  const lower = tryRef('tieba')
  assert.equal(lower.ok, true)
  if (!lower.ok) return

  for (const other of ['tiebas', 'tieba7', 'tiebas_']) {
    const attempt = tryRef(other)
    if (!attempt.ok) continue
    assert.notEqual(attempt.ref, lower.ref, `${other} 不得与 tieba 共用一个引用`)
    assert.notEqual(tryBelongs(attempt.ref, 'tieba'), true, `${other} 的引用不得落入 tieba 的命名空间`)
  }
})

// ---------------------------------------------------------------------------
// 4. 特殊字符
// ---------------------------------------------------------------------------

test('缺陷一-4：空格 / 点 / 斜杠 / 星号不得产出与其他平台相同的引用', () => {
  const specials = ['tie ba', 'tie.ba', 'tie/ba', 'tie*ba', 'tie+ba', 'tie:ba']
  // 这些字符在 v0.2.1 全被 replace 成 `_`，因此都与 tie_ba 撞车。
  for (const spelling of specials) {
    assertNamespacesDisjoint({ platform: spelling }, { platform: 'tie_ba' })
  }
  // 特殊字符之间也必须两两不同。
  for (let i = 0; i < specials.length; i += 1) {
    for (let j = i + 1; j < specials.length; j += 1) {
      assertNamespacesDisjoint({ platform: specials[i]! }, { platform: specials[j]! })
    }
  }

  // 具体钉住任务里实测的那四个：v0.2.1 全部塌缩成 DSH_AI_DEBATE_TIE_BA_COOKIE。
  const collapsed = ['tie ba', 'tie.ba', 'tie/ba', 'tie*ba'].map((spelling) => tryRef(spelling))
  const constructed = collapsed.filter((entry): entry is { ok: true; ref: string } => entry.ok)
  if (constructed.length > 1) {
    const refs = new Set(constructed.map((entry) => entry.ref))
    assert.equal(
      refs.size,
      constructed.length,
      `这四个写法必须各自得到不同的引用，实际得到：${constructed.map((entry) => entry.ref).join(' / ')}`,
    )
  }

  // 特殊字符不允许让一个平台名“伸进”另一个平台名。
  const spaced = tryRef('tie ba')
  if (spaced.ok) {
    assert.notEqual(
      tryBelongs(spaced.ref, 'tie'),
      true,
      `'tie ba' 的引用 ${spaced.ref} 不得落入 tie 的命名空间`,
    )
  }
})

// ---------------------------------------------------------------------------
// 5. 向后兼容：tieba 的历史引用必须仍然有效（硬约束）
// ---------------------------------------------------------------------------

test('缺陷一-5：tieba 的历史引用 DSH_AI_DEBATE_TIEBA_COOKIE 必须保持有效', () => {
  // 字面量写死：这是已经落盘的部署事实，不能跟着代码一起改。
  assert.equal(COOKIE_REF, 'DSH_AI_DEBATE_TIEBA_COOKIE', 'COOKIE_REF 的字面值不得改动')

  const derived = tryRef('tieba', 'cookie')
  assert.equal(derived.ok, true, 'tieba 必须仍能构造引用')
  if (derived.ok) {
    assert.equal(
      derived.ref,
      COOKIE_REF,
      '由 tieba 推导出的引用必须与历史引用完全一致，否则现有部署的 Cookie 直接失效',
    )
  }

  assert.equal(
    tryBelongs('DSH_AI_DEBATE_TIEBA_COOKIE', 'tieba'),
    true,
    'tieba 必须仍然认领自己的历史引用',
  )

  // 反向：别的平台不得认领它（v0.2.1 的 `tie` / `tie_ba` 会错认）。
  for (const other of ['foo', 'foo_bar', 'tie', 'tie_ba', 'board', 'micro', 'tiebas']) {
    assert.notEqual(
      tryBelongs('DSH_AI_DEBATE_TIEBA_COOKIE', other),
      true,
      `${other} 不得认领 tieba 的 Cookie 引用`,
    )
  }
})

test('缺陷一-5b：模型 API Key 引用不得被任何平台当作自己的凭据认领', () => {
  // LLM_KEY_REF 写死为 `DSH_AI_DEBATE_LLM_API_KEY`。按派生规则，
  // 平台 'llm' + what 'api_key' 会推导出**完全相同**的字符串——也就是说
  // 一个叫 llm 的平台可以顺着自己的命名空间读到模型密钥：同一类碰撞。
  assert.equal(LLM_KEY_REF, 'DSH_AI_DEBATE_LLM_API_KEY', 'LLM_KEY_REF 的字面值不得改动')
  assert.notEqual(LLM_KEY_REF, COOKIE_REF)

  for (const platform of ['llm', 'llm_api', 'tieba', 'foo', 'board']) {
    assert.notEqual(
      tryBelongs(LLM_KEY_REF, platform),
      true,
      `平台「${platform}」把模型密钥引用 ${LLM_KEY_REF} 认领成了自己的凭据：` +
        '它能通过命名空间检查，从而读到不属于平台的密钥',
    )
  }

  // 反方向不能被“修”成拒绝一切：tieba 的 Cookie 引用仍要认领自己。
  assert.equal(tryBelongs(COOKIE_REF, 'tieba'), true)
})

test('缺陷一-5c（附加）：同一套命名空间规则不得存在两份实现', async () => {
  // `lib/secrets.ts` 也导出过同名、同用途的 credentialRefFor / refBelongsToPlatform。
  // 只要它还留着旧的有损实现，任何人从 secrets 导入就会把本缺陷整块带回来。
  //
  // 理想结果是那些重复导出被删掉——此时本测试直接通过。若仍存在，则必须与
  // adapter-manager 的答案一致（同一输入 → 同一引用、同一归属判断）。
  const secretsModule = (await import('../lib/secrets.js')) as Record<string, unknown>
  const legacyRef = secretsModule['credentialRefFor']
  const legacyBelongs = secretsModule['refBelongsToPlatform']

  if (typeof legacyRef !== 'function' && typeof legacyBelongs !== 'function') return

  if (typeof legacyRef === 'function') {
    const build = legacyRef as (platform: string, what: string) => string
    for (const platform of ['tieba', 'foo', 'foo_bar', 'a-b', 'a_b', 'board']) {
      const fromManager = tryRef(platform)
      const fromSecrets = (() => {
        try {
          return { ok: true as const, ref: build(platform, 'cookie') }
        } catch (error) {
          return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }
        }
      })()
      assert.equal(
        fromManager.ok,
        fromSecrets.ok,
        `${platform}：adapter-manager 与 secrets 对「能否构造引用」判断不一致`,
      )
      if (fromManager.ok && fromSecrets.ok) {
        assert.equal(
          fromManager.ref,
          fromSecrets.ref,
          `${platform}：两个模块推导出的引用不同（${fromManager.ref} vs ${fromSecrets.ref}），` +
            '从 secrets 导入会绕过修复',
        )
      }
    }
  }

  if (typeof legacyBelongs === 'function') {
    const belongs = legacyBelongs as (ref: string, platform: string) => boolean
    for (const [ref, platform] of [
      ['DSH_AI_DEBATE_FOO_BAR_COOKIE', 'foo'],
      ['DSH_AI_DEBATE_TIEBA_COOKIE', 'tieba'],
    ] as const) {
      let fromSecrets: boolean | 'threw'
      try {
        fromSecrets = belongs(ref, platform)
      } catch {
        fromSecrets = 'threw'
      }
      // 与 adapter-manager 的答案比对，而不是硬编码——两个模块必须同源。
      assert.equal(
        fromSecrets,
        tryBelongs(ref, platform),
        `secrets 与 adapter-manager 对 ${ref} / ${platform} 的归属判断不一致：旧的有损规则还在生效`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// 6. 无法确定归属时必须拒绝（fail-closed）
// ---------------------------------------------------------------------------

test('缺陷一-6：归属不确定时必须拒绝（fail-closed）', () => {
  // 6a. 空平台名：`DSH_AI_DEBATE_` + '' + `_` 前缀会认领所有双下划线引用。
  assert.notEqual(
    tryBelongs('DSH_AI_DEBATE__COOKIE', ''),
    true,
    '空平台名不得认领任何引用（否则一个未命名的平台就是一个万能读口）',
  )
  assert.notEqual(
    tryBelongs('DSH_AI_DEBATE_TIEBA_COOKIE', ''),
    true,
    '空平台名不得认领 tieba 的引用',
  )

  // 6b. 空 id 本身不允许被编码成一个“合法”的引用。
  const empty = tryRef('')
  assert.equal(empty.ok, false, '空平台 id 不得被编码成引用')

  // 6c. 完全不相干的字符串必须被拒绝。
  for (const junk of ['', 'COOKIE', 'TIEBA_COOKIE', 'OTHER_APP_TIEBA_COOKIE', 'D', 'DSH_AI_DEBATE']) {
    assert.notEqual(tryBelongs(junk, 'tieba'), true, `「${junk}」不得被判为 tieba 的凭据引用`)
  }

  // 6d. 大小写不同的引用字符串不是同一个引用（存储层是大小写敏感的）。
  assert.notEqual(
    tryBelongs('dsh_ai_debate_tieba_cookie', 'tieba'),
    true,
    '小写的引用字符串不得被认领',
  )
})

test('缺陷一-6b：AdapterManager 的凭据边界必须拒绝前缀包含的越权访问', async () => {
  // 端到端版本，也是最接近真实攻击的一条：透过 provider 拿到的
  // resolveCredential 闭包去读另一个平台的凭据。
  const capture = new Map<string, (ref: string) => Promise<string | undefined>>()
  const registry = new PlatformRegistry()
  registry.register(makeProvider('foo', capture))
  registry.register(makeProvider('foo_bar', capture))

  const handed: string[] = []
  const manager = new AdapterManager({
    registry,
    settingsFor: () => ({}),
    resolveCredential: async (platform, ref) => {
      handed.push(`${platform} <- ${ref}`)
      return `${platform}-secret`
    },
  })

  manager.adapterFor('foo')
  manager.adapterFor('foo_bar')

  const fooResolver = capture.get('foo')
  const fooBarResolver = capture.get('foo_bar')
  assert.ok(fooResolver !== undefined, 'foo 的 provider 应收到 resolveCredential')
  assert.ok(fooBarResolver !== undefined, 'foo_bar 的 provider 应收到 resolveCredential')

  const fooRef = tryRef('foo')
  const fooBarRef = tryRef('foo_bar')
  assert.equal(fooRef.ok && fooBarRef.ok, true, 'foo / foo_bar 的引用都必须能构造')
  if (!fooRef.ok || !fooBarRef.ok) return

  // 自己的可以读。
  assert.equal(await fooResolver!(fooRef.ref), 'foo-secret')
  const handedAfterOwn = handed.length

  // 越权读取必须被拒绝，而且**不能到达**真正的凭据读取器。
  await assert.rejects(
    () => fooResolver!(fooBarRef.ref),
    (error: unknown) => {
      assert.ok(error instanceof Error, '应以 Error 形式拒绝')
      assert.match(error.message, /不能读取凭据/, `拒绝理由应说明越权，实际：${error.message}`)
      return true
    },
    `平台 foo 不应能读取 ${fooBarRef.ref}：它属于 foo_bar`,
  )
  assert.equal(
    handed.length,
    handedAfterOwn,
    `越权引用到达了底层凭据读取器：${handed.slice(handedAfterOwn).join(', ')}`,
  )

  // 对称方向：foo_bar 也不能读 foo 的。
  await assert.rejects(
    () => fooBarResolver!(fooRef.ref),
    /不能读取凭据/,
    `平台 foo_bar 不应能读取 ${fooRef.ref}`,
  )

  // 而 foo_bar 读自己的仍然可以。
  assert.equal(await fooBarResolver!(fooBarRef.ref), 'foo_bar-secret')
})
