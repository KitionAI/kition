import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { discoverSiblingRuntimeBinary, runtimeResolutionHelp } from '../local-runtime.mjs'
import { resolveRuntimeBinary } from '../runtime-manager.mjs'
import {
  RUNTIME_LABEL_ENV,
  runtimeLabelForResolutionSource,
} from '../runtime-label.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(moduleDir, '..', '..')
const devElectronScript = path.join(moduleDir, 'dev-electron.mjs')

try {
  const siblingBinary = await discoverSiblingRuntimeBinary({ clientRoot })
  const runtimeEnv = siblingBinary
    ? { ...process.env, KITION_API_BINARY: siblingBinary }
    : process.env
  if (siblingBinary) {
    console.log(`[dev-runtime] using sibling runtime ${siblingBinary}`)
  }
  const runtime = await resolveRuntimeBinary({ env: runtimeEnv })
  console.log(`[dev-runtime] source=${runtime.source} version=${runtime.runtimeVersion || 'explicit'} target=${runtime.target}`)

  const child = spawn(process.execPath, [devElectronScript], {
    stdio: 'inherit',
    shell: false,
    env: {
      ...runtimeEnv,
      KITION_API_BINARY: runtime.binaryPath,
      KITION_RUNTIME_SHA256: runtime.sha256,
      [RUNTIME_LABEL_ENV]: runtimeLabelForResolutionSource(runtime.source),
    },
  })

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.once('SIGINT', () => forwardSignal('SIGINT'))
  process.once('SIGTERM', () => forwardSignal('SIGTERM'))
  child.once('error', (error) => {
    console.error(`[dev-runtime] ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = code ?? 0
  })
} catch (error) {
  const code = error?.code ? ` (${error.code})` : ''
  console.error(`[dev-runtime]${code} ${error?.message ?? error}`)
  if (error?.code === 'runtime_download_failed' || error?.code === 'runtime_missing') {
    for (const line of runtimeResolutionHelp(clientRoot)) {
      console.error(`[dev-runtime] ${line}`)
    }
  }
  process.exitCode = 1
}
