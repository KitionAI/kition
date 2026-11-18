import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)
const appDir = path.resolve(path.dirname(modulePath), '..', '..')
const configRelativePath = path.join('src-tauri', 'tauri.conf.json')

const expectedIdentity = {
  productName: 'Kition',
  identifier: 'com.kition.desktop',
  version: '../package.json',
}

/** Checks the desktop bundle configuration and the files it points at. */
export async function validateDesktopAssets({ rootDir = appDir, config } = {}) {
  const payload = config
    || JSON.parse(await fs.readFile(path.join(rootDir, configRelativePath), 'utf8'))
  const configDir = path.join(rootDir, 'src-tauri')
  const problems = []
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (payload?.[key] !== expected) problems.push(`${key} must be ${expected}`)
  }
  const schemes = payload?.plugins?.['deep-link']?.desktop?.schemes
  if (!Array.isArray(schemes) || !schemes.includes('kition')) {
    problems.push('the kition:// deep-link scheme must be registered')
  }
  const icons = Array.isArray(payload?.bundle?.icon) ? payload.bundle.icon : []
  for (const extension of ['.icns', '.ico', '.png']) {
    if (!icons.some((icon) => icon.endsWith(extension))) problems.push(`bundle icons must include a ${extension} file`)
  }
  const assets = [
    ...icons.map((icon) => ['bundle icon', icon]),
    ['macOS entitlements', payload?.bundle?.macOS?.entitlements],
  ]
  for (const [label, configuredPath] of assets) {
    if (!configuredPath) {
      problems.push(`${label} is not configured`)
      continue
    }
    try {
      const stat = await fs.stat(path.resolve(configDir, configuredPath))
      if (!stat.isFile()) problems.push(`${label} is not a file: ${configuredPath}`)
    } catch {
      problems.push(`${label} is missing: ${configuredPath}`)
    }
  }
  if (problems.length) throw new Error(problems.join('; '))
  return assets.map(([label, configuredPath]) => ({ label, path: configuredPath }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const assets = await validateDesktopAssets()
    console.log(`[desktop-assets] verified ${assets.length} configured files`)
  } catch (error) {
    console.error(`[desktop-assets] ${error.message}`)
    process.exitCode = 1
  }
}
