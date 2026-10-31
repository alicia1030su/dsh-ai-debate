/**
 * A minimal, dependency-free tar + gzip writer (ustar).
 *
 * Why hand-write this instead of shelling out to `npm pack` or `tar`: the DSH
 * runtime ships Node and pnpm but not npm, so a packaging step that assumes npm
 * cannot run where this plugin is actually built. The subset of the format
 * needed here is small and fully specified, and writing it keeps the dependency
 * count at zero.
 *
 * Supported: regular files, ustar name/prefix splitting for long paths, octal
 * size and mtime. Not supported (and not needed): links, devices, PAX headers,
 * multi-volume archives.
 */

import { gzipSync } from 'node:zlib'

/**
 * Pad a number into an octal field of `width` bytes, terminated by NUL.
 * @param {number} value the number to encode
 * @param {number} width the field width in bytes
 * @returns {Buffer} the encoded field
 */
function octal(value, width) {
  const text = value.toString(8).padStart(width - 1, '0')
  return Buffer.from(`${text}\u0000`, 'ascii')
}

/**
 * Write a UTF-8 string into a fixed-width field, NUL padded.
 * @param {string} text the string
 * @param {number} width the field width in bytes
 * @returns {Buffer} the encoded field
 */
function field(text, width) {
  const buffer = Buffer.alloc(width, 0)
  buffer.write(text, 0, Math.min(Buffer.byteLength(text), width - 1), 'utf8')
  return buffer
}

/**
 * Split a path into the ustar `name` (100 bytes) and `prefix` (155 bytes) fields.
 * @param {string} path the archive path
 * @returns {{ name: string, prefix: string }} the split path
 */
function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  const parts = path.split('/')
  let name = parts.pop() ?? path
  let prefix = parts.join('/')
  while (Buffer.byteLength(`${prefix}/${name}`) > 255 && parts.length > 1) {
    name = `${parts.pop()}/${name}`
    prefix = parts.join('/')
  }
  return { name, prefix }
}

/**
 * Build one 512-byte ustar header for a regular file.
 * @param {{ path: string, data: Buffer, mode?: number }} entry the file entry
 * @param {number} mtimeMs modification time in milliseconds
 * @returns {Buffer} the header block
 */
function header(entry, mtimeMs) {
  const { name, prefix } = splitPath(entry.path)
  const block = Buffer.alloc(512, 0)

  field(name, 100).copy(block, 0)
  octal(entry.mode ?? 0o644, 8).copy(block, 100)
  octal(0, 8).copy(block, 108) // uid
  octal(0, 8).copy(block, 116) // gid
  octal(entry.data.length, 12).copy(block, 124)
  octal(Math.floor(mtimeMs / 1000), 12).copy(block, 136)
  block.fill(0x20, 148, 156) // checksum field starts as spaces
  block.write('0', 156, 'ascii') // typeflag: regular file
  field('ustar', 6).copy(block, 257)
  block.write('00', 263, 'ascii') // ustar version
  field(prefix, 155).copy(block, 345)

  // The checksum covers the header with the checksum field as ASCII spaces.
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148, 'ascii')
  return block
}

/**
 * Build an uncompressed tar archive.
 * @param {Array<{ path: string, data: Buffer, mode?: number }>} entries files in archive order
 * @param {number} [mtimeMs] modification time recorded for every entry
 * @returns {Buffer} the tar bytes
 */
export function createTar(entries, mtimeMs = Date.now()) {
  /** @type {Buffer[]} */
  const chunks = []
  for (const entry of entries) {
    chunks.push(header(entry, mtimeMs))
    chunks.push(entry.data)
    const remainder = entry.data.length % 512
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder, 0))
  }
  // A tar archive terminates with two zero blocks.
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

/**
 * Build a gzipped tar archive, which is what `.tgz` denotes.
 *
 * The gzip mtime is pinned to zero so identical input produces identical bytes
 * on every machine, which is what makes a published checksum meaningful.
 *
 * Pinning the mtime is not enough on its own. zlib fills the header's OS byte with the
 * platform it was compiled for: `0x03` on Linux, `0x0a` on Windows, `0x13` on macOS. The
 * .tgz published by CI (Linux) therefore carried a byte a Windows build could never
 * reproduce, and the checksum printed in the release notes was not verifiable on the
 * machine the project is actually developed on. Byte 9 is overwritten with `255`
 * ("unknown") so the platform stops leaking into the artifact; nothing else in the header
 * moves, and the header is not covered by the CRC, so compression and integrity are
 * untouched.
 * @param {Array<{ path: string, data: Buffer, mode?: number }>} entries files in archive order
 * @returns {Buffer} the .tgz bytes
 */
export function createTgz(entries) {
  const gz = gzipSync(createTar(entries, 0), { level: 9, mtime: 0 })
  if (gz.length < 10 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08 || gz[3] !== 0x00) {
    throw new Error('gzip 头不是预期的 10 字节无扩展格式，无法固定 OS 字节')
  }
  gz[9] = 255
  return gz
}

/**
 * List the entries of an uncompressed tar archive.
 *
 * Used to verify the produced package by reading it back rather than trusting
 * the writer.
 * @param {Buffer} tar the tar bytes
 * @returns {Array<{ path: string, size: number }>} entries in archive order
 */
export function listTar(tar) {
  /** @type {Array<{ path: string, size: number }>} */
  const out = []
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const name = block.subarray(0, 100).toString('utf8').replace(/\u0000.*$/s, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\u0000.*$/s, '')
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').replace(/\u0000.*$/s, ''), 8)
    out.push({ path: prefix ? `${prefix}/${name}` : name, size: Number.isFinite(size) ? size : 0 })
    offset += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512
  }
  return out
}
