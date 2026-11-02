/**
 * Copy a package and its transitive dependencies into a flat `node_modules`
 * layout, so a packed plugin can be mounted in an isolated directory.
 *
 * ## Why resolution is not "scan the pnpm store" any more (v0.2.22)
 *
 * This used to resolve every dependency by scanning `node_modules/.pnpm/` for a
 * directory named `<scope>+<name>@<version>`. That is pnpm's *isolated* layout,
 * and it is only one of the two layouts pnpm produces:
 *
 * - **isolated** (the default): transitive dependencies live inside
 *   `node_modules/.pnpm/<pkg>@<version>/node_modules/<dep>`, and `.pnpm/` is full
 *   of package directories.
 * - **hoisted** (`nodeLinker: hoisted`): everything is flattened into the
 *   project's own `node_modules/`, and `.pnpm/` contains *no* package directories
 *   at all — on the machine this was found on, it held a single `lock.yaml`.
 *
 * Under hoisted the old scan found nothing, so `verify-install.mjs` failed with
 * 「无法在 pnpm 存储里找到 @deepseek-ai/schemastery 的依赖 @standard-schema/spec」
 * even though that package was present and importable. The verification was
 * reporting a layout difference as a packaging defect.
 *
 * The fix is to resolve the way **Node itself** resolves — walk up from the
 * package's own directory looking for `node_modules/<name>` — and keep the store
 * scan as a secondary path. Node's algorithm works for both layouts because in
 * the isolated layout the dependent packages really are reachable from the
 * package's ancestor chain; pnpm only *moves* them, it does not break resolution.
 *
 * This is strictly more capable than the old code: it never accepts less, and the
 * failure message now names both places that were tried.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
    .filter((abs) => {
      try {
        return statSync(abs).isDirectory()
      } catch {
        return false
      }
    })
}

/**
 * Find one package inside the pnpm store (the isolated layout).
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
 * Find one package by walking up from `fromDir`, the way Node resolves.
 *
 * Node's rule, reproduced: for each ancestor directory, append `node_modules`
 * unless the directory is already called `node_modules`. That single rule covers
 * both pnpm layouts, because pnpm only relocates packages — it never makes them
 * unreachable from the importer's ancestor chain.
 *
 * @param {string} fromDir directory of the package that declares the dependency
 * @param {string} name the package name
 * @returns {string | undefined} the package directory
 */
function findByNodeResolution(fromDir, name) {
  let dir = fromDir
  for (;;) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', ...name.split('/'))
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve one dependency from two independent sources.
 *
 * Node-style resolution first (correct for both layouts), then the pnpm store
 * (kept because it is the only path that can reach a package whose ancestor chain
 * has been symlinked away, e.g. when `from` itself came out of the store).
 *
 * @param {object} options
 * @param {string} options.name dependency name
 * @param {string} options.fromDir directory of the declaring package
 * @param {string} options.storeDir the `.pnpm` directory
 * @returns {string | undefined}
 */
function resolveDependency({ name, fromDir, storeDir }) {
  return findByNodeResolution(fromDir, name) ?? findInStore(storeDir, name)
}

/**
 * Copy a package tree into `targetDir`, following its declared dependencies.
 *
 * @param {object} options
 * @param {string} options.name package name to start from
 * @param {string} options.from directory the package currently lives in
 * @param {string} options.storeDir the pnpm `.pnpm` directory used as a fallback lookup
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
    const childSource = resolveDependency({ name: child, fromDir: from, storeDir })
    if (!childSource) {
      // A missing required dependency means the copied tree cannot load; say so
      // rather than producing a package that fails later with a vaguer error.
      // The message names both lookups so a layout problem is not mistaken for a
      // missing dependency.
      throw new Error(
        `找不到 ${name} 的依赖 ${child}：` +
          `已从 ${from} 向上按 Node 规则查找，也在 pnpm 存储 ${storeDir} 里查过`,
      )
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
