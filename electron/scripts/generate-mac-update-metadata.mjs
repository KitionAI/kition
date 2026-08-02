import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    return entry.isDirectory() ? walk(fullPath) : [fullPath]
  })
}

function describe(file) {
  const contents = fs.readFileSync(file)
  return {
    url: path.basename(file),
    sha512: createHash('sha512').update(contents).digest('base64'),
    size: contents.byteLength,
  }
}

export function buildMacUpdateMetadata({ files, version, releaseDate = new Date().toISOString() }) {
  const zipFiles = files.filter((file) => file.endsWith('.zip'))
  const arm64Zip = zipFiles.find((file) => path.basename(file).includes('-macos-arm64.zip'))
  const x64Zip = zipFiles.find((file) => path.basename(file).includes('-macos-x64.zip'))
  if (zipFiles.length !== 2 || !arm64Zip || !x64Zip) {
    throw new Error(`Expected one arm64 and one x64 macOS ZIP, found ${zipFiles.length}`)
  }

  const primary = describe(x64Zip)
  return {
    version,
    files: [arm64Zip, x64Zip].map(describe),
    path: primary.url,
    sha512: primary.sha512,
    releaseDate,
  }
}

export function writeMacUpdateMetadata({ root, version, releaseDate }) {
  const files = walk(root)
  const metadata = buildMacUpdateMetadata({ files, version, releaseDate })
  for (const file of files.filter((file) => path.basename(file) === 'latest-mac.yml')) {
    fs.rmSync(file)
  }
  const outputPath = path.join(root, 'latest-mac.yml')
  fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return { metadata, outputPath }
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1])
  }
  const root = String(values.get('--root') || '').trim()
  const version = String(values.get('--version') || '').trim()
  if (!root || !version) {
    throw new Error('Usage: generate-mac-update-metadata.mjs --root <artifact-dir> --version <version>')
  }
  return { root, version }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const result = writeMacUpdateMetadata(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
