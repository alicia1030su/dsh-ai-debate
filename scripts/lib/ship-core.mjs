/**
 * 交付流水线里「可以离线验证」的那部分决策。
 *
 * ## 为什么把决策从执行里拆出来
 *
 * `scripts/ship.mjs` 会建分支、推提交、开 PR、等 CI、打标签、发 Release —— 每一步都是不可撤销的
 * 外部副作用。如果这些判断只写在会真的执行副作用的文件里，那它们就只能靠「真跑一次」来验证，
 * 而真跑一次的代价是一个真实的版本号。
 *
 * 所以这里只放纯函数：输入是事实（版本号、变更文件、远端状态），输出是决定（走哪条路、要不要停）。
 * 测试可以喂任意事实组合，包括那些在真仓库里很难制造的（标签已被别人占用、PR 已存在、上一轮
 * 中断在等 CI 的那一步）。`ship.mjs` 负责执行，这里负责判断，两者分开的文件也就是分开的失败面。
 *
 * ## 幂等不是「再跑一次也不报错」
 *
 * 真正的要求是：**同一件事跑第二次不能变成两件**。分支只能有一个、PR 只能有一个、标签不能移动、
 * Release 不能被覆盖。每一种「已经做过了」都要有对应的识别方式，而识别方式必须来自远端事实
 * （`git ls-remote`、`gh pr list`、`gh release view`），不能来自本地状态文件 —— 状态文件可能被删、
 * 可能是上一台机器留下的、也可能在 CI 里根本不存在。
 */

/** 本地状态文件的版本号。结构变了就加一，旧状态文件会被当成「没有状态」而不是被误读。 */
export const STATE_SCHEMA = 1

/**
 * 流水线的阶段。
 *
 * 顺序即依赖顺序：后面的阶段假定前面的已经完成。`blocked` 不是阶段，是结果 —— 停在某个阶段
 * 且需要人来解；`failed` 同理。两者都保留 `stage` 字段说明停在哪一步。
 */
export const STAGES = [
  'preflight', // 读版本、检查工作区、确认 gh 授权与远端
  'branch', // 从最新 main 建功能分支
  'verify', // 编译、类型检查、全部测试、凭据扫描、打包与双包校验
  'commit', // 提交（不推）
  'push', // 推功能分支
  'pull_request', // 建 PR（或复用已有）
  'auto_merge', // 开 auto-merge（squash），或对敏感变更停在这里
  'wait_checks', // 等要求中的检查通过
  'tag', // main 上打标签并推
  'release', // 触发并等待 Release 工作流
  'verify_release', // 核验附件、哈希、安装命令
  'done',
]

/** 阶段的中文名，用来写状态报告与终端输出。报告是给人读的，不是只有机器看。 */
export const STAGE_LABELS = {
  preflight: '预检',
  branch: '建分支',
  verify: '本地验证',
  commit: '提交',
  push: '推送分支',
  pull_request: '创建 PR',
  auto_merge: '开启自动合并',
  wait_checks: '等待检查通过',
  tag: '打标签',
  release: '发布',
  verify_release: '核验发布产物',
  done: '完成',
}

/**
 * ## 什么变更不允许自动合并（任务书 §四）
 *
 * 这几类东西一旦被自动化悄悄合进去，破坏的不是这一个版本，而是「以后还能不能信这条流水线」：
 *
 * - 工作流的权限、触发器、发布条件 —— 改这些等于改流水线本身
 * - 凭据扫描与归档打包规则 —— 它们是「不该发的东西不会发」这个保证的唯一来源
 * - 认证与凭据存储 —— 改错了是泄漏
 * - 真实平台的自动发帖 —— 那是对外说话，必须有人看过正文
 * - 流水线自己的决策代码 —— 让流水线有权改自己的判断，等于没有判断
 *
 * 命中任何一条，PR 照建、CI 照跑，但**不开 auto-merge**，停下来等人。
 */
