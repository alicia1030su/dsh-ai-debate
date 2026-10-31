/**
 * v0.2.18 §一 —— 流水线不能把失败吞掉。
 *
 * ## 这一版修的是哪一种「绿」
 *
 * `release.yml` 的测试步骤原来是：
 *
 *     run: |
 *       set -e
 *       node --experimental-transform-types --test "test 目录下的全部测试" 2>&1 | tee /tmp/test-output.log
 *
 * （真实写法是 node 的 glob 通配，这里不照抄：注释里出现 `星号+斜杠` 会提前结束块注释。）
 * 看起来已经在防失败了，其实没有。bash 的 `set -e` **不会**让管道在左侧命令失败时退出：
 * 管道的退出码是**最后一个**命令的退出码，而 `tee` 只要写成功就是 0。于是测试全红，
 * 这一步照样是绿的，`gh release create` 照常执行，正式版本照常发出去。
 *
 * 唯一会报警的是最后那份交付状态报告 —— 但它跑在 `gh release create` **之后**。
 * 「有人会发现」和「发布被拦住」不是一回事。
 *
 * ## 所以这里的断言分两层
 *
 * 1. **静态**：工作流里带管道的步骤必须写 `pipefail`，而且 `ci-guard.mjs` 里必须真的
 *    有这条检查（不只是注释里有）。
 * 2. **动态**：用真的 bash 把两种写法各跑一遍，证明 `set -e` 会吞、`set -euo pipefail`
 *    会传。再用真的 `node --test` 跑一个故意失败的测试文件，证明这条链路在真实工具链上
 *    确实返回非零 —— 也就是说，测试红了，Release 一定会红。
 *
 * 第 2 层需要 bash：发布路径本身就是 POSIX shell（GitHub Actions 的 `run:` 在 ubuntu 上
 * 就是 bash），所以验证它必须用 bash。找不到 bash 时这里**直接失败而不是跳过** ——
 * 一个因为环境缺东西就自动变绿的测试，正是这轮要消灭的东西。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')

function readWorkflow(name: string): string {
  return readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')
}

/** 按 `- name:` 切步骤，只留 shell 真正会执行的行（注释与空行不算）。 */
function shellSteps(workflow: string): Array<{ name: string, lines: string[] }> {
  const steps: Array<{ name: string, lines: string[] }> = []
  let current: { name: string, lines: string[] } | null = null
  let runIndent: number | null = null

  for (const raw of workflow.split(/\r?\n/)) {
    const stepMatch = /^\s*- name:\s*(.+)$/.exec(raw)
    if (stepMatch !== null) {
      current = { name: stepMatch[1].trim(), lines: [] }
      steps.push(current)
      runIndent = null
      continue
    }
    if (current === null) continue
    if (runIndent === null) {
      const blockRun = /^(\s*)run:\s*\|-?\s*$/.exec(raw)
      if (blockRun !== null) {
        runIndent = blockRun[1].length
        continue
      }
      const inlineRun = /^(\s*)run:\s*(\S.*)$/.exec(raw)
      if (inlineRun !== null) {
        current.lines.push(inlineRun[2].trim())
        runIndent = -1
        continue
      }
      continue
    }
    if (runIndent < 0) continue
    if (raw.trim() === '') continue
    if (raw.length - raw.trimStart().length <= runIndent) {
      runIndent = -1
      continue
    }
    const line = raw.trim()
    if (line.startsWith('#')) continue
    current.lines.push(line)
  }

  return steps.filter((step) => step.lines.length > 0)
}

