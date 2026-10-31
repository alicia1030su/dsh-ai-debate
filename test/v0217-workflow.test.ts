/**
 * v0.2.17 §2 —— 工作流自己也要有测试。
 *
 * 之前所有测试都在测 `src/` 和 `scripts/`，而真正决定「什么能发出去」的是
 * `.github/workflows/*.yml`。那个文件没有测试，于是它犯过的错都是靠真发一次版才发现的：
 *
 * - v0.2.16 的第一次标签发布失败在 `upload-artifact` 拒绝 `..` 路径上；
 * - 更早的 `ci.yml` 有一步是多行 shell 却没写 `set -e`，失败后若有后续命令成功，整步还是绿的。
 *
 * 这两种错误都不会让本地 `pnpm test` 变红，因为本地根本不跑工作流。所以这里直接读 YAML 断言它的
 * 结构。解析器是自己写的（只按缩进切块），因为项目没有 YAML 依赖，而为了测试去加一个运行时
 * 依赖并不划算 —— 我们只需要读自己的这两个文件。
 *
 * 断言的都是「结构性质」，不是具体命令字符串：比如「创建 Release 的那一步必须被 refs/tags 守卫」，
 * 而不是「第 154 行必须是某个 if 表达式」。后者会在无关改动时乱红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')

function readWorkflow(name) {
  return readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')
}

/**
 * 按缩进把 jobs 下的 steps 切成块。
 *
 * 返回 `{ text, header }`：`text` 是这一步的完整原文，`header` 是 `- name:` 那一行。
 * 只处理我们自己写的工作流，不追求通用 YAML 语义。
 */
function stepsOf(workflow) {
  const lines = workflow.split(/\r?\n/)
  const steps = []
  let current = null
  let inSteps = false
  let stepIndent = null

  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    if (/^steps:\s*$/.test(trimmed)) {
      inSteps = true
      continue
    }
    if (!inSteps) continue

    // 回到比 steps 更浅的位置，说明这个 job 的 steps 结束了。
    if (trimmed !== '' && indent === 0) {
      inSteps = false
      current = null
      continue
    }

    const isStepStart = /^-\s/.test(trimmed)
    if (isStepStart) {
      if (stepIndent === null) stepIndent = indent
      if (indent === stepIndent) {
        if (current !== null) steps.push(current)
        current = { header: trimmed, text: line }
        continue
      }
    }

    if (current !== null) current.text += `\n${line}`
  }

  if (current !== null) steps.push(current)
  return steps
}

/** 多行 shell 步骤必须显式 `set -e`：这是 `run: |` 最容易漏的一条。 */
function assertSetE(workflow, label) {
  for (const step of stepsOf(workflow)) {
    const isMultiline = /run:\s*\|/.test(step.text)
    if (!isMultiline) continue
    assert.match(step.text, /set -e/, `${label} 的多行步骤 ${step.header} 缺少 set -e`)
  }
}

// --- 两个工作流都存在且能触发 ---------------------------------------------

test('ci.yml 与 release.yml 都存在，且都有明确的触发条件', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const workflow = readWorkflow(name)

    assert.match(workflow, /^name:\s*\S+/m, `${name} 缺少 name`)
    const triggers = /^on:/m.test(workflow)
    assert.equal(triggers, true, `${name} 没有 on: 触发条件`)

    // 一个没有触发条件的工作流永远不会跑，但也没有任何东西会报错。
    const hasTrigger = /push:|pull_request:|workflow_dispatch:|workflow_call:/.test(workflow)
    assert.equal(hasTrigger, true, `${name} 没有任何实际触发方式`)
  }
})

// --- CI 的门禁内容 --------------------------------------------------------

