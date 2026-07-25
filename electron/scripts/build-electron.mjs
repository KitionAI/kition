import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { discoverSiblingRuntimeBinary } from '../local-runtime.mjs'
import { buildSidecar } from './build-sidecar.mjs'
import { portalBaseURLForBuildIdentity, resolveBuildIdentity } from './build-identity.mjs'
import {
  normalizeElectronBuilderArgs,
  resolveLocalPackageBin,
} from './electron-builder-args.mjs'
import { validateDesktopRenderer } from './validate-desktop-renderer.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(moduleDir, '..', '..')
const sidecarDir = path.join(appDir, 'electron', 'resources', 'bin')
const buildInfoPath = path.join(appDir, 'electron', 'build-info.json')
const entitlementsPath = path.join(appDir, 'build', 'entitlements.mac.plist')
const viteConfigPath = path.join(appDir, 'tooling', 'vite.config.ts')
const isCI = String(process.env.CI || '').toLowerCase() === 'true'
const buildIdentity = resolveBuildIdentity()

if (buildIdentity !== 'dev' && !isCI) {
  throw new Error('[build-electron] official rc and stable builds can only run in CI')
}

function writeBuildInfo(runtime) {
  const portalBaseURL = portalBaseURLForBuildIdentity(buildIdentity)
  const payload = {
    buildIdentity,
    portalBaseURL,
    builtAt: new Date().toISOString(),
    runtimeVersion: runtime.runtimeVersion,
    runtimeProtocolVersion: runtime.protocolVersion,
    runtimeSha256: runtime.sha256,
    runtimeSource: runtime.source,
  }
  fs.writeFileSync(buildInfoPath, JSON.stringify(payload, null, 2) + '\n')
  console.log(`[build-electron] identity=${buildIdentity} portalBaseURL=${portalBaseURL}`)
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    })
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

function resolveSigningEnv() {
  if (process.platform !== 'darwin') {
    return { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  }
  if (process.env.CSC_LINK) {
    if (!process.env.CSC_KEY_PASSWORD) {
      throw new Error('[build-electron] CSC_KEY_PASSWORD is required when CSC_LINK is set')
    }
    console.log('[build-electron] macOS signing enabled from CSC_LINK')
    return {}
  }
  if (buildIdentity !== 'dev' && isCI) {
    throw new Error('[build-electron] official builds require CSC_LINK and CSC_KEY_PASSWORD')
  }
  console.warn('[build-electron] CSC_LINK not set — building unsigned')
  return { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
}

function resolveElectronBuilderArgs() {
  const args = normalizeElectronBuilderArgs(process.argv.slice(2))
  if (process.platform !== 'darwin') {
    return args
  }
  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`[build-electron] missing macOS entitlements at ${entitlementsPath}`)
  }

  console.log(`[build-electron] macOS entitlements=${entitlementsPath}`)
  return [
    `--config.mac.entitlements=${entitlementsPath}`,
    `--config.mac.entitlementsInherit=${entitlementsPath}`,
    ...args,
  ]
}

await run(process.execPath, [
  resolveLocalPackageBin('vite', 'vite'),
  'build',
  '--config',
  viteConfigPath,
], {
  cwd: appDir,
  env: {
    ...process.env,
    KITION_DESKTOP_BUILD: 'true',
  },
})
await validateDesktopRenderer({ rootDir: appDir })

let runtime = null
try {
  if (String(process.env.CI || '').toLowerCase() !== 'true') {
    const siblingBinary = await discoverSiblingRuntimeBinary({ clientRoot: appDir })
    if (siblingBinary) {
      process.env.KITION_API_BINARY = siblingBinary
      console.log(`[build-electron] using sibling runtime ${siblingBinary}`)
    }
  }
  runtime = await buildSidecar(sidecarDir)
  writeBuildInfo(runtime)
  await run(process.execPath, [
    resolveLocalPackageBin('electron-builder', 'electron-builder'),
    ...resolveElectronBuilderArgs(),
  ], {
    cwd: appDir,
    env: {
      ...process.env,
      ...resolveSigningEnv(),
    },
  })
} finally {
  await fs.promises.rm(sidecarDir, { recursive: true, force: true })
}
