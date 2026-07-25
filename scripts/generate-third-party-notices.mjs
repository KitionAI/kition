import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(repositoryDir, 'docs/legal/THIRD_PARTY_NOTICES.txt')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const divider = '='.repeat(80)

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function loadLicenseInventory() {
  const result = spawnSync(packageManager, ['licenses', 'list', '--no-optional', '--json'], {
    cwd: repositoryDir,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'pnpm licenses list failed')
  }
  return JSON.parse(result.stdout)
}

function packageIndexKey(name, version) {
  return `${name}\0${version}`
}

function readPackageIdentity(packagePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return null
    return { name: manifest.name, version: manifest.version }
  } catch {
    return null
  }
}

function listPackagePaths(nodeModulesPath) {
  if (!fs.existsSync(nodeModulesPath)) return []
  const packagePaths = []
  for (const entry of fs.readdirSync(nodeModulesPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const entryPath = path.join(nodeModulesPath, entry.name)
    if (entry.name.startsWith('@')) {
      if (!fs.existsSync(entryPath)) continue
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        packagePaths.push(path.join(entryPath, scopedEntry.name))
      }
      continue
    }
    packagePaths.push(entryPath)
  }
  return packagePaths
}

function buildInstalledPackageIndex() {
  const index = new Map()
  const pendingNodeModules = [path.join(repositoryDir, 'node_modules')]
  const visitedNodeModules = new Set()

  while (pendingNodeModules.length) {
    const nodeModulesPath = pendingNodeModules.pop()
    if (!nodeModulesPath || !fs.existsSync(nodeModulesPath)) continue
    let realNodeModulesPath
    try {
      realNodeModulesPath = fs.realpathSync(nodeModulesPath)
    } catch {
      continue
    }
    if (visitedNodeModules.has(realNodeModulesPath)) continue
    visitedNodeModules.add(realNodeModulesPath)

    for (const packagePath of listPackagePaths(nodeModulesPath)) {
      const identity = readPackageIdentity(packagePath)
      if (!identity) continue
      const key = packageIndexKey(identity.name, identity.version)
      const paths = index.get(key) || []
      paths.push(packagePath)
      index.set(key, paths)
      pendingNodeModules.push(path.join(packagePath, 'node_modules'))
    }
  }

  return index
}

function findLicenseFiles(packagePath) {
  if (!fs.existsSync(packagePath)) {
    return []
  }
  return fs
    .readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(entry.name))
    .map((entry) => path.join(packagePath, entry.name))
    .sort(compareText)
}

function readLicenseTexts(entry, installedPackageIndex) {
  const packagePaths = entry.versions.flatMap((version) => (
    installedPackageIndex.get(packageIndexKey(entry.name, version)) || []
  ))
  const seen = new Set()
  for (const packagePath of packagePaths) {
    for (const licensePath of findLicenseFiles(packagePath)) {
      const text = fs.readFileSync(licensePath, 'utf8')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .trim()
      if (text) seen.add(text)
    }
  }
  return [...seen].sort(compareText)
}

function renderNotices(inventory, installedPackageIndex) {
  const entries = Object.entries(inventory)
    .flatMap(([license, packages]) => packages.map((entry) => ({ ...entry, license })))
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.versions.join(','), right.versions.join(',')))

  const licenseTexts = []
  const textIndexes = new Map()
  const packagesByText = []
  const inventoryLines = entries.flatMap((entry) => {
    const lines = [
      `${entry.name} ${entry.versions.join(', ')}`,
      `License: ${entry.license}`,
    ]
    if (entry.homepage) {
      lines.push(`Homepage: ${entry.homepage}`)
    }
    const texts = readLicenseTexts(entry, installedPackageIndex)
    if (texts.length === 0) {
      lines.push('License text: not present in the installed package')
    } else {
      const indexes = []
      for (const text of texts) {
        let index = textIndexes.get(text)
        if (index === undefined) {
          index = licenseTexts.length
          textIndexes.set(text, index)
          licenseTexts.push(text)
          packagesByText.push([])
        }
        indexes.push(index + 1)
        packagesByText[index].push(`${entry.name} ${entry.versions.join(', ')}`)
      }
      lines.push(`License text: ${indexes.join(', ')}`)
    }
    lines.push('')
    return lines
  })

  const textSections = licenseTexts.map((licenseText, index) => [
    `License text ${index + 1}`,
    `Packages: ${packagesByText[index].join('; ')}`,
    '',
    licenseText,
  ].join('\n'))

  return [
    'Kition Third-Party Notices',
    '',
    'This file covers JavaScript packages installed from pnpm-lock.yaml. It includes',
    'development and build dependencies conservatively because browser bundles may contain',
    'code from packages declared as development dependencies. Platform-specific optional',
    'build packages are omitted because they are not distributed in the application bundle.',
    '',
    'Electron distributions also include Electron and Chromium license files generated by',
    'electron-builder. The separately distributed Kition runtime is governed by its own',
    'license and is not covered by this notice.',
    '',
    divider,
    '',
    'Package Inventory',
    '',
    inventoryLines.join('\n'),
    divider,
    '',
    'License Texts',
    '',
    textSections.join(`\n\n${divider}\n\n`),
    '',
  ].join('\n')
}

function firstDifference(current, rendered) {
  const currentLines = current.split('\n')
  const renderedLines = rendered.split('\n')
  const lineCount = Math.max(currentLines.length, renderedLines.length)
  for (let index = 0; index < lineCount; index += 1) {
    if (currentLines[index] !== renderedLines[index]) {
      return {
        line: index + 1,
        current: currentLines[index] ?? '<end of file>',
        rendered: renderedLines[index] ?? '<end of file>',
      }
    }
  }
  return null
}

const rendered = renderNotices(loadLicenseInventory(), buildInstalledPackageIndex())
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
  if (current !== rendered) {
    console.error('[third-party-notices] docs/legal/THIRD_PARTY_NOTICES.txt is stale; run pnpm notices:generate')
    const difference = firstDifference(current, rendered)
    if (difference) {
      console.error(`[third-party-notices] first difference at line ${difference.line}`)
      console.error(`[third-party-notices] current: ${JSON.stringify(difference.current)}`)
      console.error(`[third-party-notices] generated: ${JSON.stringify(difference.rendered)}`)
    }
    process.exit(1)
  }
  console.log('[third-party-notices] docs/legal/THIRD_PARTY_NOTICES.txt is current')
} else {
  fs.writeFileSync(outputPath, rendered)
  console.log(`[third-party-notices] wrote ${path.relative(repositoryDir, outputPath)}`)
}