export const SENSITIVE_RULES = [
  {
    id: 'workflow',
    // 工作流文件的任何改动：权限、触发器、步骤。
    test: (path) => /^\.github\/workflows\/.*\.ya?ml$/i.test(path),
    reason: '改动了 GitHub Actions 工作流（权限、触发器或步骤）',
  },
  {
    id: 'actions-config',
    test: (path) => /^\.github\/(CODEOWNERS|dependabot\.ya?ml)$/i.test(path),
    reason: '改动了仓库协作与依赖策略配置',
  },
  {
    id: 'scan-rules',
    test: (path) => ['scripts/audit-leaks.mjs', 'scripts/scan-archive.mjs'].includes(path),
    reason: '改动了凭据扫描规则（唯一的泄漏判定来源）',
  },
  {
    id: 'pack-rules',
    test: (path) => ['scripts/source-zip.mjs', 'scripts/pack.mjs', 'scripts/tar.mjs'].includes(path),
    reason: '改动了归档打包规则（决定什么会公开发布）',
  },
  {
    id: 'ship-logic',
    test: (path) =>
      ['scripts/ship.mjs', 'scripts/lib/ship-core.mjs', 'scripts/lib/delivery-status.mjs'].includes(path),
    reason: '改动了交付流水线自身的决策代码',
  },
  {
    id: 'security-boundary',
    test: (path) => /^src\/security\//.test(path),
    reason: '改动了安全边界（注入检测、输出守卫）',
  },
  {
    id: 'platform-publish',
    // 真实平台的发表路径。读与写在这里分开：读错了只是难看，写错了是替主人说了话。
    test: (path) => /^src\/platforms\/[^/]+\/(publish|reply|comment)[^/]*\.ts$/i.test(path),
    reason: '改动了真实平台发表路径（可能绕过人工确认）',
  },
  {
    id: 'plugin-loading',
    test: (path) => path === 'cordis.patch.yml',
    reason: '改动了插件加载配置（影响 DSH 运行时注入）',
  },
]

/**
 * Lines that only look like code.
 *
 * A comment can mention `approve` or `cookie` all day without changing what runs. If the
 * marker rules below did not skip them, then documenting a decision would trip the gate
 * meant to protect it — and a gate that fires on prose gets switched off within a week.
 */
