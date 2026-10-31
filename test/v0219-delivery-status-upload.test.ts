/**
 * 交付状态报告必须真的被传上去。
 *
 * v0.2.18 的正式发布每一步都对，唯独「上传交付状态报告」这一步是空的。日志里只有一行：
 *
 *   ##[warning]No files were found with the provided path: .ship/delivery-status-*.json.
 *   No artifacts will be uploaded.
 *
 * 而这一步的结论是 success，整个运行也是绿的。两个原因缺一不可：
 * `actions/upload-artifact@v4.4` 起默认跳过隐藏文件，而报告写在 `.ship/`（点开头的目录）里；
 * 并且这个 action 找不到文件时只警告、不失败。
 *
 * 这跟 v0.2.18 修的那个管道缺陷是同一族：**一步什么也没做，却报告成功。**
 * 上次吞的是退出码，这次吞的是「文件没找到」。
 *
 * 测试分两层：静态断言（工作流里真的写了这两个参数）+ 判别函数自测（参数缺失时必须报错，
 * 而不是因为「文件里有这几个字」就算过）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = join(import.meta.dirname, '..')

function workflow(name: string): string {
  return readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')
}

function guardSource(): string {
  return readFileSync(join(ROOT, 'scripts', 'ci-guard.mjs'), 'utf8')
}

/** 按 `- name:` 切步骤，注释与空行不算内容。独立实现，避免用被测代码证明被测代码。 */
function stepsOf(text: string): Array<{ name: string; text: string }> {
  const steps: Array<{ name: string; text: string }> = []
  let current: { name: string; text: string } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const named = raw.match(/^\s*- name:\s*(.+)$/)
    if (named) {
      if (current !== null) steps.push(current)
      current = { name: named[1].trim(), text: '' }
      continue
    }
    if (current !== null && !line.startsWith('#')) current.text += `${raw}\n`
  }
  if (current !== null) steps.push(current)
  return steps
}

/**
 * 上传步骤的判别函数 —— 与 `scripts/ci-guard.mjs` 里的检查同一套规则，
 * 但在这里独立实现一份：这条测试必须能在守卫自己被改坏时仍然报警。
 */
function auditUpload(step: { name: string; text: string }): string[] {
  const problems: string[] = []
  if (!step.text.includes('upload-artifact')) return problems

  if (!/if-no-files-found:\s*error/.test(step.text)) {
    problems.push(`${step.name}：没有写 if-no-files-found: error，找不到文件时只会警告`)
  }

  const paths = [...step.text.matchAll(/^\s*path:\s*(.+)$/gm)].map((match) => match[1].trim())
  const hasHiddenDir = paths.some((path) => path.split(/[/\\]/).some((part) => /^\.[A-Za-z_]/.test(part)))
  if (hasHiddenDir && !/include-hidden-files:\s*true/.test(step.text)) {
    problems.push(`${step.name}：路径里有隐藏目录，但没写 include-hidden-files: true`)
  }

  return problems
}

