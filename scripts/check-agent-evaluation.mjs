import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../e2e/fixtures/agent-evaluation/v1/', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
const ids = new Set()
for (const [family, count] of Object.entries(manifest.families)) {
  const cases = JSON.parse(await readFile(path.join(root, `${family}.json`), 'utf8'))
  if (cases.length !== count) throw new Error(`Unexpected case count: ${family}`)
  for (const entry of cases) {
    if (!entry.id.startsWith(`${family}-`) || ids.has(entry.id)) throw new Error(`Invalid or duplicate case: ${entry.id}`)
    if (!entry.prompt || !entry.acceptance?.length || !['development', 'held-out'].includes(entry.split)) {
      throw new Error(`Incomplete evaluation case: ${entry.id}`)
    }
    ids.add(entry.id)
  }
}
for (const source of manifest.source_files) {
  if (path.isAbsolute(source) || source.split('/').includes('..')) throw new Error('Non-portable source locator')
  await readFile(path.join(root, 'sources', source))
}
console.log(`Evaluation corpus valid: ${ids.size} tasks, ${manifest.source_files.length} sources. No model evaluation was run.`)
