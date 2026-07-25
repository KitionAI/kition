import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import axios from 'axios'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultLockPath = path.join(moduleDir, 'runtime.lock.json')
const manifestFilename = 'runtime-manifest.json'
const metadataFilename = '.runtime.json'
const lockTimeoutMs = 30_000
const staleLockMs = 5 * 60_000
const downloadTimeoutMs = 60_000

export class RuntimeResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RuntimeResolutionError'
    this.code = code
    this.details = details
  }
}

function runtimeError(code, message, details) {
  return new RuntimeResolutionError(code, message, details)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function normalizeRuntimeTarget(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' || arch === 'amd64'
    ? 'x64'
    : arch === 'arm64' || arch === 'aarch64'
      ? 'arm64'
      : ''
  const normalizedPlatform = platform === 'win32'
    ? 'windows'
    : platform === 'darwin' || platform === 'linux'
      ? platform
      : ''

  if (!normalizedPlatform || !normalizedArch) {
    throw runtimeError(
      'runtime_platform_unsupported',
      `Unsupported runtime platform: ${platform}-${arch}. Supported targets use darwin, windows, or linux with arm64 or x64.`,
      { platform, arch },
    )
  }
  return `${normalizedPlatform}-${normalizedArch}`
}

export function runtimeBinaryName(platform = process.platform) {
  return platform === 'win32' || platform === 'windows' ? 'kition-api.exe' : 'kition-api'
}

export function resolveRuntimeCacheRoot({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Caches', 'Kition', 'runtime')
  }
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim()
    return path.join(localAppData || path.join(homedir, 'AppData', 'Local'), 'Kition', 'Cache', 'runtime')
  }
  const xdgCache = String(env.XDG_CACHE_HOME || '').trim()
  return path.join(xdgCache || path.join(homedir, '.cache'), 'kition', 'runtime')
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('runtime_archive_invalid', `${label} must be an object`)
  }
}

export function validateRuntimeLock(value) {
  assertPlainObject(value, 'runtime lock')
  if (value.schemaVersion !== 1) {
    throw runtimeError('runtime_archive_invalid', `Unsupported runtime lock schema: ${value.schemaVersion}`)
  }
  for (const field of ['runtimeVersion', 'releaseTag', 'repository']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw runtimeError('runtime_archive_invalid', `runtime lock is missing ${field}`)
    }
  }
  if (!Number.isInteger(value.protocolVersion) || value.protocolVersion <= 0) {
    throw runtimeError('runtime_archive_invalid', 'runtime lock has an invalid protocolVersion')
  }
  return {
    schemaVersion: 1,
    runtimeVersion: value.runtimeVersion.trim(),
    protocolVersion: value.protocolVersion,
    releaseTag: value.releaseTag.trim(),
    repository: value.repository.trim(),
  }
}

export function validateRuntimeManifest(value, lock, target) {
  assertPlainObject(value, 'runtime manifest')
  if (value.schemaVersion !== 1) {
    throw runtimeError('runtime_archive_invalid', `Unsupported runtime manifest schema: ${value.schemaVersion}`)
  }
  if (value.runtimeVersion !== lock.runtimeVersion || value.releaseTag !== lock.releaseTag) {
    throw runtimeError(
      'runtime_archive_invalid',
      `Runtime manifest version ${value.runtimeVersion || '(missing)'} does not match ${lock.runtimeVersion}`,
    )
  }
  if (value.protocolVersion !== lock.protocolVersion) {
    throw runtimeError(
      'runtime_protocol_incompatible',
      `Runtime protocol ${value.protocolVersion || '(missing)'} does not match client protocol ${lock.protocolVersion}`,
      { expected: lock.protocolVersion, actual: value.protocolVersion },
    )
  }
  assertPlainObject(value.assets, 'runtime manifest assets')
  const asset = value.assets[target]
  assertPlainObject(asset, `runtime asset ${target}`)
  if (
    typeof asset.name !== 'string'
    || !asset.name
    || asset.name.includes('/')
    || asset.name.includes('\\')
    || path.basename(asset.name) !== asset.name
  ) {
    throw runtimeError('runtime_archive_invalid', `Runtime asset ${target} has an unsafe name`)
  }
  if (!/^[a-f0-9]{64}$/.test(String(asset.sha256 || ''))) {
    throw runtimeError('runtime_archive_invalid', `Runtime asset ${target} has an invalid SHA-256`)
  }
  if (!Number.isInteger(asset.size) || asset.size <= 0) {
    throw runtimeError('runtime_archive_invalid', `Runtime asset ${target} has an invalid size`)
  }
  return {
    manifest: value,
    asset: {
      name: asset.name,
      sha256: asset.sha256,
      size: asset.size,
    },
  }
}

