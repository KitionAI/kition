/**
 * Packages the desktop app: builds the renderer, runs the Tauri bundler
 * (which compiles the shell and the runtime into one executable), and copies
 * the installers to `dist-desktop/` under their release names.
 *
 * Usage: node src-tauri/scripts/build.mjs [--target <rust-triple>] [--bundles <list>]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { portalBaseURLForBuildIdentity, resolveBuildIdentity } from './build-identity.mjs'
import { collectArtifacts, describeTarget } from './release-artifacts.mjs'
import { validateDesktopRenderer } from './validate-desktop-renderer.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(moduleDir, '..', '..')
const configDir = path.join(appDir, 'target', 'desktop-build')
const outputDir = path.join(appDir, 'dist-desktop')
const isCI = String(process.env.CI || '').toLowerCase() === 'true'
const buildIdentity = resolveBuildIdentity()

if (buildIdentity !== 'dev' && !isCI) {
  throw new Error('[build] official rc and stable builds can only run in CI')
}

function parseArgs(argv) {
  const options = { target: '', bundles: '', passthrough: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--target' || argument === '--bundles') {
      options[argument.slice(2)] = String(argv[index + 1] || '')
      index += 1
    } else {
      options.passthrough.push(argument)
    }
  }
  return options
}

function hostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  const host = output.split('\n').find((line) => line.startsWith('host: '))
  if (!host) throw new Error('[build] unable to determine the Rust host target')
  return host.slice('host: '.length).trim()
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

function requireOfficialSecrets() {
  if (buildIdentity === 'dev') return
  const missing = []
  if (!process.env.KITION_UPDATER_PUBKEY) missing.push('KITION_UPDATER_PUBKEY')
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) missing.push('TAURI_SIGNING_PRIVATE_KEY')
  if (process.platform === 'darwin' && !process.env.APPLE_CERTIFICATE && !process.env.APPLE_SIGNING_IDENTITY) {
    missing.push('APPLE_CERTIFICATE')
  }
  if (missing.length) throw new Error(`[build] official builds require ${missing.join(', ')}`)
}

const options = parseArgs(process.argv.slice(2))
const triple = options.target || hostTriple()
describeTarget(triple)
requireOfficialSecrets()

await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vite', 'build', '--config', 'tooling/vite.config.ts'], { cwd: appDir })
await validateDesktopRenderer({ rootDir: appDir })

const portalBaseURL = portalBaseURLForBuildIdentity(buildIdentity)
console.log(`[build] identity=${buildIdentity} portalBaseURL=${portalBaseURL} target=${triple}`)

const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY)
fs.mkdirSync(configDir, { recursive: true })
const configOverride = path.join(configDir, 'build.conf.json')
const updaterPubkey = (process.env.KITION_UPDATER_PUBKEY || '').trim()
const override = { bundle: { createUpdaterArtifacts: signed } }
// The bundler verifies the update signatures it writes against this key.
if (updaterPubkey) override.plugins = { updater: { pubkey: updaterPubkey } }
fs.writeFileSync(configOverride, JSON.stringify(override))
const tauriArgs = ['exec', 'tauri', 'build', '--config', configOverride, '--target', triple]
if (options.bundles) tauriArgs.push('--bundles', options.bundles)
tauriArgs.push(...options.passthrough)
await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', tauriArgs, {
  cwd: appDir,
  env: {
    ...process.env,
    KITION_BUILD_IDENTITY: buildIdentity,
    KITION_BUILD_PORTAL_BASE_URL: portalBaseURL,
  },
})

const version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version
const copied = await collectArtifacts({
  bundleDir: path.join(appDir, 'target', triple, 'release', 'bundle'),
  outputDir,
  version,
  triple,
  signed,
})
for (const name of copied) console.log(`[build] ${path.join('dist-desktop', name)}`)