const COMMENT_ONLY_LINE = /^\s*(\/\/|\/\*|\*|\*\/|#)/

/**
 * ## 大文件里的敏感区域（v0.2.21）
 *
 * `src/publisher.ts`、`src/runtime.ts`、`src/settings-routes.ts` 与平台的 `adapter.ts` 都不是
 * 单一用途的文件：它们同时装着编排、展示、路由注册和读路径。把整份文件标成敏感，等于每次
 * 改一行注释、加一个只读诊断字段都要人守着 —— 那种守卫最后一定会被绕过，因为它挡的是工作
 * 而不是风险。
 *
 * 所以这里的粒度是**行**：只有当改动落到「发表、批准、能力、凭据、身份、回读」这些语义上
 * 的行，才停下来要授权。判据是改动行里的标识符，外加一条：纯注释行不算。
 *
 * 这不是完美的语义分析 —— 它抓不到「把敏感逻辑挪进另一个文件」。但配合下面按路径整份拦的
 * `src/safety.ts`、`src/verification.ts`，以及 `src/security/**`，剩下的绕道要么在别处也会
 * 被抓到，要么需要人真的读懂代码才写得出来，而那已经不属于「悄悄自动合并」的范畴。
 */
export const SENSITIVE_LINE_MARKERS = [
  {
    id: 'publish-orchestration',
    test: (path) => path === 'src/publisher.ts',
    markers: [
      /publish/i,
      /approv/i,
      /authoriz/i,
      /capabilit/i,
      /credential/i,
      /humanApproved/,
      /checkPublishPolicy/,
      /assertCapability/,
      /dedupe/i,
      /inFlight/,
      /targetSnapshot/,
      /hasStableAuthor/,
      /sendOnce/,
      /readBack|readback|回读/,
    ],
    reason: '改动了发表编排（发表、人工批准、能力校验、凭据或回读）',
  },
  {
    id: 'runtime-publish-auth',
    test: (path) => path === 'src/runtime.ts',
    markers: [
      /publish/i,
      /approv/i,
      /authoriz/i,
      /capabilit/i,
      /credential/i,
      /cookie/i,
      /verif/i,
      /assertCapability/,
      /assertSessionCanGenerate/,
      /ownerKey/,
    ],
    reason: '改动了运行时里的真实发表或授权逻辑',
  },
  {
    id: 'settings-auth-credentials',
    test: (path) => path === 'src/settings-routes.ts',
    markers: [
      /cookie/i,
      /credential/i,
      /secret/i,
      /token/i,
      /apiKey|api_key/i,
      /passwor/i,
      /approv/i,
      /publish/i,
      /verif/i,
      /authoriz/i,
      /ownerKey|ownerUserId/i,
      /session/i,
    ],
    reason: '改动了设置页里的授权或凭据操作',
  },
  {
    id: 'platform-adapter-write',
    // 平台的 adapter 同时负责读与写。写路径（发帖、回复、发表）必须有人看过；读数不行。
    test: (path) => /^src\/platforms\/[^/]+\/adapter\.ts$/i.test(path),
    markers: [
      /\bpublish/i,
      /\breply\b|\breplies\b/i,
      /\bcomment/i,
      /\bpost\b|\bposts\b/i,
      /\bsend\b/i,
      /\bsubmit\b/i,
      /captcha|challenge/i,
    ],
    reason: '改动了真实平台适配器的写入路径',
  },
  {
    id: 'tool-publish-approval',
    test: (path) => path === 'src/tools.ts',
    markers: [
      /\bpublish/i,
      /\bapprov/i,
      /\bconfirm\b/i,
      /debate_publish_reply/,
    ],
    reason: '改动了发表工具的批准参数',
  },
]

/**
 * Files that are entirely about one sensitive thing, so the whole file is the unit.
 *
 * `src/safety.ts` is the publish policy itself and `src/verification.ts` is the one-off
 * publish-verification flow. Neither has a "read-only corner": every function in them is a
 * decision about whether something may be sent. Splitting them by line would be pretending
 * to a precision that does not exist.
 */
export const SENSITIVE_WHOLE_FILES = [
  {
    id: 'publish-policy',
    path: 'src/safety.ts',
    reason: '改动了发表策略本身（互动模式、人工确认、暂停条件）',
  },
  {
    id: 'publish-verification',
    path: 'src/verification.ts',
    reason: '改动了一次性发表验收流程（授权、一次性、回读判定）',
  },
  {
    id: 'publish-verification-runner',
    path: 'src/verification-runner.ts',
    reason: '改动了发表验收的执行链路（真实调用、持久化、回读）',
  },
  {
    id: 'capability-evidence',
    path: 'src/capability-evidence.ts',
    reason: '改动了能力证据判定（决定什么算「已验证」）',
  },
  {
    id: 'publish-verification-service',
    path: 'src/verification-service.ts',
    reason: '改动了发表验收的装配（哪个账号、哪个适配器版本、哪些记录算数）',
  },
  {
    id: 'publish-verification-view',
    path: 'src/verification-view.ts',
    reason: '改动了验收页面的读数口径（哪些能力算已验证、报告字段怎么拼）',
  },
]

/**
 * `package.json` 只有在动到这些字段时才算敏感。
 *
 * 整个文件标成敏感会让每一次版本号变更都停下来问人，那等于没有自动交付。真正危险的只有：
 * 依赖（可能盖掉 DSH 核心模块）、运行时要求、以及 DSH 的挂载声明。
 */
export const SENSITIVE_PACKAGE_FIELDS = [
  '"dependencies"',
  '"peerDependencies"',
  '"optionalDependencies"',
  '"engines"',
  '"dsh"',
  '"scripts"',
]

/**
 * 判断一批变更是否需要人来点。
 *
 * 三类判据，从粗到细：
 *
 * 1. `SENSITIVE_RULES` —— 整类路径（工作流、扫描规则、打包规则、`src/security/**`、平台发表文件）
 * 2. `SENSITIVE_WHOLE_FILES` —— 整份文件只谈一件事的（发表策略、验收流程）
 * 3. `SENSITIVE_LINE_MARKERS` —— 大文件里落到敏感语义的行（发表、批准、能力、凭据、回读）
 *
 * 第 3 类的「行」是 `addedLines` / `removedLines`，调用方从 `git diff` 取。只读的时候
 * 拿不到改动行，这时第 3 类不会命中 —— 调用方必须**先**确认自己确实拿到了 diff，
 * 拿不到就直接失败，否则「没看见改动」会被读成「没有敏感改动」。
 *
 * @param {Array<{path: string, addedLines?: string[], removedLines?: string[]}>} changes
 * @returns {{sensitive: boolean, reasons: Array<{id: string, path: string, reason: string}>}}
 */
export function classifySensitive(changes) {
  const reasons = []
  const seen = new Set()

  const push = (id, path, reason) => {
    const key = `${id}:${path}`
    if (seen.has(key)) return
    seen.add(key)
    reasons.push({ id, path, reason })
  }

  for (const change of changes ?? []) {
    const path = String(change?.path ?? '').split('\\').join('/')
    if (path === '') continue

    for (const rule of SENSITIVE_RULES) {
      if (rule.test(path)) push(rule.id, path, rule.reason)
    }

    for (const rule of SENSITIVE_WHOLE_FILES) {
      if (path === rule.path) push(rule.id, path, rule.reason)
    }

    for (const rule of SENSITIVE_LINE_MARKERS) {
      if (!rule.test(path)) continue
      const touched = [...(change.addedLines ?? []), ...(change.removedLines ?? [])]
      // 纯注释行不算：文档里提到 `approve` 不等于改了批准逻辑。
      const code = touched.filter((line) => line.trim() !== '' && !COMMENT_ONLY_LINE.test(line))
      const hit = rule.markers.find((marker) => code.some((line) => marker.test(line)))
      if (hit !== undefined) push(rule.id, path, rule.reason)
    }

    if (path === 'package.json') {
      const touched = [...(change.addedLines ?? []), ...(change.removedLines ?? [])]
      const hit = SENSITIVE_PACKAGE_FIELDS.filter((field) => touched.some((line) => line.includes(field)))
      if (hit.length > 0) {
        const key = 'package-fields:package.json'
        if (!seen.has(key)) {
          seen.add(key)
          reasons.push({
            id: 'package-fields',
            path,
            reason: `改动了 package.json 的 ${hit.map((f) => f.replace(/"/g, '')).join('、')}`,
          })
        }
      }
    }
  }

  return { sensitive: reasons.length > 0, reasons }
}

/** 版本号必须是三段纯数字。`v` 前缀在这一层不接受，避免 `vv0.2.17` 这种拼出来的标签。 */
export function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) {
    throw new Error(`版本号必须形如 0.2.17，收到的是 ${JSON.stringify(version)}`)
  }
  return version
}

