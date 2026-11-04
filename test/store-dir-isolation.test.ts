/**
 * Where the plugin puts its state, and why the v0.2.23 answer was wrong.
 *
 * v0.2.23 resolved `config.storeDir || join(homedir(), '.dsh', 'ai-debate')`. The
 * second half ignores `DSH_HOME`, so an "isolated" instance still wrote into the real
 * user's home. The acceptance run for v0.2.23 only stayed out of the production
 * directory because it passed an explicit `--patch` override — a workaround for one
 * run, not a fix.
 *
 * These tests pin the resolution order and the refusals. They never touch a real
 * `~/.dsh`: every case passes an explicit `home`, and every path parameter is a
 * temp directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  chooseStoreDir,
  dshHomeDir,
  hostDataDir,
  legacyStoreDir,
  resolveStoreDirStrict,
  assertStateWritable,
} from '../lib/store-dir.js'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-storedir-'))
}

test('显式 storeDir 优先级最高，压过 DSH_HOME', () => {
  const home = tempHome()
  const picked = chooseStoreDir({
    configured: join(home, 'explicit'),
    env: { DSH_HOME: join(home, 'instance') },
    home,
  })
  assert.equal(picked.source, 'configured')
  assert.equal(picked.dir, resolve(join(home, 'explicit')))
})

test('没有 storeDir 时使用 DSH_HOME，而不是操作系统 home', () => {
  const home = tempHome()
  const dshHome = join(home, 'isolated-instance')
  const picked = chooseStoreDir({ env: { DSH_HOME: dshHome }, home })

  assert.equal(picked.source, 'dsh_home', 'DSH_HOME 有效时必须用它')
  assert.ok(
    picked.dir.startsWith(resolve(dshHome)),
    `目录必须在 DSH_HOME 内，实际 ${picked.dir}`,
  )
  assert.notEqual(picked.dir, legacyStoreDir(home), '这正是 v0.2.23 的错误：落到了系统 home')
  assert.equal(picked.differsFromDefault, true)
})

test('DSH_HOME 缺失时回落到历史默认路径（旧安装保持可用）', () => {
  const home = tempHome()
  const picked = chooseStoreDir({ env: {}, home })
  assert.equal(picked.source, 'default')
  assert.equal(picked.dir, legacyStoreDir(home))
  assert.equal(picked.differsFromDefault, false)
})

test('DSH_HOME 为空串或相对路径时不算有效位置', () => {
  const home = tempHome()
  for (const value of ['', '   ', 'relative/dir', './x']) {
    assert.equal(
      dshHomeDir({ DSH_HOME: value }),
      undefined,
      `"${value}" 不是可用路径`,
    )
    const picked = chooseStoreDir({ env: { DSH_HOME: value }, home })
    assert.equal(picked.source, 'default', `"${value}" 必须回落到默认路径`)
  }
})

test('宿主若真的提供 dataDir 就用它，且优先于 DSH_HOME', () => {
  const home = tempHome()
  const hostDir = join(home, 'host-provided')
  const get = (name: string): unknown =>
    name === 'profilePaths' ? { dataDir: hostDir } : undefined

  const picked = chooseStoreDir({ get, env: { DSH_HOME: join(home, 'instance') }, home })
  assert.equal(picked.source, 'host')
  assert.equal(picked.dir, resolve(hostDir))
})

test('宿主没有该服务时不臆造目录', () => {
  const home = tempHome()
  // The real host exposes tools/systemPrompt/credentials, not a paths service. An
  // unknown service must fall through, never guess.
  const get = (name: string): unknown => (name === 'tools' ? {} : undefined)
  assert.equal(hostDataDir(get), undefined)

  const picked = chooseStoreDir({ get, home })
  assert.equal(picked.source, 'default')

  // A service that answers with a relative path is not usable either.
  const badGet = (name: string): unknown =>
    name === 'profilePaths' ? { dataDir: 'not/absolute' } : undefined
  assert.equal(hostDataDir(badGet), undefined)
})

test('宿主 get 抛错不影响解析', () => {
  const home = tempHome()
  const get = (): unknown => {
    throw new Error('service not ready')
  }
  const picked = chooseStoreDir({ get, home })
  assert.equal(picked.source, 'default')
})

test('切换到新目录但旧目录有状态 → 拒绝，不迁移不合并', () => {
  const home = tempHome()
  const legacy = legacyStoreDir(home)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'state.json'), '{"sessions":[]}')

  const dshHome = join(home, 'instance')
  assert.throws(
    () => resolveStoreDirStrict({ env: { DSH_HOME: dshHome }, home }),
    /不会自动迁移|不会跨目录读取/,
    '两份台账不能静默合并',
  )
})

test('首次在新环境启动、旧目录为空 → 正常创建', () => {
  const home = tempHome()
  const dshHome = join(home, 'instance')
  const picked = resolveStoreDirStrict({ env: { DSH_HOME: dshHome }, home })
  assert.equal(picked.source, 'dsh_home')
  assert.equal(existsSync(picked.dir), true)
  assert.equal(picked.probe.stateExists, false)
})

test('旧安装（无 DSH_HOME）仍读取原来的 state.json', () => {
  const home = tempHome()
  const legacy = legacyStoreDir(home)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'state.json'), '{"sessions":[]}')

  const picked = resolveStoreDirStrict({ env: {}, home })
  assert.equal(picked.source, 'default')
  assert.equal(picked.dir, legacy)
  assert.equal(picked.probe.stateExists, true, '旧文件必须被识别为已存在')
})

test('空的 state.json 被拒绝，不自动重建', () => {
  const home = tempHome()
  const dir = join(home, 'store')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), '')

  assert.throws(
    () => assertStateWritable(dir),
    /0 字节|不会自动重建/,
    '空文件必须报错，不能当成干净状态',
  )
})

test('没有 state.json 时允许写入', () => {
  const home = tempHome()
  const dir = join(home, 'fresh')
  mkdirSync(dir, { recursive: true })
  assert.doesNotThrow(() => assertStateWritable(dir))
})

test('路径解析在 Windows 与 POSIX 风格下都不出错', () => {
  const home = tempHome()

  // DSH_HOME 用正斜杠（Windows 上常见）也必须被识别为绝对路径。
  const winStyle = 'C:\\Users\\someone\\dsh-home'
  if (process.platform === 'win32') {
    assert.equal(dshHomeDir({ DSH_HOME: winStyle }), resolve(winStyle))
    assert.equal(dshHomeDir({ DSH_HOME: 'C:/Users/someone/dsh-home' }), resolve('C:/Users/someone/dsh-home'))
  } else {
    // On POSIX a Windows-style string is *not* absolute, and must be refused rather
    // than silently treated as a relative directory.
    assert.equal(dshHomeDir({ DSH_HOME: winStyle }), undefined)
    assert.equal(dshHomeDir({ DSH_HOME: '/srv/dsh-home' }), '/srv/dsh-home')
  }

  const picked = chooseStoreDir({ env: { DSH_HOME: home }, home })
  assert.ok(picked.dir.includes('ai-debate'), '目录名在所有平台上一致')
})

test('解析不产生副作用：chooseStoreDir 不创建目录', () => {
  const home = tempHome()
  const dshHome = join(home, 'never-created')
  chooseStoreDir({ env: { DSH_HOME: dshHome }, home })
  assert.equal(existsSync(dshHome), false, '纯函数不得创建目录')
  assert.deepEqual(readdirSync(home), [])
})
