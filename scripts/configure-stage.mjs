import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [stage, ownerName, baseUrl, model] = process.argv.slice(2)
if (!stage || !ownerName) {
  process.stderr.write('用法：node scripts/configure-stage.mjs <stage-dir> <owner> [baseUrl] [model]\n')
  process.exit(1)
}

const path = join(stage, 'package', 'cordis.patch.yml')
let text = readFileSync(path, 'utf8')

function setOrInsert(source, key, value, anchor) {
  const pattern = new RegExp(`^(\\s*)${key}: '.*'$`, 'm')
  if (pattern.test(source)) return source.replace(pattern, `$1${key}: '${value}'`)
  const anchorPattern = new RegExp(`^(\\s*)${anchor}: '.*'$`, 'm')
  const match = anchorPattern.exec(source)
  if (!match) throw new Error(`找不到锚点 ${anchor}`)
  return source.replace(anchorPattern, `${match[0]}\n${match[1]}${key}: '${value}'`)
}

text = setOrInsert(text, 'ownerUserName', ownerName, 'ownerUserId')
if (baseUrl) text = setOrInsert(text, 'llmBaseUrl', baseUrl, 'directness')
if (model) text = setOrInsert(text, 'llmModel', model, 'llmBaseUrl')
const apiKey = process.env.DSH_DEBATE_TEST_KEY
if (apiKey) text = setOrInsert(text, 'llmApiKey', apiKey, 'llmModel')

writeFileSync(path, text, 'utf8')
process.stdout.write(
  text
    .split('\n')
    .filter((line) => /owner|llm/.test(line))
    .map((line) => (line.includes('llmApiKey') ? `${line.slice(0, line.indexOf(':') + 2)} <set>` : line))
    .join('\n') + '\n',
)