/** 标签名。只有这一处生成标签，别处不再拼字符串。 */
export function tagForVersion(version) {
  return `v${assertSemver(version)}`
}

/**
 * 功能分支名。
 *
 * 带上版本号，是为了让「这个分支属于哪个版本」在分支列表里一眼可见 —— 同时也是幂等的凭据：
 * 同一版本重跑会命中同一个分支名，而不是再造一个 `-2`。
 *
 * 前缀用 `release/` 而不是直接 `v<version>`：同名分支与同名标签在 `git checkout`、
 * `gh pr create --head`、日志里都会互相歧义，看错对象在一次发布里是很贵的错误。
 *
 * slug 清洗后为空（传了空串、纯符号、纯空格）一律落回 `auto`。这条很重要：调用方
 * 有时从环境变量取 slug，取到空串和取不到都表现为「空」，如果两者给出不同分支名，
 * 「同一版本只跑一次」就被破了。
 */
export function branchForVersion(version, slug) {
  assertSemver(version)
  const clean = String(slug ?? 'auto')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `release/v${version}-${clean === '' ? 'auto' : clean}`
}

/**
 * ## 标签只能有一个目标
 *
 * 三种情况必须分开处理，混在一起就会出现「悄悄移动标签」：
 *
 * - 标签不存在、且知道本次要发布哪个提交 → 可以创建
 * - 标签存在且指向本次要发布的提交 → 已经做过了，跳过（幂等）
 * - 标签存在但指向别处 → 停下来。移动标签会让已经下载过旧产物的人无法复现，
 *   而 GitHub Release 会跟着标签走，等于篡改历史
 * - 连「要发布哪个提交」都不知道 → 停下来。不知道目标就没有「标签指向对了吗」这个判据，
 *   此时建标签等于闭着眼睛盖戳
 *
 * @returns {{action: 'create'|'reuse'|'refuse', reason: string}}
 */