function releaseAssetURL(lock, filename, baseURL = '') {
  const override = String(baseURL || '').trim().replace(/\/+$/, '')
  if (override) {
    return `${override}/${encodeURIComponent(lock.releaseTag)}/${encodeURIComponent(filename)}`
  }
  return `https://github.com/${lock.repository}/releases/download/${encodeURIComponent(lock.releaseTag)}/${encodeURIComponent(filename)}`
}

async function readJSON(filePath, label) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'))
  } catch (error) {
    throw runtimeError('runtime_archive_invalid', `Unable to read ${label}: ${error.message}`, { filePath })
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function isRegularFile(filePath) {
  try {
    return (await fsp.stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function validateExplicitBinary(filePath) {
  const resolved = path.resolve(filePath)
  if (!(await isRegularFile(resolved))) {
    throw runtimeError('runtime_missing', `Configured runtime binary does not exist: ${resolved}`)
  }
  if (process.platform !== 'win32') {
    await fsp.chmod(resolved, 0o755)
  }
  return resolved
}

async function validateCachedRuntime({ binaryPath, metadataPath, lock, target }) {
  if (!(await isRegularFile(binaryPath)) || !(await isRegularFile(metadataPath))) {
    return null
  }
  try {
    const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'))
    if (
      metadata.runtimeVersion !== lock.runtimeVersion
      || metadata.protocolVersion !== lock.protocolVersion
      || metadata.target !== target
      || !/^[a-f0-9]{64}$/.test(String(metadata.binarySha256 || ''))
    ) {
      return null
    }
    const actualHash = await sha256File(binaryPath)
    if (actualHash !== metadata.binarySha256) {
      return null
    }
    return { binaryPath, metadata }
  } catch {
    return null
  }
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs = downloadTimeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/octet-stream, application/json',
        'User-Agent': 'Kition-Runtime-Resolver',
      },
    })
  } catch (error) {
    throw runtimeError('runtime_download_failed', `Failed to download ${url}: ${error.message}`, { url })
  } finally {
    clearTimeout(timer)
  }
}

function axiosProxyConfig(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
      return { proxy: false }
    }
  } catch {
    // URL validation is handled by the request implementation.
  }
  return {}
}

async function downloadJSON(url, fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    try {
      const response = await axios.get(url, {
        ...axiosProxyConfig(url),
        adapter: 'http',
        responseType: 'json',
        timeout: downloadTimeoutMs,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Kition-Runtime-Resolver',
        },
      })
      if (response.status < 200 || response.status >= 300) {
        throw runtimeError('runtime_download_failed', `Runtime download returned HTTP ${response.status}: ${url}`, { url, status: response.status })
      }
      return response.data
    } catch (error) {
      if (error instanceof RuntimeResolutionError) throw error
      throw runtimeError('runtime_download_failed', `Failed to download ${url}: ${error.message}`, { url })
    }
  }
  const response = await fetchWithTimeout(url, fetchImpl)
  if (!response.ok) {
    throw runtimeError('runtime_download_failed', `Runtime download returned HTTP ${response.status}: ${url}`, { url, status: response.status })
  }
  try {
    return await response.json()
  } catch (error) {
    throw runtimeError('runtime_archive_invalid', `Runtime manifest is not valid JSON: ${error.message}`, { url })
  }
}

