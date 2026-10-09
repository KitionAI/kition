/**
 * Release artifact naming and the updater manifest. Bundles are renamed to
 * `Kition-<version>-<os>-<arch>` so download links stay stable across
 * releases, and `latest.json` tells installed apps where each signed update
 * lives.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const archByRustArch = { aarch64: 'arm64', x86_64: 'x64' }
const updaterPlatformByOs = { macos: 'darwin', windows: 'windows', linux: 'linux' }
const updaterArchByArch = { arm64: 'aarch64', x64: 'x86_64' }

/** `{ os, arch }` for a Rust target triple such as `aarch64-apple-darwin`. */
export function describeTarget(triple) {
  const [rustArch] = String(triple || '').split('-')
  const arch = archByRustArch[rustArch]
  const os = triple.includes('apple-darwin')
    ? 'macos'
    : triple.includes('windows')
      ? 'windows'
      : triple.includes('linux')
        ? 'linux'
        : ''
  if (!arch || !os) throw new Error(`unsupported desktop target: ${triple}`)
  return { os, arch }
}

/** Where the bundler leaves each artifact, and the name it is published as. */
export function plannedArtifacts({ bundleDir, version, triple }) {
  const { os, arch } = describeTarget(triple)
  const prefix = `Kition-${version}-${os}-${arch}`
  const rustArch = triple.split('-')[0]
  if (os === 'macos') {
    return [
      { from: path.join(bundleDir, 'dmg', `Kition_${version}_${rustArch}.dmg`), to: `${prefix}.dmg` },
      { from: path.join(bundleDir, 'macos', 'Kition.app.tar.gz'), to: `${prefix}.app.tar.gz`, updater: true },
    ]
  }
  if (os === 'windows') {
    const windowsArch = arch === 'x64' ? 'x64' : 'arm64'
    return [
      { from: path.join(bundleDir, 'nsis', `Kition_${version}_${windowsArch}-setup.exe`), to: `${prefix}-setup.exe`, updater: true },
    ]
  }
  const linuxArch = arch === 'x64' ? 'amd64' : 'aarch64'
  return [
    { from: path.join(bundleDir, 'appimage', `Kition_${version}_${linuxArch}.AppImage`), to: `${prefix}.AppImage`, updater: true },
  ]
}

/** Copies bundles (and update signatures) into `outputDir` under release names. */
export async function collectArtifacts({ bundleDir, outputDir, version, triple, signed }) {
  await fs.mkdir(outputDir, { recursive: true })
  const copied = []
  for (const artifact of plannedArtifacts({ bundleDir, version, triple })) {
    await fs.copyFile(artifact.from, path.join(outputDir, artifact.to))
    copied.push(artifact.to)
    if (artifact.updater && signed) {
      await fs.copyFile(`${artifact.from}.sig`, path.join(outputDir, `${artifact.to}.sig`))
      copied.push(`${artifact.to}.sig`)
    }
  }
  return copied
}

/** Every file a complete release publishes for `version`. */
export function expectedReleaseAssets(version) {
  const names = []
  for (const arch of ['arm64', 'x64']) {
    names.push(`Kition-${version}-macos-${arch}.dmg`, `Kition-${version}-macos-${arch}.app.tar.gz`, `Kition-${version}-macos-${arch}.app.tar.gz.sig`)
  }
  names.push(`Kition-${version}-windows-x64-setup.exe`, `Kition-${version}-windows-x64-setup.exe.sig`)
  names.push(`Kition-${version}-linux-x64.AppImage`, `Kition-${version}-linux-x64.AppImage.sig`)
  return names
}

/** Builds `latest.json` from the signed update archives in `artifactDir`. */
export async function buildUpdaterManifest({ artifactDir, version, repository, tag, notes = '', pubDate = new Date().toISOString() }) {
  const entries = await fs.readdir(artifactDir)
  const platforms = {}
  const pattern = new RegExp(`^Kition-${version.replaceAll('.', '\\.')}-(macos|windows|linux)-(arm64|x64)(\\.app\\.tar\\.gz|-setup\\.exe|\\.AppImage)\\.sig$`)
  for (const entry of entries.sort()) {
    const match = entry.match(pattern)
    if (!match) continue
    const [, os, arch] = match
    const artifact = entry.slice(0, -'.sig'.length)
    if (!entries.includes(artifact)) throw new Error(`update signature without artifact: ${entry}`)
    platforms[`${updaterPlatformByOs[os]}-${updaterArchByArch[arch]}`] = {
      signature: (await fs.readFile(path.join(artifactDir, entry), 'utf8')).trim(),
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact)}`,
    }
  }
  if (!Object.keys(platforms).length) throw new Error(`no signed update artifacts found in ${artifactDir}`)
  return { version, notes, pub_date: pubDate, platforms }
}