/** 引号里的 `|` 是参数，不是管道。 */
function unquoted(line: string): string {
  return line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/**
 * 找一个能跑脚本的 bash。
 *
 * Windows 上的 Git for Windows 自带 bash；Linux/macOS 上 bash 在 PATH 里。
 * 找不到就抛，**不跳过**。
 */
function bashPath(): string {
  const candidates = [
    '/bin/bash',
    '/usr/bin/bash',
    '/usr/local/bin/bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const found = execFileSync('bash', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (found.includes('bash')) return 'bash'
  } catch {
    // 落到下面统一报错
  }
  throw new Error(
    '找不到 bash。发布路径本身就是 POSIX shell，没有 bash 就无法验证「测试失败会不会让发布失败」——'
    + '这个测试故意失败而不是跳过，因为跳过会假装这条链路已经验证过。',
  )
}

/**
 * 子进程要跑在「和 GitHub Actions 一样的」环境里。
 *
 * `NODE_TEST_CONTEXT` 是 Node 测试运行器给自己派生的子进程打的标记；带着它再启动一个
 * `node --test`，子进程会以为自己是某个测试的子任务而不是一次独立运行，退出码就不再
 * 反映测试结果 —— 第一版这里就是这么被骗过去的：明明有失败用例，子进程却返回 0。
 * 恰好是同一个「绿得不对」的毛病，所以宁可显式剥掉再跑。
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_TEST_CONTEXT' || key === 'NODE_OPTIONS') continue
    env[key] = value
  }
  return env
}

/** 在临时目录里跑一段 bash 脚本，返回退出码与标准输出。 */
function runBash(script: string): { status: number, stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-'))
  try {
    const file = join(dir, 'step.sh')
    // \n 而不是平台默认换行：CRLF 会让 bash 在 `\r` 上出错。
    writeFileSync(file, script.replace(/\r\n/g, '\n'), 'utf8')
    const result = spawnSync(bashPath(), [file], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: cleanEnv(),
    })
    return { status: result.status ?? -1, stdout: String(result.stdout ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- 静态：工作流里带管道的步骤必须有 pipefail -----------------------------

test('release.yml 的测试步骤用 set -euo pipefail，不是裸 set -e', () => {
  const steps = shellSteps(readWorkflow('release.yml'))
  const testStep = steps.find((step) => step.lines.some((line) => /--test\s/.test(line)))
  assert.ok(testStep !== undefined, 'release.yml 里找不到跑测试的步骤')

  const body = testStep.lines.join('\n')
  assert.match(body, /\bset\s+-[a-z]*e[a-z]*o\s+pipefail\b|\bset\s+-euo\s+pipefail\b/, '测试步骤没有开启 pipefail')
  assert.match(body, /pipefail/, '测试步骤没有 pipefail')
  // 有管道就是有风险：这里断言它确实还带着管道，说明 pipefail 不是装饰。
  assert.ok(
    testStep.lines.some((line) => /[^|]\|[^|]/.test(unquoted(line))),
    '测试步骤不再有管道了；如果改成直接重定向，这条测试应该跟着改，而不是留着一条空断言',
  )
})

test('两个工作流里每一个带管道的步骤都写了 pipefail', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    for (const step of shellSteps(readWorkflow(name))) {
      const piped = step.lines.filter((line) => /[^|]\|[^|]/.test(unquoted(line)))
      if (piped.length === 0) continue
      assert.match(
        step.lines.join('\n'),
        /pipefail/,
        `${name} 的步骤「${step.name}」有管道却没有 pipefail：${piped[0]}`,
      )
    }
  }
})

test('ci-guard.mjs 里真的有 pipefail 这条检查，不只是注释', () => {
  const guard = readFileSync(join(ROOT, 'scripts', 'ci-guard.mjs'), 'utf8')
  const code = guard
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n')
  assert.match(code, /pipefail/, 'ci-guard 的代码里没有 pipefail 检查')
  assert.match(code, /unquoted/, 'ci-guard 没有排除引号内的 |，会把正则当管道')
})

// --- 动态：`set -e` 吞失败，`set -euo pipefail` 传失败 ---------------------

test('set -e 单独用会吞掉管道左侧的失败（这就是那个缺陷）', () => {
  const result = runBash([
    'set -e',
    'bash -c "exit 3" 2>&1 | cat',
    'echo AFTER_PIPE',
  ].join('\n'))

  // 左侧退出 3，但管道取 cat 的状态，cat 成功 —— 于是整步"成功"，后续命令照跑。
  assert.equal(result.status, 0, 'set -e 竟然传播了管道失败；这条测试的前提变了，需要重新审视')
  assert.match(result.stdout, /AFTER_PIPE/, 'set -e 之后的后继命令没有执行，与预期不符')
})

test('set -euo pipefail 会让管道左侧的失败让整步失败', () => {
  const result = runBash([
    'set -euo pipefail',
    'bash -c "exit 3" 2>&1 | cat',
    'echo AFTER_PIPE',
  ].join('\n'))

  assert.notEqual(result.status, 0, 'pipefail 没有传播管道失败')
  assert.doesNotMatch(result.stdout, /AFTER_PIPE/, '失败之后还不该继续执行后续命令')
})

// --- 动态：真的跑 node --test，证明测试红了这条链路就红 --------------------

test('真的 node --test 失败时，带 pipefail 的管道返回非零', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-failing-test-'))
  try {
    // 一个一定会失败的测试文件。用 .test.mjs 而不是 .test.ts，避免依赖 transform 参数。
    writeFileSync(
      join(dir, 'deliberately-failing.test.mjs'),
      [
        "import assert from 'node:assert/strict'",
        "import { test } from 'node:test'",
        "test('故意失败', () => {",
        '  assert.equal(1, 2)',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )

    const script = [
      'set -euo pipefail',
      `"${process.execPath}" --test deliberately-failing.test.mjs 2>&1 | tee out.log`,
      'echo SHOULD_NOT_REACH_HERE',
    ].join('\n')

    const file = join(dir, 'step.sh')
    writeFileSync(file, script.replace(/\r\n/g, '\n'), 'utf8')

    const result = spawnSync(bashPath(), [file], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: cleanEnv(),
    })

    assert.notEqual(result.status ?? -1, 0, 'node --test 失败了，但整条管道仍然返回 0')
    assert.doesNotMatch(String(result.stdout ?? ''), /SHOULD_NOT_REACH_HERE/, '测试失败后还继续跑了下一步')

    // 日志确实写出来了：交付状态报告要靠它拿到真实的通过/失败计数。
    assert.ok(existsSync(join(dir, 'out.log')), 'tee 没有把输出写进日志文件')
    assert.match(readFileSync(join(dir, 'out.log'), 'utf8'), /fail 1|failing|not ok/i, '日志里没有失败记录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- ship.mjs 的执行链路也不能吞 ------------------------------------------

test('ship.mjs 在拿不到改动清单时失败，而不是当成「没有改动」', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8')

  // 这三处都是「读不到事实就当没有事实」的默认值，安全判定上等于放行。
  assert.doesNotMatch(source, /if \(names\.code !== 0\) return \[\]/, 'collectChanges 仍然在 git diff 失败时返回空改动')
  assert.doesNotMatch(source, /others\.code === 0 \? others\.stdout/, '未跟踪文件列表失败时仍被静默忽略')

  const collect = /function collectChanges[\s\S]*?\n}/.exec(source)
  assert.ok(collect !== null, '找不到 collectChanges')
  assert.match(collect[0], /fail\('verify'/, 'collectChanges 失败时没有 fail')
  assert.match(collect[0], /diff\.code !== 0/, '单文件 diff 失败没有被发现')
})

test('ship.mjs 打标签前会确认 origin 引用是新的', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8')

  // 这两步决定「标签指向哪个提交」，失败继续跑就会把标签打到旧提交上。
  assert.match(source, /const fetchMain = run\('git', \['fetch', 'origin'\]\)/, '取 origin 时没有检查退出码')
  assert.match(source, /if \(fetchMain\.code !== 0\)/, 'git fetch 失败后仍然继续')
  assert.match(source, /const mainShaResult = run\('git', \['rev-parse'/, '读 origin 提交时没有检查退出码')
  assert.match(source, /if \(mainShaResult\.code !== 0\)/, 'rev-parse 失败后仍然继续')
})