async function downloadFile(url, destination, expectedSize, fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    try {
      const response = await axios.get(url, {
        ...axiosProxyConfig(url),
        adapter: 'http',
        responseType: 'stream',
        timeout: downloadTimeoutMs,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'Kition-Runtime-Resolver',
        },
      })
      if (response.status < 200 || response.status >= 300) {
        response.data?.destroy?.()
        throw runtimeError('runtime_download_failed', `Runtime download returned HTTP ${response.status}: ${url}`, { url, status: response.status })
      }
      await pipeline(response.data, createWriteStream(destination, { flags: 'wx' }))
    } catch (error) {
      if (error instanceof RuntimeResolutionError) throw error
      throw runtimeError('runtime_download_failed', `Failed to download ${url}: ${error.message}`, { url })
    }
    const stat = await fsp.stat(destination)
    if (stat.size !== expectedSize) {
      throw runtimeError(
        'runtime_archive_invalid',
        `Runtime asset size mismatch: expected ${expectedSize}, got ${stat.size}`,
        { url, expectedSize, actualSize: stat.size },
      )
    }
    return
  }
  const response = await fetchWithTimeout(url, fetchImpl)
  if (!response.ok || !response.body) {
    throw runtimeError('runtime_download_failed', `Runtime download returned HTTP ${response.status}: ${url}`, { url, status: response.status })
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }))
  const stat = await fsp.stat(destination)
  if (stat.size !== expectedSize) {
    throw runtimeError(
      'runtime_archive_invalid',
      `Runtime asset size mismatch: expected ${expectedSize}, got ${stat.size}`,
      { url, expectedSize, actualSize: stat.size },
    )
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
    })
  })
}

function assertSafeArchiveEntries(entries) {
  const filtered = entries.map((entry) => entry.trim()).filter(Boolean)
  if (!filtered.length) {
    throw runtimeError('runtime_archive_invalid', 'Runtime archive is empty')
  }
  for (const entry of filtered) {
    const normalized = entry.replaceAll('\\', '/')
    if (
      normalized.startsWith('/')
      || /^[a-zA-Z]:\//.test(normalized)
      || normalized.split('/').includes('..')
    ) {
      throw runtimeError('runtime_archive_invalid', `Runtime archive contains an unsafe path: ${entry}`)
    }
  }
}

async function extractArchive(archivePath, destination, platform) {
  await fsp.mkdir(destination, { recursive: true })
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    const listed = await runCommand('tar', ['-tzf', archivePath])
    assertSafeArchiveEntries(listed.stdout.split('\n'))
    await runCommand('tar', ['-xzf', archivePath, '-C', destination])
    return
  }
  if (archivePath.endsWith('.zip')) {
    if (platform === 'win32') {
      const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows')
      const windowsTar = path.win32.join(systemRoot, 'System32', 'tar.exe')
      const listed = await runCommand(windowsTar, ['-tf', archivePath])
      assertSafeArchiveEntries(listed.stdout.split(/\r?\n/))
      await runCommand(windowsTar, ['-xf', archivePath, '-C', destination])
      return
    }
    const listed = await runCommand('unzip', ['-Z1', archivePath])
    assertSafeArchiveEntries(listed.stdout.split('\n'))
    await runCommand('unzip', ['-q', archivePath, '-d', destination])
    return
  }
  throw runtimeError('runtime_archive_invalid', `Unsupported runtime archive: ${path.basename(archivePath)}`)
}

async function findRuntimeBinary(root, binaryName) {
  const matches = []
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw runtimeError('runtime_archive_invalid', `Runtime archive contains a symbolic link: ${entry.name}`)
      }
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name === binaryName) {
        matches.push(fullPath)
      }
    }
  }
  await walk(root)
  if (matches.length !== 1) {
    throw runtimeError('runtime_archive_invalid', `Runtime archive must contain exactly one ${binaryName}; found ${matches.length}`)
  }
  return matches[0]
}

async function acquireFileLock(lockPath) {
  const deadline = Date.now() + lockTimeoutMs
  await fsp.mkdir(path.dirname(lockPath), { recursive: true })
  while (Date.now() < deadline) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
      return async () => {
        await handle.close().catch(() => {})
        await fsp.rm(lockPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const stat = await fsp.stat(lockPath)
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          await fsp.rm(lockPath, { force: true })
          continue
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError
      }
      await sleep(100)
    }
  }
  throw runtimeError('runtime_download_failed', `Timed out waiting for runtime cache lock: ${lockPath}`)
}

