import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const requireFromHere = createRequire(import.meta.url)

export function normalizeElectronBuilderArgs(args) {
  return args[0] === '--' ? args.slice(1) : [...args]
}

export function resolveLocalPackageBin(packageName, commandName = packageName) {
  const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`)
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const relativeBin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.[commandName]

  if (typeof relativeBin !== 'string' || !relativeBin.trim()) {
    throw new Error(`[build-electron] ${packageName} does not expose the ${commandName} command`)
  }

  const binPath = path.resolve(path.dirname(packageJsonPath), relativeBin)
  if (!fs.existsSync(binPath)) {
    throw new Error(`[build-electron] ${commandName} command does not exist at ${binPath}`)
  }
  return binPath
}