test('CI 在 Node 22.18 与 24 上都跑', () => {
  const ci = readWorkflow('ci.yml')

  assert.match(ci, /22\.18/, '缺少 Node 22.18：那是我们告诉用户的最低版本')
  assert.match(ci, /['"]24['"]|^\s*-\s*24\s*$/m, '缺少 Node 24：那是 DSH 运行时')
  assert.match(ci, /fail-fast:\s*false/, 'fail-fast 会让一个版本失败就隐藏另一个版本的结果')
})

test('CI 用 --frozen-lockfile 安装依赖', () => {
  const ci = readWorkflow('ci.yml')
  assert.match(ci, /pnpm install --frozen-lockfile/, '不锁依赖安装的 CI 无法复现')
})

test('CI 跑编译、类型检查、全部测试', () => {
  const ci = readWorkflow('ci.yml')

  assert.match(ci, /tsc -p tsconfig\.json/, '缺少生产代码编译')
  // 测试代码的类型检查走棘轮脚本，不是裸 tsc：`tsconfig.test.json` 曾经继承了基配置的
  // `exclude: ["...","test"]`，裸 tsc 会「编译成功」但一个测试文件都不检查。
  // 断言脚本被调用，并顺带断言裸 tsc 不再出现在工作流里 —— 否则两种写法并存时，
  // 谁都不知道到底哪一道在起作用。
  assert.match(ci, /node scripts\/test-typecheck\.mjs/, '缺少含测试项的类型检查（棘轮脚本）')
  // 只查「真正会执行的命令行」，不查注释：注释里提旧做法（解释为什么换掉它）是应该的。
  // 第一版直接 doesNotMatch 整份 YAML，结果被自己写的说明文字判红 —— 闸门要紧的是
  // 跑起来的命令，不是文档里出现过什么字样。
  const executedLines = ci
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
  assert.ok(
    !executedLines.some((line) => /tsc -p tsconfig\.test\.json/.test(line)),
    '不要退回裸 tsc，它检查不到 test/ 目录',
  )
  assert.match(
    ci,
    /node --experimental-transform-types --test "test\/\*\*\/\*\.test\.ts"/,
    '测试必须用通配而不是固定文件列表，否则新文件会被静默跳过',
  )
})

test('CI 做独立的凭据扫描与归档扫描', () => {
  const ci = readWorkflow('ci.yml')

  assert.match(ci, /node scripts\/audit-leaks\.mjs/, '缺少仓库级凭据扫描')
  assert.match(ci, /node scripts\/scan-archive\.mjs/, '缺少归档级独立扫描')
  assert.match(ci, /--require-archive/, '扫描必须在源码包确实生成之后才算数')
})

test('CI 校验提交的 lib/ 与源码一致，且 .gitignore 没有排除 lib/', () => {
  const ci = readWorkflow('ci.yml')
  assert.match(ci, /git diff --exit-code[^\n]*lib\//, '缺少 lib/ 与源码一致性检查')

  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  const ignoresLib = ignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => ['lib/', 'lib', '/lib', '/lib/'].includes(line))
  assert.equal(ignoresLib, false, '.gitignore 排除了 lib/，上面的检查会在空 diff 上通过')
})

test('CI 调用 CI 守卫脚本', () => {
  const ci = readWorkflow('ci.yml')
  assert.match(ci, /node scripts\/ci-guard\.mjs/, '缺少 CI 守卫检查')
})

// --- Release 工作流的发布条件 ---------------------------------------------

test('推送分支不能发布正式版本：创建 Release 的步骤必须被标签守卫', () => {
  const release = readWorkflow('release.yml')
  const createStep = stepsOf(release).find((step) => step.text.includes('gh release create'))

  assert.ok(createStep, 'release.yml 里找不到创建 Release 的步骤')
  assert.match(
    createStep.text,
    /if:\s*[^\n]*startsWith\(github\.ref,\s*'refs\/tags\/'\)/,
    '创建 Release 的步骤没有限定只对标签触发，分支推送就能发布正式版本',
  )
})

test('手动触发必须默认 dry_run，不能一点就发', () => {
  const release = readWorkflow('release.yml')

  assert.match(release, /workflow_dispatch:/, '缺少手动触发入口')
  assert.match(release, /dry_run:/, '手动触发没有 dry_run 开关')
  assert.match(release, /default:\s*true/, 'dry_run 默认值必须是 true')

  const createStep = stepsOf(release).find((step) => step.text.includes('gh release create'))
  assert.match(createStep.text, /inputs\.dry_run\s*!=\s*true/, '创建 Release 没有检查 dry_run')
})

test('Release 用 --verify-tag，标签不存在时不发布', () => {
  const release = readWorkflow('release.yml')
  assert.match(release, /--verify-tag/, '没有 --verify-tag 就可能为不存在的标签建 Release')
})

test('Release 的工作流权限显式声明 contents: write', () => {
  const release = readWorkflow('release.yml')
  assert.match(release, /permissions:[\s\S]{0,80}?contents:\s*write/, '创建 Release 需要 contents: write')
})

test('上传产物路径不能含 ..（upload-artifact v4 会直接拒绝）', () => {
  // v0.2.16 第一次标签发布就失败在这里：
  // ##[error]Invalid pattern '../dsh-ai-debate-source-0.2.16.zip'.
  const release = readWorkflow('release.yml')
  const uploadStep = stepsOf(release).find((step) => step.text.includes('upload-artifact'))

  assert.ok(uploadStep, '找不到上传产物的步骤')
  assert.doesNotMatch(uploadStep.text, /\.\.\//, '上传路径里出现了 ..，upload-artifact 会拒绝')

  // 源码包必须被写进工作区，否则它不可能是可上传的路径。
  assert.match(release, /source-zip\.mjs --out \./, '源码包必须用 --out . 写进工作区')
})

test('Release 的两个附件都被创建 Release 那一步带上', () => {
  const release = readWorkflow('release.yml')
  const createStep = stepsOf(release).find((step) => step.text.includes('gh release create'))

  assert.match(createStep.text, /\$TARBALL/, '没有附上安装包')
  assert.match(createStep.text, /\$SOURCE_ZIP/, '没有附上源码包')
})

test('Release 在发布前自己再跑一遍编译、类型检查与全部测试', () => {
  // 标签可能指向一个从未经过 CI 的提交（手动打标签、或 CI 被跳过），
  // 所以发布路径不能假设「CI 已经跑过了」。
  const release = readWorkflow('release.yml')

  assert.match(release, /tsc -p tsconfig\.json/, '发布前缺少编译')
  assert.match(release, /node scripts\/test-typecheck\.mjs/, '发布前缺少含测试项的类型检查（棘轮脚本）')
  assert.match(release, /node --experimental-transform-types --test/, '发布前缺少测试')
  assert.match(release, /pnpm install --frozen-lockfile/, '发布前缺少可复现的依赖安装')
})

test('Release 校验标签版本与 package.json 一致', () => {
  const release = readWorkflow('release.yml')
  assert.match(release, /GITHUB_REF_NAME#v/, '没有从标签名取版本')
  assert.match(release, /package\.json/, '没有读取 package.json 的版本')
})

test('Release 在发布前做独立扫描与安装包内容校验', () => {
  const release = readWorkflow('release.yml')

  assert.match(release, /node scripts\/scan-archive\.mjs/, '缺少独立归档扫描')
  assert.match(release, /tar -tzf/, '缺少用 tar 独立核对包内容')
  assert.match(release, /package\/lib\/index\.js/, '没有核对安装包里有入口文件')
})

// --- 「失败必须响亮」 -----------------------------------------------------

test('两个工作流都没有吞掉失败', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const workflow = readWorkflow(name)

    assert.doesNotMatch(workflow, /\|\|\s*true/, `${name} 里有 || true，会把失败吞掉`)
    assert.doesNotMatch(workflow, /continue-on-error:\s*true/, `${name} 里有 continue-on-error，失败不会变红`)
    // `set +e` 是显式关掉 err exit，与 set -e 反向，出现即视为问题。
    assert.doesNotMatch(workflow, /set \+e/, `${name} 里有 set +e`)
  }
})

test('两个工作流的多行 shell 步骤都写了 set -e', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    assertSetE(readWorkflow(name), name)
  }
})

