import process from 'node:process'
import { resolveRuntimeBinary } from '../runtime-manager.mjs'

try {
  const runtime = await resolveRuntimeBinary()
  process.stdout.write(runtime.binaryPath)
} catch (error) {
  const code = error?.code ? ` (${error.code})` : ''
  console.error(`[resolve-runtime-path]${code} ${error?.message ?? error}`)
  process.exitCode = 1
}
