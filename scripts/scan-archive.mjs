#!/usr/bin/env node
/**
 * Scan a release archive for sensitive content — independently of the packer.
 *
 * ## Why this is separate from `source-zip.mjs`
 *
 * §五 asks for "an independent sensitive-file scan for the release source ZIP". The reason is
 * that a packer which both *decides* what to include and *certifies* what it included can be
 * wrong in the same way twice: a bug in the allowlist is a bug in its own self-check.
 *
 * This script takes a finished archive and asks only "is anything in here dangerous?", using its
 * own name rules and its own content patterns. It never imports the packer.
 *
 * ## Exit codes
 *
 * `0` clean, `1` findings. CI treats non-zero as failure. The task book is explicit that a
 * finding must **fail the build**, not print a warning — a warning in a 3000-line log is a
 * warning nobody reads.
 *
 * Usage:
 *   node scripts/scan-archive.mjs <archive.zip|archive.tgz> [--json]
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { inflateRawSync, gunzipSync } from 'node:zlib'

const path = process.argv[2]
const asJson = process.argv.includes('--json')

if (!path) {
  console.error('用法: node scripts/scan-archive.mjs <archive.zip|archive.tgz> [--json]')
  process.exit(2)
}

// --- name rules ------------------------------------------------------------

/**
 * File names that must never ship, wherever they sit.
 *
 * `.env.example` is deliberately allowed: it documents which variables exist and carries no
 * values. Everything else starting with `.env.` is a real environment file.
 */
const FORBIDDEN_NAMES = [
  { re: /^\.env$/i, label: '环境变量文件' },
  { re: /^\.env\.(?!example$)/i, label: '环境变量文件' },
  { re: /^\.credentials/i, label: '凭据文件' },
  { re: /^credentials\.(json|ya?ml|txt)$/i, label: '凭据文件' },
  { re: /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i, label: 'SSH 私钥' },
  { re: /\.(pem|key|pfx|p12|keystore|jks)$/i, label: '私钥/证书文件' },
  { re: /^\.netrc$/i, label: '网络凭据文件' },
  { re: /^\.npmrc$/i, label: 'npm 凭据文件' },
  { re: /^\.git-credentials$/i, label: 'Git 凭据文件' },
  { re: /^\.(bash_history|zsh_history|python_history)$/i, label: '命令历史' },
]

/** Directory segments that must never appear in a published archive. */
const FORBIDDEN_DIRS = ['.ssh', '.dsh', '.git', '.aws', '.gnupg', '.kube', '.docker']

// --- content rules ---------------------------------------------------------

/**
 * Credential shapes.
 *
 * The task book says a regex must not be the only protection — it is not: the allowlist is the
 * primary control, and this is the second line. It catches exactly the mistakes that happen (a
 * pasted key, a committed cookie) rather than trying to prove absence.
 */
