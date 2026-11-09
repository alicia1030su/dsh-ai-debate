/**
 * 明确认定为「假数据」的凭据字面量（v0.2.39 复审 §2）。
 *
 * ## 为什么需要这份表
 *
 * 打包器原来对 `test/`、`docs/` 整目录跳过内容扫描。理由是「测试和文档里引用凭据形状是
 * 正常的」—— 这个理由本身没错，但它的实现方式是**按目录名放行**，于是同一类事故又回来了：
 * 任何人把一把真的 AWS key 粘进任何一个测试文件，构建仍然是绿的。加上行级 `fixture`
 * 关键字豁免之后更糟：一句注释就能让一把真钥匙通过。
 *
 * 所以例外从「哪些目录」改成「哪些字节」：**一个路径，加上它允许出现的那一串确切字符**。
 * 同文件里换一把钥匙、别处新增一把钥匙，都不在这份表里，都会让构建失败。
 *
 * ## 为什么字面量被拆成几段
 *
 * 这份文件自己也会被发布、也会被扫描。把 `AKIA...` 整串写在这里，它就会命中自己，
 * 于是只能再给自己开一条「整文件豁免」—— 那正是本案要消灭的东西。
 * 拆段之后，文件字节里不存在连续的凭据形状，而运行时 `parts.join('')` 得到的是
 * 仍然精确的那一串。拆点都落在不构成模式的位置（例如 `Bearer ` 后面不足 30 字符），
 * 不是加密，也不是混淆。
 *
 * ## 怎么核对
 *
 * `test/v0239-publish-gate.test.ts` 会逐条 `join` 回完整字面量，断言它**仍然出现在**
 * 声明的那个文件里。文件改了、字面量被删了，测试先红 —— 例外表不允许无声地过期。
 */

/**
 * @typedef {object} FakeLiteral
 * @property {string} path 仓库内路径（必须是 test/ 或 docs/ 开头）
 * @property {readonly string[]} parts 运行时拼接成完整字面量的片段
 * @property {string} why 为什么它明显是假数据（给人看的，不参与判定）
 */

/** @type {readonly FakeLiteral[]} */
const ENTRIES = [
  {
    path: 'docs/v0.2.17-acceptance.md',
    parts: ['AKIAIOSFODNN7', 'EXAMPLE'],
    why: 'AWS 官方文档使用的示例访问键，出现在「夹具标记会被绕过」的说明文字里',
  },
  {
    path: 'test/security/security-events.test.ts',
    parts: ['Bearer eyJhbGciOiJIUzI1NiJ9', '.payload.sig'],
    why: '占位 JWT：中间段就是 payload/sig 两个字面词，用于断言授权头被脱敏',
  },
  {
    path: 'test/security/security-events.test.ts',
    parts: ['m0sk_OtQ7', 'BaGeBkhytYlLFYXvtTdTNsTZ'],
    why: '脱敏测试输入，用于断言 mem0 形状的 key 不会原样进入事件记录',
  },
  {
    path: 'test/v0211-weibo-cli.test.ts',
    parts: ['Bearer eyJhbGciOiJIUzI1NiJ9', 'abcdefghij'],
    why: '占位 JWT：尾段是字母表顺序的 abcdefghij，不是随机密钥',
  },
  {
    path: 'test/v0215-source-zip-security.test.ts',
    parts: [
      "const FAKE_PRIVATE_KEY = '-----BEGIN RSA",
      ' PRIVATE KEY-----\\nV0215FAKEFAKEFAKE\\n-----END RSA',
      ' PRIVATE KEY-----\\n\'',
    ],
    why: '整行私钥夹具：常量名与正文都写着 FAKE，且只存在于隔离临时目录的构造代码里',
  },
  {
    path: 'test/v0215-source-zip-security.test.ts',
    parts: ['ghp_v0215', 'RealLookingTokenThatMustFailBadly1234567'],
    why: '专门用来证明「不带标记的真凭据形状会被拦住」的反例，尚未写入任何真实仓库',
  },
  {
    path: 'test/v0217-exception-paths.test.ts',
    parts: ['AKIAQYLPMN5', 'HHMWUZ7AG'],
    why: '写进隔离临时仓库、用于证明「白名单目录里的真凭据形状必须失败」的反例值',
  },
]

/**
 * 路径 → 允许出现的完整字面量。
 *
 * 用 `Map` 而不是数组：判定是「这个文件的这一串」，路径是第一层键。调用方拿不到
 * 一条跨文件的通配，也就不会有人顺手把某个值登记成「所有测试文件都允许」。
 *
 * @type {Map<string, readonly string[]>}
 */
export const FAKE_CREDENTIAL_LITERALS = new Map()
for (const entry of ENTRIES) {
  const literal = entry.parts.join('')
  const list = FAKE_CREDENTIAL_LITERALS.get(entry.path)
  if (list === undefined) FAKE_CREDENTIAL_LITERALS.set(entry.path, [literal])
  else list.push(literal)
}

/**
 * 一条命中是否属于登记在案的假数据。
 *
 * 两种登记方式，都是**逐字比较**：
 *
 * - `match`：正则命中的那一段（大多数模式够用）；
 * - `line`：命中所在的整行，去掉首尾空白。私钥的匹配只是头一行，头一行在真钥匙里
 *   长得一模一样，所以私钥必须登记整行 —— 真钥匙粘进来时那一行不同，仍然会被拦住。
 *
 * @param {string} path 仓库内路径
 * @param {string} match 正则命中的子串
 * @param {string} line 命中所在的整行
 * @returns {boolean} 是否放行
 */
export function isRegisteredFakeLiteral(path, match, line) {
  const allowed = FAKE_CREDENTIAL_LITERALS.get(path)
  if (allowed === undefined) return false
  const trimmed = line.trim()
  return allowed.includes(match) || allowed.includes(trimmed)
}