export function decideTag({ tagExists, tagCommit, expectedCommit }) {
  if (expectedCommit === null || expectedCommit === undefined || String(expectedCommit).trim() === '') {
    return {
      action: 'refuse',
      reason: '不知道本次要发布哪个提交（expectedCommit 为空），无法判断标签指向是否正确。',
    }
  }
  if (!tagExists) return { action: 'create', reason: '标签不存在，可以创建' }
  if (tagCommit === expectedCommit) {
    return { action: 'reuse', reason: '标签已指向本次要发布的提交，跳过创建' }
  }
  return {
    action: 'refuse',
    reason:
      `标签已存在并指向 ${String(tagCommit).slice(0, 12)}，而本次要发布的是 ` +
      `${String(expectedCommit).slice(0, 12)}。移动标签会让已下载旧产物的人无法复现，` +
      '请改用新版本号，或先确认旧发布应当保留。',
  }
}

/**
 * ## Release 的重发规则
 *
 * 发布失败后重试是正常需求，但「重试」不等于「覆盖」：
 *
 * - 没有 Release → 创建
 * - 有 Release 且附件与本地一致 → 视为已完成，只做核验
 * - 有 Release 但附件不一致 → 停下来。这说明同一个标签下的产物变了，
 *   要么是本地构建不确定，要么是有人动过标签，两种都不能靠覆盖掩盖
 *
 * ## 为什么这里比的是「名字 + 字节数」而不是哈希
 *
 * GitHub 的 Release API 不返回每个附件的 sha256 —— 除非把附件下载下来算一遍。发布脚本
 * 在**核验阶段**之后不会重下（那正是 `verifyRelease` 要等的东西），所以这里能拿来比的事实
 * 只有名字和字节数。把哈希写进比较条件，会让这条决策在真实数据上永远判「不一致」，
 * 于是自动发布永远走不通 —— 一个永远拒绝的守卫和一个永远放行的守卫一样没用。
 *
 * 因此：名字或字节数不一致 → 拒绝；两边都带 sha256 且不同 → 也拒绝（测试与将来的
 * API 都能用上）；只有名字与字节数就够判断时，按字节数判。
 */
export function decideRelease({ releaseExists, remoteAssets, localAssets }) {
  if (!releaseExists) return { action: 'create', reason: '还没有 Release，可以创建' }

  const remote = new Map((remoteAssets ?? []).map((asset) => [asset.name, asset]))
  const mismatched = []

  for (const asset of localAssets ?? []) {
    const observed = remote.get(asset.name)
    if (observed === undefined) {
      mismatched.push(`${asset.name}：Release 里没有这个附件`)
      continue
    }
    if (typeof observed.bytes === 'number' && observed.bytes !== asset.bytes) {
      mismatched.push(`${asset.name}：Release 为 ${observed.bytes} 字节，本地为 ${asset.bytes} 字节`)
      continue
    }
    // 两边都给得出哈希时才比哈希：一边缺失就当作「没观测到」，不能当成不一致。
    if (observed.sha256 && asset.sha256 && observed.sha256 !== asset.sha256) {
      mismatched.push(
        `${asset.name}：Release 为 ${String(observed.sha256).slice(0, 12)}，本地为 ${String(asset.sha256).slice(0, 12)}`,
      )
    }
  }

  if (mismatched.length === 0) {
    return { action: 'reuse', reason: 'Release 已存在且附件与本地一致，跳过创建' }
  }
  return {
    action: 'refuse',
    reason: `Release 已存在但附件与本地不一致：${mismatched.join('；')}。覆盖会让人无法复现，需人工确认。`,
  }
}

