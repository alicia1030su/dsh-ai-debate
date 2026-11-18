/**
 * 生成本轮三条受托授权 Review 的请求载荷（v0.3.0 收尾轮）。
 *
 * 只写文件，不发起网络请求 —— 提交由随后的 gh 调用完成，便于逐条核对。
 */
import { writeFileSync } from 'node:fs'

const PROVENANCE = [
  '## 这份记录是什么',
  '',
  '本仓库维护者（alicia1030su）在 2026-11-18 的书面指令中要求：',
  '「敏感变更按已有精确授权机制处理，不允许复用旧授权」。据此，执行代理为**本轮新产生的',
  'HEAD** 逐条提交本记录；上一轮针对 #42/#43/#35/#38 的授权对其余提交无效，也不被复用。',
  '',
  '- **是**维护者的授权决定：范围限于本 PR 与下面这个 head，超出即失效；',
  '- **不是**维护者逐行人工复核：代码审计由 AI 辅助完成，结论附在下面，可对照 diff 核对；',
  '- GitHub 只能证明「这个账号在此刻针对这个提交写了这段授权」，不能证明操作者是自然人。',
  '  这与 AGENTS.md 里「同一账号的 Comment review 是可审计、不是独立」一致。',
  '',
  '## 审计结论（AI 辅助，逐文件核对 diff）',
  '',
]

const bodies = {
  57: {
    head: 'f77544c4e640dcfebb9b7073e0cdfec990307791',
    scope: ['src/security/owner-integrity.ts'],
    audit: [
      '住址披露从单条正则改成分层判定。结构层（行政区划链 / 路名+门牌 / 小区+楼栋+房间 /',
      '邮编 / 全角数字）**先于**拒绝词判定并直接返回，因此「拒绝 + 真地址」仍然 block；',
      '实测三条混合表述全部拦下。断言层（住处标记 + 非拒绝分句）才受拒绝词影响。',
      '',
      '非住处语境的「地址」（下载/接口/仓库/公司…）用前后两个词表排除；实测',
      '「公司地址是杭州市西湖区文三路100号」仍然被结构层拦下 —— 排除词只压住标记层，',
      '压不住结构层，不能用来掩盖真实住址。',
      '',
      '手机号 / 身份证号 / 邮箱 / 「声称已公开主人隐私」四条旧规则未改动。',
      '新增 test/security/privacy-address.test.ts：18 条应放、15 条应拦。',
    ].join('\n'),
  },
  59: {
    head: '6920c7747504f2cf25532281857b5ee1c22d302f',
    scope: ['scripts/ship.mjs'],
    audit: [
      '两处都是真机发布中断的修复，不是预防性改动。',
      '',
      '1) `snapshotForPackaging` 用独立 `GIT_INDEX_FILE` 拍工作区快照（read-tree → add -A →',
      '   write-tree → commit-tree），只往对象库写一个游离提交，**不动 HEAD、不动 .git/index**；',
      '   随后 `commitAll` 比对 `HEAD^{tree}` 与打包用的树，不等即失败。',
      '   实测：同一工作区，旧路径产出 `-0.9.0.zip`（错），新路径产出 `-0.9.1-rc.1.zip`（对），',
      '   且 HEAD 与 `git status` 前后一致。不用 `git stash create`（它对未跟踪文件无效）。',
      '',
      '2) `gh pr view --json mergeQueueEntry` 在旧 CLI 上会整体失败。改为先带字段、识别',
      '   `Unknown JSON field` 后退回不带它的字段集；退回后队列状态显示「（未知）」而不是默认',
      '   「不在队列里」，并写入报告备注；ruleset 真有 merge queue 时记入 unverified。',
      '   不支持的字段只影响进度显示，不影响「是否已合并」的判定。',
      '',
      '`--admin`、不移动标签、不覆盖 Release 三条既有约束未改动（diff 中没有相关行）。',
      '新增 test/v0300-ship-publish-faults.test.ts：真实 git 仓库复现旧行为并验证新行为。',
    ].join('\n'),
  },
  60: {
    head: 'c14287408a2d1e4cab7d189bd3a74b9b17c55a5f',
    scope: ['scripts/lib/version-core.mjs'],
    audit: [
      'README 现在必须同时说明稳定版与候选版两条渠道，旧规则「四类上下文只能出现一个版本」',
      '已无法满足；继续要求单一版本只会导致文档写瘸或校验被关掉。',
      '',
      '放宽**只针对数量**（最多两个），关键约束收紧为：每类上下文**必须包含**当前要发布的',
      '版本。因此「发版忘改文档」「只改安装命令漏了附件名」「三个版本残留」「发正式版仍写 rc」',
      '四种情况仍然报错，且五条都有测试逐条钉住。',
      '',
      '这一条不放宽发布判定：README 不是发布内容的权威 —— 标签由 package.json 校验、',
      '预发布标记由 release.yml 的三态判定决定，README 说什么都不会改变 Release 的 prerelease 位。',
    ].join('\n'),
  },
}

for (const [n, item] of Object.entries(bodies)) {
  const body = [
    'ship-approval: v1',
    `pr: ${n}`,
    `head: ${item.head}`,
    `scope: ${item.scope.join(', ')}`,
    'note: 受托执行：维护者以书面指令要求按既有授权机制处理；代码由 AI 辅助审计，维护者未逐行亲自复核。',
    '',
    '---',
    '',
    ...PROVENANCE,
    item.audit,
  ].join('\n')

  writeFileSync(`.approval2/pr${n}.json`, `${JSON.stringify({ body, event: 'COMMENT', commit_id: item.head }, null, 2)}\n`, 'utf8')
}

console.log('已生成 3 条载荷')