export async function resolveRuntimeBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homedir = os.homedir(),
  lockPath = defaultLockPath,
  cacheRoot,
  fetchImpl = null,
} = {}) {
  const explicitBinary = String(env.KITION_API_BINARY || '').trim()
  if (explicitBinary) {
    const binaryPath = await validateExplicitBinary(explicitBinary)
    return {
      binaryPath,
      source: 'explicit',
      runtimeVersion: '',
      protocolVersion: 0,
      target: normalizeRuntimeTarget(platform, arch),
      sha256: await sha256File(binaryPath),
    }
  }
  const target = normalizeRuntimeTarget(platform, arch)
  const lock = validateRuntimeLock(await readJSON(lockPath, 'runtime lock'))
  const versionOverride = String(env.KITION_RUNTIME_VERSION || '').trim().replace(/^v/, '')
  if (versionOverride) {
    lock.runtimeVersion = versionOverride
    lock.releaseTag = `v${versionOverride}`
  }

  const resolvedCacheRoot = cacheRoot || resolveRuntimeCacheRoot({ platform, env, homedir })
  const installDir = path.join(resolvedCacheRoot, lock.runtimeVersion, target)
  const binaryName = runtimeBinaryName(platform)
  const binaryPath = path.join(installDir, binaryName)
  const metadataPath = path.join(installDir, metadataFilename)
  const forceDownload = String(env.KITION_RUNTIME_FORCE_DOWNLOAD || '') === '1'
  const offline = String(env.KITION_RUNTIME_OFFLINE || '') === '1'

  if (!forceDownload) {
    const cached = await validateCachedRuntime({ binaryPath, metadataPath, lock, target })
    if (cached) {
      return {
        binaryPath: cached.binaryPath,
        source: 'cache',
        runtimeVersion: lock.runtimeVersion,
        protocolVersion: lock.protocolVersion,
        target,
        sha256: cached.metadata.binarySha256,
      }
    }
  }
  if (offline) {
    throw runtimeError('runtime_missing', `No verified cached runtime exists for ${lock.runtimeVersion} ${target}`)
  }

  const releaseLockPath = path.join(resolvedCacheRoot, lock.runtimeVersion, `.${target}.lock`)
  const releaseLock = await acquireFileLock(releaseLockPath)
  let temporaryRoot = ''
  try {
    if (!forceDownload) {
      const cached = await validateCachedRuntime({ binaryPath, metadataPath, lock, target })
      if (cached) {
        return {
          binaryPath: cached.binaryPath,
          source: 'cache',
          runtimeVersion: lock.runtimeVersion,
          protocolVersion: lock.protocolVersion,
          target,
          sha256: cached.metadata.binarySha256,
        }
      }
    }

    const baseURL = String(env.KITION_RUNTIME_BASE_URL || '')
    const manifestURL = releaseAssetURL(lock, manifestFilename, baseURL)
    const manifestPayload = await downloadJSON(manifestURL, fetchImpl)
    const { asset } = validateRuntimeManifest(manifestPayload, lock, target)

    const versionDir = path.join(resolvedCacheRoot, lock.runtimeVersion)
    await fsp.mkdir(versionDir, { recursive: true })
    temporaryRoot = await fsp.mkdtemp(path.join(versionDir, `.tmp-${target}-${process.pid}-`))
    const archivePath = path.join(temporaryRoot, asset.name)
    await downloadFile(releaseAssetURL(lock, asset.name, baseURL), archivePath, asset.size, fetchImpl)
    const archiveHash = await sha256File(archivePath)
    if (archiveHash !== asset.sha256) {
      throw runtimeError(
        'runtime_checksum_mismatch',
        `Runtime checksum mismatch for ${asset.name}`,
        { expected: asset.sha256, actual: archiveHash },
      )
    }

    const extractedDir = path.join(temporaryRoot, 'extracted')
    await extractArchive(archivePath, extractedDir, platform)
    const extractedBinary = await findRuntimeBinary(extractedDir, binaryName)
    const preparedDir = path.join(temporaryRoot, 'prepared')
    await fsp.mkdir(preparedDir)
    const preparedBinary = path.join(preparedDir, binaryName)
    await fsp.copyFile(extractedBinary, preparedBinary)
    if (platform !== 'win32') {
      await fsp.chmod(preparedBinary, 0o755)
    }
    const binarySha256 = await sha256File(preparedBinary)
    await fsp.writeFile(path.join(preparedDir, metadataFilename), JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: lock.runtimeVersion,
      protocolVersion: lock.protocolVersion,
      releaseTag: lock.releaseTag,
      target,
      archiveName: asset.name,
      archiveSha256: asset.sha256,
      binarySha256,
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })

    await fsp.rm(installDir, { recursive: true, force: true })
    await fsp.rename(preparedDir, installDir)
    return {
      binaryPath,
      source: 'download',
      runtimeVersion: lock.runtimeVersion,
      protocolVersion: lock.protocolVersion,
      target,
      sha256: binarySha256,
    }
  } finally {
    if (temporaryRoot) {
      await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
    }
    await releaseLock()
  }
}