test('两个工作流都没有用管理员权限绕过检查', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const workflow = readWorkflow(name)
    assert.doesNotMatch(workflow, /--admin/, `${name} 里出现了 --admin`)
  }
})

test('工作流里不打印任何凭据', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const workflow = readWorkflow(name)

    // secrets 只能作为 env 传进去，不能 echo；`gh auth token` 会直接把凭据打到日志里。
    assert.doesNotMatch(workflow, /echo[^\n]*\$\{\{\s*secrets\./, `${name} 里把 secret echo 出来了`)
    assert.doesNotMatch(workflow, /gh auth token/, `${name} 里调用了 gh auth token`)
    assert.doesNotMatch(workflow, /printenv|\benv\b\s*$/m, `${name} 可能把整个环境打印出来`)
  }
})

// --- v0.2.17 新增的门禁必须真的接进去了 ------------------------------------

test('CI 里有 Release 的无发布模拟步骤', () => {
  const ci = readWorkflow('ci.yml')
  assert.match(
    ci,
    /node scripts\/release-dry-run\.mjs/,
    '缺少 release-dry-run：打包/说明/附件的生成逻辑只能在真发版时才会被走到',
  )
})

test('Release 会产出机器可读的交付状态报告并上传', () => {
  const release = readWorkflow('release.yml')

  assert.match(
    release,
    /delivery-status/,
    'Release 没有产出交付状态报告，事后无法用机器核对这次交付到底验证了什么',
  )
})

test('CI 的测试步骤排在打包之前，源码包扫描排在打包之后', () => {
  // 顺序反了会让 `ci-guard --require-archive` 在包还不存在时失败（v0.2.16 踩过）。
  const ci = readWorkflow('ci.yml')
  const testIndex = ci.indexOf('--experimental-transform-types --test')
  const packIndex = ci.indexOf('source-zip.mjs')
  const guardIndex = ci.indexOf('--require-archive')

  assert.ok(testIndex > 0 && packIndex > 0 && guardIndex > 0, '三者都应存在')
  assert.ok(testIndex < packIndex, '测试应当在打包之前')
  assert.ok(packIndex < guardIndex, '--require-archive 必须在源码包生成之后')
})
