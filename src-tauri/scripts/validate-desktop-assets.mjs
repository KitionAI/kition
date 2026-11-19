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
  const allIcons = Array.isArray(payload?.bundle?.icon) ? payload.bundle.icon : []
  for (const extension of ['.icns', '.ico', '.png']) {
    if (!allIcons.some((icon) => icon.endsWith(extension))) problems.push(`bundle icons must include a ${extension} file`)
  }
  // macOS 26 and later draw the Icon Composer icon (compiled into Assets.car) and its edge; with
  // only the icns they draw their edge around the rim baked into it, a tile within a tile.
  const composerIcons = allIcons.filter((icon) => icon.endsWith('.icon'))
  if (!composerIcons.length) problems.push('bundle icons must include an Icon Composer .icon package')
  for (const icon of composerIcons) problems.push(...await iconComposerProblems(configDir, icon))
  const assets = [
    ...allIcons.filter((icon) => !icon.endsWith('.icon')).map((icon) => ['bundle icon', icon]),
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
  return [
    ...assets.map(([label, configuredPath]) => ({ label, path: configuredPath })),
    ...composerIcons.map((icon) => ({ label: 'Icon Composer icon', path: icon })),
  ]
}

/** An Icon Composer package is a directory with icon.json and the images its layers name. */
async function iconComposerProblems(configDir, icon) {
  const dir = path.resolve(configDir, icon)
  let doc
  try {
    doc = JSON.parse(await fs.readFile(path.join(dir, 'icon.json'), 'utf8'))
  } catch {
    return [`${icon} has no readable icon.json`]
  }
  const layers = (doc?.groups ?? []).flatMap((group) => group?.layers ?? [])
  if (!layers.length) return [`${icon} has no layers`]
  const problems = []
  for (const layer of layers) {
    const image = path.posix.join('Assets', String(layer?.['image-name'] ?? ''))
    try {
      if (!(await fs.stat(path.join(dir, image))).isFile()) problems.push(`${icon} has no layer image ${image}`)
    } catch {
      problems.push(`${icon} has no layer image ${image}`)
    }
  }
  return problems
}

/**
 * Checks that a built Kition.app carries the compiled Icon Composer icon. The Tauri bundler only
 * logs when actool is older than 26 and ships the app without it.
 */
export async function macAppIconProblems(appPath) {
  const problems = []
  try {
    await fs.access(path.join(appPath, 'Contents', 'Resources', 'Assets.car'))
  } catch {
    problems.push('Contents/Resources/Assets.car is missing: the bundler needs Xcode 26 or later (actool) to compile icons/icon.icon')
  }
  const plist = await fs.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')
  if (!/<key>CFBundleIconName<\/key>\s*<string>[^<]+<\/string>/.test(plist)) problems.push('Info.plist has no CFBundleIconName')
  return problems
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
