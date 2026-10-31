/**
 * v0.2.16 —— 凭据扫描只能有一个判定来源，而且它必须真的抓得住真凭据。
 *
 * 真实回归：v0.2.16 第二轮 CI 两个 Node 都挂在「确认没有把凭据提交进仓库」，
 * 命中来自 `test/v0215-source-zip-security.test.ts` 里一个假 Cookie。
 *
 * 原因不是假凭据写错了，是那一步用的是内联 `grep`，而仓库里另有一份
 * `scripts/audit-leaks.mjs`，两份规则对「什么算 fixture」的答案不一致。
 * 内联 grep 不认 `fixture-` 前缀，于是把测试夹具当真凭据。
 *
 * 同一件事有两套规则时，修好一套不代表另一套也对 —— 所以这里钉两件事：
 * 规则只有一份，而且那一份对本仓库是绿的、对真凭据形态是红的。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

const ROOT = join(import.meta.dirname, '..')
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

function runAudit(cwd) {
  try {
    const stdout = execFileSync(process.execPath, [join(cwd, 'scripts', 'audit-leaks.mjs')], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

test('工作流不得再内联 grep 凭据形态，扫描只走 audit-leaks.mjs', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  assert.match(
    ci,
    /run: node scripts\/audit-leaks\.mjs/,
    '凭据扫描步骤必须调用仓库自己的脚本，不能内联一套平行规则',
  )
  // 内联规则的典型痕迹：对 BDUSS/BAIDUID 的 shell 正则 + 命中即 exit 1。
  assert.doesNotMatch(
    ci,
    /grep\s+-rInE[^\n]*(BDUSS|BAIDUID)/,
    '工作流里不该再有第二套 Cookie 规则；两套规则不可能永远一致',
  )
})

test('扫描规则本身：真 Cookie 形态必须命中，fixture 必须放过', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'audit-leaks.mjs'), 'utf8')

  for (const label of ['BDUSS=', 'BAIDUID=', 'ST=', 'sk-']) {
    const line = source.split('\n').find((text) => text.includes(label) && text.includes('label:'))
    assert.ok(line !== undefined, `找不到 ${label} 的规则行`)
    assert.match(line, /\(\?!fixture-\)/, `${label} 规则缺少 (?!fixture-) 否定断言`)
  }
})

test('本仓库自身对 audit-leaks 是绿的', (t) => {
  // 必须先有 tgz 才能扫。CI 里测试步骤排在打包之前，所以这里没有包是正常的 ——
  // 真正的保证来自打包之后单独跑的那一步，不是这条测试假装通过。
  let tarballExists = false
  try {
    readFileSync(join(ROOT, `dsh-ai-debate-${PACKAGE_VERSION}.tgz`))
    tarballExists = true
  } catch {
    tarballExists = false
  }
  if (!tarballExists) {
    t.skip('尚未打包，跳过（CI 在打包之后单独跑 audit-leaks）')
    return
  }

  const result = runAudit(ROOT)
  assert.equal(result.code, 0, `仓库里有凭据形态的内容：\n${result.stdout}`)
  assert.match(result.stdout, /no credential material found/)
})

test('扫描器对真凭据必须失败，不能因为放过 fixture 就整体失灵', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))

  // 必须拷贝脚本：它从 `import.meta.dirname` 推导仓库根，cd 到哪里都不影响。
  cpSync(join(ROOT, 'scripts', 'audit-leaks.mjs'), join(temp, 'scripts', 'audit-leaks.mjs'))
  cpSync(join(ROOT, 'scripts', 'tar.mjs'), join(temp, 'scripts', 'tar.mjs'))

  const version = '0.0.0'
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ version }), 'utf8')
  // 合法的空归档：1024 个零字节是 tar 的「两个 EOF 块」，再 gzip 一层 —— 脚本要 gunzip。
  writeFileSync(join(temp, `dsh-ai-debate-${version}.tgz`), gzipSync(Buffer.alloc(1024)))

  // 拼出来而不是写整串：这段源码本身也要过扫描，写死等于把测试自己变成泄漏源。
  // （这个坑本轮踩了两次。）
  const cookie = ['BDUSS', 'AAAA'.repeat(4)].join('=')
  writeFileSync(join(temp, 'leak.ts'), `const cookie = "${cookie}"\n`, 'utf8')

  const result = runAudit(temp)
  assert.notEqual(result.code, 0, '真形态的 Cookie 必须让扫描失败')
  assert.match(result.stdout, /LEAK/)
})
