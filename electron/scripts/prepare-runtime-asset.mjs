import path from 'node:path'
import process from 'node:process'
import { prepareRuntimeArchive } from '../runtime-manager.mjs'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const key = argument.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    values[key] = value
    index += 1
  }
  return values
}

try {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['manifest', 'archive', 'output', 'target']) {
    if (!args[required]) throw new Error(`Missing required --${required}`)
  }
  const prepared = await prepareRuntimeArchive({
    manifestPath: path.resolve(args.manifest),
    archivePath: path.resolve(args.archive),
    outputDir: path.resolve(args.output),
    target: args.target,
    platform: args.platform || process.platform,
    lockPath: args.lock ? path.resolve(args.lock) : undefined,
  })
  console.log(JSON.stringify(prepared))
} catch (error) {
  const code = error?.code ? ` (${error.code})` : ''
  console.error(`[prepare-runtime-asset]${code} ${error?.message ?? error}`)
  process.exitCode = 1
}
