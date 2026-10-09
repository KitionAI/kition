/**
 * Collects the per-platform build artifacts into one folder, checks that the
 * release is complete, and writes the updater manifest next to them.
 *
 * Usage: node src-tauri/scripts/stage-release-assets.mjs --artifacts <downloaded>
 *   --out <folder> --version <x.y.z> --tag <vX.Y.Z> --repository <owner/repo>
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { buildUpdaterManifest, expectedReleaseAssets } from './release-artifacts.mjs'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || '')
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
    values[key.slice(2)] = String(argv[index + 1] ?? '')
  }
  return values
}

async function walk(root) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const fullPath = path.join(root, entry.name)
    return entry.isDirectory() ? walk(fullPath) : [fullPath]
  }))
  return files.flat()
}

export async function stageReleaseAssets({ artifacts, out, version, tag, repository }) {
  await fs.mkdir(out, { recursive: true })
  const seen = new Set()
  for (const file of await walk(artifacts)) {
    const name = path.basename(file)
    if (seen.has(name)) throw new Error(`duplicate release asset: ${name}`)
    seen.add(name)
    await fs.copyFile(file, path.join(out, name))
  }
  const missing = expectedReleaseAssets(version).filter((name) => !seen.has(name))
  if (missing.length) throw new Error(`missing release assets: ${missing.join(', ')}`)
  const manifest = await buildUpdaterManifest({ artifactDir: out, version, tag, repository })
  await fs.writeFile(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return [...seen, 'latest.json'].sort()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    for (const required of ['artifacts', 'out', 'version', 'tag', 'repository']) {
      if (!args[required]) throw new Error(`missing --${required}`)
    }
    const staged = await stageReleaseAssets(args)
    for (const name of staged) console.log(`[stage-release-assets] ${name}`)
  } catch (error) {
    console.error(`[stage-release-assets] ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
