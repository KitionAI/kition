import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { normalizeRuntimeTarget, readRuntimeLock, resolveRuntimeBinary, runtimeBinaryName } from '../runtime-manager.mjs'

async function sha256File(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function copyRuntimeBinary(sourcePath, outputDir, goos) {
  await fs.mkdir(outputDir, { recursive: true })
  const binaryName = runtimeBinaryName(goos)
  const outputPath = path.join(outputDir, binaryName)
  await fs.rm(outputPath, { force: true })
  await fs.copyFile(sourcePath, outputPath)
  if (goos !== 'windows') {
    await fs.chmod(outputPath, 0o755)
  }
  return outputPath
}

export async function buildSidecar(
  outputDir,
  goos = process.platform === 'win32' ? 'windows' : process.platform,
  goarch = process.arch === 'x64' ? 'amd64' : process.arch,
) {
  const lock = await readRuntimeLock()
  const explicitAssetDir = String(process.env.KITION_RUNTIME_ASSET_DIR || '').trim()
  if (explicitAssetDir) {
    const assetDir = path.resolve(explicitAssetDir)
    const sourcePath = path.join(assetDir, runtimeBinaryName(goos))
    const metadata = JSON.parse(await fs.readFile(path.join(assetDir, '.runtime.json'), 'utf8'))
    const target = normalizeRuntimeTarget(goos === 'windows' ? 'win32' : goos, goarch === 'amd64' ? 'x64' : goarch)
    const sourceSha256 = await sha256File(sourcePath)
    if (
      metadata.schemaVersion !== 1
      || metadata.runtimeVersion !== lock.runtimeVersion
      || metadata.protocolVersion !== lock.protocolVersion
      || metadata.target !== target
      || metadata.binarySha256 !== sourceSha256
    ) {
      throw new Error(`KITION_RUNTIME_ASSET_DIR does not contain a verified ${lock.runtimeVersion} ${target} runtime`)
    }
    const outputPath = await copyRuntimeBinary(sourcePath, outputDir, goos)
    return {
      outputPath,
      source: 'asset-dir',
      runtimeVersion: lock.runtimeVersion,
      protocolVersion: lock.protocolVersion,
      sha256: sourceSha256,
    }
  }

  const explicitBinary = String(process.env.KITION_API_BINARY || '').trim()
  if (explicitBinary) {
    const resolved = await resolveRuntimeBinary({
      platform: goos === 'windows' ? 'win32' : goos,
      arch: goarch === 'amd64' ? 'x64' : goarch,
    })
    const outputPath = await copyRuntimeBinary(resolved.binaryPath, outputDir, goos)
    return {
      outputPath,
      source: resolved.source,
      runtimeVersion: lock.runtimeVersion,
      protocolVersion: lock.protocolVersion,
      sha256: await sha256File(outputPath),
    }
  }

  const resolved = await resolveRuntimeBinary({
    platform: goos === 'windows' ? 'win32' : goos,
    arch: goarch === 'amd64' ? 'x64' : goarch,
  })
  const outputPath = await copyRuntimeBinary(resolved.binaryPath, outputDir, goos)

  return {
    outputPath,
    source: resolved.source,
    runtimeVersion: resolved.runtimeVersion,
    protocolVersion: resolved.protocolVersion,
    sha256: await sha256File(outputPath),
  }
}
