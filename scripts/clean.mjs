import { rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
for (const dir of ['lib']) {
  rmSync(join(root, dir), { recursive: true, force: true })
  console.log(`已清理 ${dir}/`)
}