/**
 * ## 阶段推进
 *
 * 每个阶段只能回答一件事：**下一步是什么**。它不看「已经过了几个阶段」，只看当前状态与
 * 外部事实，所以从中断处恢复不需要重放历史 —— 把状态文件里的 `stage` 交回来，它就能接着说。
 *
 * 返回值里的 `action` 是给 `ship.mjs` 执行的动作名，`blocked` 表示需要人来解。
 * `blocked` **总是显式的布尔值**：调用方会写 `if (decision.blocked)`，而 `undefined`
 * 与 `false` 在 `JSON.stringify` 之后一样、在报告里却一个是「漏了字段」一个是「明确放行」，
 * 交付报告要能被人当证据读，就不能留这种含糊。
 */
export function nextStep({ stage, sensitive, tagDecision, releaseDecision }) {
  const result = decideStage({ stage, sensitive, tagDecision, releaseDecision })
  return { blocked: result.blocked === true, ...result }
}

function decideStage({ stage, sensitive, tagDecision, releaseDecision }) {
  switch (stage) {
    case 'preflight':
      return { action: 'branch' }
    case 'branch':
      return { action: 'verify' }
    case 'verify':
      return { action: 'commit' }
    case 'commit':
      return { action: 'push' }
    case 'push':
      return { action: 'open_pr' }
    case 'pull_request':
      // 敏感变更在这里停：PR 已经建好、CI 会跑，但没有人点就不合并。
      if (sensitive) {
        return {
          action: 'block',
          blocked: true,
          reason: '本次变更触及权限策略、凭据规则或真实平台发表路径，按约定需要维护者授权后才合并',
          recovery: ['在 PR 页面人工审阅变更', '确认无误后手动 squash 合并', '合并后重跑 ship --resume 发布'],
        }
      }
      return { action: 'enable_auto_merge' }
    case 'auto_merge':
      return { action: 'wait_checks' }
    case 'wait_checks':
      return { action: 'tag' }
    case 'tag':
      if (tagDecision?.action === 'refuse') {
        return { action: 'block', blocked: true, reason: tagDecision.reason, recovery: ['改用新版本号'] }
      }
      if (tagDecision?.action === 'reuse') return { action: 'release' }
      return { action: 'create_tag' }
    case 'release':
      if (releaseDecision?.action === 'refuse') {
        return {
          action: 'block',
          blocked: true,
          reason: releaseDecision.reason,
          recovery: ['人工确认附件差异后决定是否改用新版本号'],
        }
      }
      if (releaseDecision?.action === 'reuse') return { action: 'verify_release' }
      return { action: 'trigger_release' }
    case 'verify_release':
      return { action: 'done' }
    case 'done':
      return { action: 'done' }
    default:
      return { action: 'block', blocked: true, reason: `未知阶段 ${String(stage)}`, recovery: ['删除状态文件重来'] }
  }
}

/**
 * 每个阶段失败后的恢复建议。写进状态报告，让人不用读代码就知道该做什么。
 *
 * 这张表对 `STAGES` 是**全覆盖**的，包括 `done`。给一个「成功阶段」写恢复建议看着多余，
 * 但缺一项意味着 `RECOVERY[stage]` 可能是 `undefined` —— 而读它的地方（状态报告、失败摘要）
 * 恰恰是在出问题的时候被调用的，那时候崩在这里最要命。`done` 的建议就是「这一轮结束了」。
 */