export async function readRuntimeLock(lockPath = defaultLockPath) {
  return validateRuntimeLock(await readJSON(lockPath, 'runtime lock'))
}

export async function prepareRuntimeArchive({
  manifestPath,
  archivePath,
  outputDir,
  target,
  platform = process.platform,
  lockPath = defaultLockPath,
}) {
  const lock = await readRuntimeLock(lockPath)
  const manifestPayload = await readJSON(manifestPath, 'runtime manifest')
  const { asset } = validateRuntimeManifest(manifestPayload, lock, target)
  if (path.basename(archivePath) !== asset.name) {
    throw runtimeError(
      'runtime_archive_invalid',
      `Runtime archive ${path.basename(archivePath)} does not match manifest asset ${asset.name}`,
    )
  }
  const archiveStat = await fsp.stat(archivePath)
  if (!archiveStat.isFile() || archiveStat.size !== asset.size) {
    throw runtimeError(
      'runtime_archive_invalid',
      `Runtime asset size mismatch: expected ${asset.size}, got ${archiveStat.size}`,
    )
  }
  const archiveHash = await sha256File(archivePath)
  if (archiveHash !== asset.sha256) {
    throw runtimeError(
      'runtime_checksum_mismatch',
      `Runtime checksum mismatch for ${asset.name}`,
      { expected: asset.sha256, actual: archiveHash },
    )
  }

  const parentDir = path.dirname(path.resolve(outputDir))
  await fsp.mkdir(parentDir, { recursive: true })
  const temporaryRoot = await fsp.mkdtemp(path.join(parentDir, `.runtime-prepare-${process.pid}-`))
  try {
    const extractedDir = path.join(temporaryRoot, 'extracted')
    await extractArchive(archivePath, extractedDir, platform)
    const binaryName = runtimeBinaryName(platform)
    const extractedBinary = await findRuntimeBinary(extractedDir, binaryName)
    const preparedDir = path.join(temporaryRoot, 'prepared')
    await fsp.mkdir(preparedDir)
    const preparedBinary = path.join(preparedDir, binaryName)
    await fsp.copyFile(extractedBinary, preparedBinary)
    if (platform !== 'win32') {
      await fsp.chmod(preparedBinary, 0o755)
    }
    const binarySha256 = await sha256File(preparedBinary)
    await fsp.writeFile(path.join(preparedDir, metadataFilename), JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: lock.runtimeVersion,
      protocolVersion: lock.protocolVersion,
      releaseTag: lock.releaseTag,
      target,
      archiveName: asset.name,
      archiveSha256: asset.sha256,
      binarySha256,
      preparedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })
    await fsp.rm(outputDir, { recursive: true, force: true })
    await fsp.rename(preparedDir, outputDir)
    return {
      binaryPath: path.join(outputDir, binaryName),
      runtimeVersion: lock.runtimeVersion,
      protocolVersion: lock.protocolVersion,
      target,
      archiveSha256: asset.sha256,
      binarySha256,
    }
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function defaultRuntimeLockPath() {
  return defaultLockPath
}
