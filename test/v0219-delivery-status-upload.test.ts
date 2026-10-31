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
import { readFileSync } from 'node:fs'
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
})