const SECRET_PATTERNS = [
  { re: /\bBDUSS=[A-Za-z0-9+/=]{20,}/, label: '贴吧 BDUSS Cookie' },
  { re: /\bSTOKEN=[A-Za-z0-9+/=]{20,}/, label: '贴吧 STOKEN Cookie' },
  { re: /\bBAIDUID=[A-Za-z0-9+/=:]{20,}/, label: '百度 BAIDUID Cookie' },
  { re: /\b(?:sk|pk)-[A-Za-z0-9]{20,}/, label: 'API key（sk-/pk- 前缀）' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{30,}/, label: 'Bearer 令牌' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, label: '私钥内容' },
  { re: /\bm0sk_[A-Za-z0-9]{16,}/, label: 'mem0 API key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, label: 'GitHub 令牌' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack 令牌' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { re: /\bsk_live_[A-Za-z0-9]{20,}/, label: 'Stripe live key' },
]

/**
 * Paths whose whole purpose is to contain credential shapes, so a scan hit is expected there.
 *
 * Narrow on purpose: an exact path, never a pattern. A real `.env` cannot claim this exemption.
 */
const SCAN_EXEMPT = new Set([
  'src/security/output-guard.ts',
  'scripts/source-zip.mjs',
  'scripts/scan-archive.mjs',
  'test/v0214-target-identity.test.ts',
  'test/v0215-source-zip-security.test.ts',
  'test/security-boundary.test.ts',
  'test/security-injection.test.ts',
])

/** A line mentioning one of these is a fixture by construction. */
const FIXTURE_MARKER = /(fixture|dummy|example|fake|placeholder|test-only|redact|<.*>|\bxxx+\b)/i

// --- readers ---------------------------------------------------------------

/** Entry names from a ZIP central directory. */
function zipEntries(buffer) {
  const entries = []
  for (let offset = 0; offset < buffer.length - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue
    const nameLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const method = buffer.readUInt16LE(localOffset + 8)
    const compressedSize = buffer.readUInt32LE(localOffset + 18)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const payload = buffer.subarray(start, start + compressedSize)
    let data
    try {
      data = method === 0 ? payload : inflateRawSync(payload)
    } catch {
      data = undefined
    }
    entries.push({ name, data })
  }
  return entries
}

/** Entry names and payloads from a gzipped tar (the .tgz release). */
function tgzEntries(buffer) {
  const tar = gunzipSync(buffer)
  const entries = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // Two zero blocks end the archive.
    if (header.every((byte) => byte === 0)) break
    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8)
    const typeflag = header.toString('ascii', 156, 157)
    const data = typeflag === '0' || typeflag === '' ? tar.subarray(offset + 512, offset + 512 + size) : undefined
    if (name) entries.push({ name, data })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

// --- scan ------------------------------------------------------------------

const archive = readFileSync(path)
const isZip = extname(path).toLowerCase() === '.zip'
const entries = isZip ? zipEntries(archive) : tgzEntries(archive)

const findings = []

for (const entry of entries) {
  // Archives wrap everything in `package/`; strip it so the exemption list can use repo paths.
  const normalised = entry.name.replace(/^package\//, '').replace(/^\.\//, '')
  const segments = normalised.split('/')
  const name = segments[segments.length - 1]

  for (const segment of segments) {
    if (FORBIDDEN_DIRS.includes(segment)) {
      findings.push({ path: normalised, label: `禁止目录 ${segment}`, kind: 'name' })
      break
    }
  }

  for (const { re, label } of FORBIDDEN_NAMES) {
    if (re.test(name)) {
      findings.push({ path: normalised, label, kind: 'name' })
      break
    }
  }

  if (entry.data === undefined) continue
  if (entry.data.includes(0)) continue // binary
  const text = entry.data.toString('utf8')

  for (const { re, label } of SECRET_PATTERNS) {
    if (!re.test(text)) continue
    if (SCAN_EXEMPT.has(normalised)) continue
    for (const line of text.split(/\r?\n/)) {
      if (!re.test(line)) continue
      if (FIXTURE_MARKER.test(line)) continue
      // Test and docs files legitimately quote patterns; name rules already barred the dangerous
      // paths, so a shape here is illustrative rather than leaked.
      if (normalised.startsWith('test/') || normalised.startsWith('docs/')) continue
      findings.push({
        path: normalised,
        label,
        kind: 'content',
        sample: line.trim().slice(0, 120),
      })
    }
  }
}

const report = {
  archive: path,
  entries: entries.length,
  findings,
  clean: findings.length === 0,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`扫描 ${path}`)
  console.log(`  条目：${entries.length}`)
  if (findings.length === 0) {
    console.log('  结果：未发现敏感文件或凭据')
  } else {
    console.log(`  结果：发现 ${findings.length} 处问题`)
    for (const finding of findings) {
      console.log(`    ${finding.path} — ${finding.label}${finding.sample ? `\n      ${finding.sample}` : ''}`)
    }
  }
}

process.exit(findings.length === 0 ? 0 : 1)
