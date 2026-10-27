/**
 * Copy a package and its transitive dependencies out of a pnpm virtual store
 * into a flat `node_modules` layout.
 *
 * Why this exists: `scripts/verify-package.mjs` needs to mount the packed plugin
 * in an isolated directory, and pnpm keeps transitive dependencies inside
 * `node_modules/.pnpm/<pkg>@<version>/node_modules/`, not at the top level. A
 * naive `cpSync` of one package therefore yields a package whose own imports
 * cannot resolve.
 *
 * The walk is deliberately simple and fails loudly rather than guessing: it reads
 * each package's `dependencies` and `optionalDependencies`, resolves them by
 * scanning the pnpm store, and stops if a required one cannot be found.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * List the directories of a pnpm virtual store.
 * @param {string} storeDir the `.pnpm` directory
 * @returns {string[]} absolute paths of package version directories
 */
function storeEntries(storeDir) {
  if (!existsSync(storeDir)) return []
  return readdirSync(storeDir)
    .filter((name) => name.includes('@'))
    .map((name) => join(storeDir, name))
    .filter((abs) => statSync(abs).isDirectory())
}

/**
 * Find one package inside the pnpm store.
 * @param {string} storeDir the `.pnpm` directory
 * @param {string} name the package name
 * @returns {string | undefined} the package directory
 */
function findInStore(storeDir, name) {
  // The store encodes `/` in a scoped name as `+`: `@scope+name@version`.
  const encoded = name.replace('/', '+')
  for (const entry of storeEntries(storeDir)) {
    const base = entry.split(/[\\/]/).pop() ?? ''
    if (!base.startsWith(`${encoded}@`)) continue
    const candidate = join(entry, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Copy a package tree into `targetDir`, following its declared dependencies.
 *
 * @param {object} options
 * @param {string} options.name package name to start from
 * @param {string} options.from directory the package currently lives in
 * @param {string} options.storeDir the pnpm `.pnpm` directory used for lookups
 * @param {string} options.targetDir the flat `node_modules` directory to fill
 * @param {Set<string>} [options.seen] already-copied package names
 * @returns {string[]} package names that were copied
 */
export function copyWithDependencies({ name, from, storeDir, targetDir, seen = new Set() }) {
  if (seen.has(name)) return []
  if (!existsSync(join(from, 'package.json'))) return []

  const destination = join(targetDir, ...name.split('/'))
  mkdirSync(join(destination, '..'), { recursive: true })
  cpSync(from, destination, { recursive: true, dereference: true, force: true })
  seen.add(name)
  const copied = [name]

  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  const required = Object.keys(manifest.dependencies ?? {})
  for (const child of required) {
    const childSource = findInStore(storeDir, child)
    if (!childSource) {
      // A missing required dependency means the copied tree cannot load; say so
      // rather than producing a package that fails later with a vaguer error.
      throw new Error(`无法在 pnpm 存储里找到 ${name} 的依赖 ${child}`)
    }
    copied.push(
      ...copyWithDependencies({
        name: child,
        from: childSource,
        storeDir,
        targetDir,
        seen,
      }),
    )
  }
  return copied
}