export const RECOVERY = {
  preflight: ['确认已安装 git 与 gh', '确认 gh auth status 已登录', '确认远端仓库地址正确'],
  branch: ['确认工作区没有未提交的改动', '确认 main 能快进到远端'],
  verify: ['按失败项修复后重跑 node scripts/ship.mjs', '不要跳过测试或放宽断言'],
  commit: ['检查是否真的有内容要提交'],
  push: ['确认对目标仓库有写权限', '确认没有把凭据放进提交'],
  pull_request: ['确认 gh 有 repo 权限', '确认分支已推送'],
  auto_merge: ['在仓库设置里开启 Allow auto-merge', '确认允许 Squash merge'],
  wait_checks: ['到 Actions 页面查看失败日志', '修复后推送同一分支，auto-merge 会自动继续'],
  tag: ['确认版本号未被占用', '不要移动已存在的标签'],
  release: ['查看 Release 工作流日志', '修复后重跑 node scripts/ship.mjs --resume'],
  verify_release: ['核对附件哈希与安装命令', '必要时人工修正发布说明'],
  done: [
    '这一轮已经结束，没有需要恢复的步骤',
    '要确认结果看 .ship/ 下的交付状态报告，或重跑 node scripts/ship.mjs --status',
  ],
}

/**
 * 记录一次运行的状态。
 *
 * 写入是原子的：先写临时文件再改名。中断发生在写入过程中时，读者要么看到旧的完整文件，
 * 要么看到新的完整文件，不会看到半截 JSON —— 而这正是「中断后还能恢复」的前提。
 */
export function createShipState({ version, startedAt = new Date().toISOString() }) {
  return {
    schema: STATE_SCHEMA,
    version: assertSemver(version),
    startedAt,
    updatedAt: startedAt,
    stage: 'preflight',
    status: 'in_progress',
    history: [],
    github: {},
    tests: null,
    artifacts: [],
    blocks: [],
  }
}

/**
 * 把一次阶段转移记进历史，并把当前阶段推进。
 *
 * 历史是有用的：失败时它回答「走到哪一步才坏的」，而单看 `stage` 只回答「现在停在哪」。
 *
 * ## 原地修改，并同时返回自己
 *
 * 这个函数**就地修改** `state` 并把同一个对象返回。两种写法都对：
 *
 * ```js
 * advanceState(state, { to: 'push' })          // state 已经推进
 * state = advanceState(state, { to: 'push' })  // 也对，拿到的是同一个对象
 * ```
 *
 * 之所以两种都容忍，是因为第一版只返回新对象、调用方普遍忽略了返回值 —— 于是
 * `ship.mjs` 每次都把「已推进」的状态丢掉，`--resume` 永远从 preflight 重来。
 * 纯函数在这里换来的那点可测性，远不如「调用方怎么写都不会错」值钱。
 */
export function advanceState(state, { to, status = 'in_progress', detail = {}, at = new Date().toISOString() }) {
  // 未知阶段必须在改动之前就拒绝：状态文件是恢复的唯一依据，写进一个不存在的阶段
  // 会让下一次 --resume 卡在 restoreState 的校验里，而错误现场已经被覆盖掉了。
  if (!STAGES.includes(to)) {
    throw new Error(`未知阶段 ${JSON.stringify(to)}，可选：${STAGES.join(', ')}`)
  }

  const from = state.stage
  state.stage = to
  state.status = status
  state.updatedAt = at
  state.github = { ...state.github, ...(detail.github ?? {}) }
  if (detail.tests !== undefined) state.tests = detail.tests
  if (detail.artifacts !== undefined) state.artifacts = detail.artifacts
  if (detail.blocks !== undefined) state.blocks = detail.blocks
  state.history = [...(state.history ?? []), { from, to, status, at, note: detail.note ?? '' }]
  return state
}

/**
 * 从状态文件恢复。
 *
 * 两个拒绝条件，都是「宁可重来也不误用」：
 *
 * - `schema` 对不上：结构变了，旧字段可能被误读成新含义
 * - `version` 对不上：上一轮删了状态文件
 *
 * 对不上的返回值不是异常，而是 `null` —— 调用方应当把「没有状态」当作正常起点，
 * 而不是让整个流水线因为一个陈旧的缓存文件瘫掉。
 */
export function restoreState(raw, { version }) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.schema !== STATE_SCHEMA) return null
  if (raw.version !== version) return null
  if (!STAGES.includes(raw.stage)) return null
  return raw
}