describe('v0.2.19 交付状态报告必须真的被上传', () => {
  it('release.yml 上传交付状态报告的步骤带上了两个参数', () => {
    const step = stepsOf(workflow('release.yml')).find((item) => item.name === '上传交付状态报告')
    assert.ok(step, 'release.yml 里找不到「上传交付状态报告」这一步')
    assert.match(step.text, /include-hidden-files:\s*true/, '写报告的 .ship/ 是隐藏目录，必须显式允许')
    assert.match(step.text, /if-no-files-found:\s*error/, '报告不存在就是失败，不能只警告')
    assert.match(step.text, /\.ship\/delivery-status-\*\.json/, '上传的 glob 必须仍然是报告的实际路径')
  })

  it('两个工作流里每一个上传步骤都通得过判别函数', () => {
    const problems: string[] = []
    for (const name of ['ci.yml', 'release.yml']) {
      for (const step of stepsOf(workflow(name))) {
        for (const problem of auditUpload(step)) problems.push(`${name}：${problem}`)
      }
    }
    assert.deepEqual(problems, [], `上传步骤有问题：\n${problems.join('\n')}`)
  })

  it('判别函数在参数缺失时真的会报错，不是「文件里有这几个字就算过」', () => {
    const broken = {
      name: '上传交付状态报告',
      text: [
        '        uses: actions/upload-artifact@v4',
        '        with:',
        '          name: delivery-status',
        '          path: .ship/delivery-status-*.json',
        '',
      ].join('\n'),
    }
    const problems = auditUpload(broken)
    assert.equal(problems.length, 2, `应当同时报出两个问题，实际：${JSON.stringify(problems)}`)
    assert.ok(problems.some((problem) => problem.includes('if-no-files-found')))
    assert.ok(problems.some((problem) => problem.includes('include-hidden-files')))

    const fixed = {
      ...broken,
      text: `${broken.text}          include-hidden-files: true\n          if-no-files-found: error\n`,
    }
    assert.deepEqual(auditUpload(fixed), [])
  })

  it('可见目录的上传步骤不必写 include-hidden-files，但必须写 if-no-files-found', () => {
    const visible = {
      name: '上传构建产物',
      text: [
        '        uses: actions/upload-artifact@v4',
        '        with:',
        '          name: dsh-ai-debate-${{ steps.pack.outputs.version }}',
        '          path: |',
        '            ${{ steps.pack.outputs.tarball }}',
        '            ${{ steps.pack.outputs.source_zip }}',
        '          if-no-files-found: error',
        '',
      ].join('\n'),
    }
    assert.deepEqual(auditUpload(visible), [])
  })

  it('ci-guard.mjs 里真有这条守卫，不只是注释', () => {
    const source = guardSource()
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    assert.match(source, /if-no-files-found/, '守卫里必须检查 if-no-files-found')
    assert.match(source, /include-hidden-files/, '守卫里必须检查 include-hidden-files')
    assert.match(source, /upload-artifact/, '守卫必须能找到上传步骤')
  })

  it('报告的默认输出路径与工作流里上传的 glob 是同一个目录', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'delivery-status-report.mjs'), 'utf8')
    assert.match(script, /join\(root, '\.ship', statusFileName\(version\)\)/, '脚本默认写到 .ship/')
    const step = stepsOf(workflow('release.yml')).find((item) => item.name === '上传交付状态报告')
    assert.ok(step)
    assert.match(step.text, /path:\s*\.ship\//, '工作流必须上传同一个目录，改名不能只在一边改')
  })

  /**
   * 报告里的「测试文件数」必须与 `node --test "test/**\/*.test.ts"` 实际会跑的文件数一致。
   *
   * v0.2.19 第一次发布这台机器上的报告写的是 `files: 93`，而磁盘上有 96 个
   * `*.test.ts` —— 因为计数只看了 `test/` 顶层，而 runner 的 glob 是递归的
   * （`test/fixtures/` 与 `test/security/` 下还有三个）。少报三个文件，
   * 正是这份报告存在的意义所要防的事：它得能让人看出「少跑了一个文件」。
   *
   * 这里直接跑一次真脚本，不看源码里写了什么 —— 把脚本改回非递归，files 会变 93，
   * 断言就红。
   *
   * ## 为什么显式传 `--status blocked`
   *
   * 这个脚本的默认 status 是 `success`，而 `success` 有一道自洽校验：必须有附件。
   * 在标签构建里，工作流的测试步骤跑在**打包之前**，仓库根没有产物 —— 于是脚本
   * 按 `status 是 success 但没有附件` 退出 1，这条测试跟着红。v0.2.19 第一次发布
   * 就是这样倒的：它只在我的机器上绿，因为我的机器根上恰好躺着上一次构建的产物。
   *
   * **一条只有在构建产物存在时才通过的测试，测的不是被测代码，测的是环境。**
   * 这里要验的是「报告里那个文件数怎么数」，与「这次构建有没有产出安装包」无关，
   * 所以让它走 `blocked` 分支：blocked 不声称发布成功，也就不需要附件，
   * 而 `tests.files` 仍然照常计算。顺带断言 status 确实是 blocked —— 证明脚本
   * 听从了传进去的值，而不是又被环境左右。
   */
  it('报告里的测试文件数是递归数出来的，与实际会跑的文件数一致', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.test.ts')) files.push(full)
      }
    }
    walk(join(ROOT, 'test'))

    const flat = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.test.ts'))
    assert.ok(
      files.length > flat.length,
      '这个仓库至少有一个测试文件不在 test/ 顶层；如果真变成全平铺，这条测试要跟着改，而不是留着空跑',
    )

    const dir = mkdtempSync(join(tmpdir(), 'dsh-report-'))
    try {
      const log = join(dir, 'test.log')
      writeFileSync(log, 'ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\n', 'utf8')
      const out = join(dir, 'report.json')
      const result = spawnSync(
        process.execPath,
        [
          join(ROOT, 'scripts', 'delivery-status-report.mjs'),
          '--test-log',
          log,
          '--status',
          'blocked',
          '--stage',
          'release',
          '--out',
          out,
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
      )
      assert.equal(result.status, 0, `报告脚本应当能跑完：${result.stderr ?? ''}`)
      const report = JSON.parse(readFileSync(out, 'utf8')) as {
        status: string
        tests: { files: number | null }
      }
      assert.equal(report.status, 'blocked', '脚本必须听从传入的 status，而不是按环境自行改口')
      assert.equal(
        report.tests.files,
        files.length,
        `报告说跑了 ${String(report.tests.files)} 个文件，磁盘上有 ${files.length} 个`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
