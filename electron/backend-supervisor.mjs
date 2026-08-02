import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { normalizeRuntimeLabel, RUNTIME_LABEL_ENV } from './runtime-label.mjs'

const desktopConfigDirName = '.kition'
const desktopConfigFileName = 'config.toml'
const defaultHealthTimeoutMs = 20000

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultDesktopConfigPath = path.join(moduleDir, 'defaults', 'config.toml')
const buildInfoPath = path.join(moduleDir, 'build-info.json')
const runtimeLockPath = path.join(moduleDir, 'runtime.lock.json')

const publicPortalBaseURL = 'https://kition.ai'

function loadBuildInfo() {
  try {
    const raw = fs.readFileSync(buildInfoPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.portalBaseURL === 'string' && parsed.portalBaseURL.trim()) {
      return parsed
    }
  } catch {
    // missing build-info.json is expected in dev mode
  }
  return null
}

function loadExpectedProtocolVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'))
    if (Number.isInteger(parsed?.protocolVersion) && parsed.protocolVersion > 0) {
      return parsed.protocolVersion
    }
  } catch {
    // The caller reports protocol metadata errors when the runtime starts.
  }
  return 0
}

const expectedProtocolVersion = loadExpectedProtocolVersion()

function resolvePortalBaseURL() {
  const explicit = String(process.env.KITION_PORTAL_BASE_URL || '').trim()
  if (explicit) {
    return explicit
  }
  const buildInfo = loadBuildInfo()
  if (buildInfo) {
    return buildInfo.portalBaseURL.trim()
  }
  return publicPortalBaseURL
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      return false
    }
    if (process.platform === 'win32') {
      return true
    }
    return Boolean(stat.mode & 0o111)
  } catch {
    return false
  }
}

async function resolveDesktopApiConfigPath() {
  const override = String(process.env.KITION_DESKTOP_API_CONFIG || '').trim()
  if (override) {
    return override
  }

  const configDir = path.join(os.homedir(), desktopConfigDirName)
  const configPath = path.join(configDir, desktopConfigFileName)

  try {
    const stat = await fsp.stat(configPath)
    if (stat.isDirectory()) {
      throw new Error(`desktop config path is a directory: ${configPath}`)
    }
    return configPath
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 })
  await fsp.copyFile(defaultDesktopConfigPath, configPath)
  return configPath
}

function resolvePackagedApiBinary() {
  const name = process.platform === 'win32' ? 'kition-api.exe' : 'kition-api'
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', name),
    path.join(path.dirname(process.execPath), name),
  ]

  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate
    }
  }

  return ''
}

async function fetchHealth(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRuntimeInfo(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal })
    if (!response.ok) {
      return null
    }
    const body = await response.json()
    const data = body && typeof body === 'object' ? (body.data ?? body) : null
    if (!data || typeof data !== 'object') {
      return null
    }
    return data
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function normalizeWorkspacePath(value) {
  if (typeof value !== 'string') {
    return ''
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  return path.resolve(trimmed)
}

export function workspaceIDFromPath(value) {
  const normalized = normalizeWorkspacePath(value)
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export async function workspaceIDFromDirectory(value) {
  const normalized = normalizeWorkspacePath(value)
  if (!normalized) {
    return ''
  }
  try {
    const manifestPath = path.join(normalized, '.kition', 'workspace.json')
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
    if (manifest?.schema_version === 1 && /^[a-f0-9]{16}$/.test(String(manifest.workspace_id || ''))) {
      return manifest.workspace_id
    }
  } catch {
    // Older workspaces receive a manifest when the runtime starts.
  }
  return workspaceIDFromPath(normalized)
}

export function validateRuntimeInfo(info, expectedProtocol = expectedProtocolVersion) {
  if (!info || typeof info !== 'object') {
    throw new Error('runtime info endpoint returned no data')
  }
  if (!Number.isInteger(info.pid) || info.pid <= 0) {
    throw new Error('runtime info has an invalid pid')
  }
  if (typeof info.workspace_id !== 'string' || !/^[a-f0-9]{16}$/.test(info.workspace_id)) {
    throw new Error('runtime info has an invalid workspace_id')
  }
  if (typeof info.runtime_version !== 'string' || !info.runtime_version.trim()) {
    throw new Error('runtime info is missing runtime_version')
  }
  if (!Number.isInteger(info.protocol_version) || info.protocol_version <= 0) {
    throw new Error('runtime info has an invalid protocol_version')
  }
  if (typeof info.build_commit !== 'string' || !info.build_commit.trim()) {
    throw new Error('runtime info is missing build_commit')
  }
  if (expectedProtocol > 0 && info.protocol_version !== expectedProtocol) {
    throw new Error(`runtime protocol ${info.protocol_version} is incompatible with client protocol ${expectedProtocol}`)
  }
  if (!Array.isArray(info.capabilities) || info.capabilities.some((value) => typeof value !== 'string')) {
    throw new Error('runtime info has invalid capabilities')
  }
  return info
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

function resolveHealthTimeoutMs() {
  const override = Number.parseInt(String(process.env.KITION_DESKTOP_API_HEALTH_TIMEOUT_MS || ''), 10)
  if (Number.isFinite(override) && override > 0) {
    return override
  }

  return defaultHealthTimeoutMs
}

export class BackendSupervisor {
  constructor(env) {
    this.env = env
    this.baseURL = env.backend_url
    this.healthURL = `${env.backend_url}/health`
    this.runtimeURL = `${env.backend_url}/desktop/runtime`
    this.child = null
    this.logs = ''
    this.lastError = ''
    this.launchMode = ''
    this.binaryPath = ''
    this.configPath = ''
    this.workingDir = ''
    this.command = ''
    this.runtimeVersion = ''
    this.protocolVersion = 0
    this.capabilities = []
    this.runtimeSha256 = String(process.env.KITION_RUNTIME_SHA256 || loadBuildInfo()?.runtimeSha256 || '').trim()
    this.runtimeLabel = normalizeRuntimeLabel(process.env[RUNTIME_LABEL_ENV])
    this.logStream = null
    /**
     * Pluggable hook the proxy manager (and future feature toggles) populate
     * with env overrides to inject every time we spawn the Go API. Keeps
     * BackendSupervisor unaware of *what's* in the override — it just merges.
     * Anything that returns the empty string clears the var from the spawn
     * env (so disabling the proxy actually unsets HTTPS_PROXY even if the
     * outer shell had it set).
     */
    this.extraEnvProvider = null
  }

  baseUrl() {
    return this.baseURL
  }

  status() {
    const skipAPI = String(process.env.KITION_DESKTOP_SKIP_API || '').toLowerCase() === 'true'
    return {
      base_url: this.baseURL,
      health_url: skipAPI ? '' : this.healthURL,
      running: skipAPI || Boolean(this.child && !this.child.killed),
      last_error: this.lastError,
      logs: this.logs,
      log_file: this.env.log_file,
      launch_mode: this.launchMode || (skipAPI ? 'skip_api' : ''),
      binary_path: this.binaryPath,
      config_path: this.configPath,
      working_dir: this.workingDir,
      command: this.command,
      runtime_version: this.runtimeVersion,
      protocol_version: this.protocolVersion,
      capabilities: this.capabilities,
      runtime_sha256: this.runtimeSha256,
      runtime_label: this.runtimeLabel,
    }
  }

  async start({ replaceExisting = false } = {}) {
    if (String(process.env.KITION_DESKTOP_SKIP_API || '').toLowerCase() === 'true') {
      this.lastError = ''
      this.launchMode = 'skip_api'
      return this.status()
    }
    if (this.child && !this.child.killed) {
      return this.status()
    }
    if (await fetchHealth(this.healthURL, 1500)) {
      if (await this.adoptOrReplaceExistingRuntime({ replaceExisting })) {
        this.lastError = ''
        return this.status()
      }
    }

    const { command, args, mode, binaryPath, configPath, workingDir, env } = await this.buildCommand()
    this.launchMode = mode
    this.binaryPath = binaryPath
    this.configPath = configPath
    this.workingDir = workingDir
    this.command = [command, ...args].join(' ')

    await fsp.mkdir(path.dirname(this.env.log_file), { recursive: true })
    this.logStream = fs.createWriteStream(this.env.log_file, { flags: 'a' })

    const child = spawn(command, args, {
      cwd: workingDir || undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const append = (chunk) => {
      const text = chunk.toString()
      this.logs = `${this.logs}${text}`.slice(-20000)
      if (this.logStream) {
        this.logStream.write(text)
      }
      if (String(process.env.KITION_DESKTOP_API_STDOUT || 'true').toLowerCase() !== 'false') {
        process.stdout.write(text)
      }
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('exit', () => {
      this.child = null
      this.closeLogStream()
    })
    child.once('error', (error) => {
      this.lastError = error.message
    })

    this.child = child

    try {
      await this.waitForHealthy(resolveHealthTimeoutMs())
      await this.refreshRuntimeInfo()
      this.lastError = ''
      return this.status()
    } catch (error) {
      this.lastError = error.message
      await this.stop()
      throw error
    }
  }

  async retry() {
    await this.stop()
    // A healthy runtime may have been adopted from an earlier desktop process,
    // leaving `this.child` empty. Explicit retries must replace that process
    // instead of immediately adopting it again.
    return this.start({ replaceExisting: true })
  }

  async adoptOrReplaceExistingRuntime({ replaceExisting = false } = {}) {
    const forceRestart = replaceExisting || String(process.env.KITION_DESKTOP_FORCE_RESTART || '').toLowerCase() === 'true'
    const expectedWorkspaceID = await workspaceIDFromDirectory(this.env.workspace_dir)
    const info = await fetchRuntimeInfo(this.runtimeURL, 1500)
    if (!info) {
      this.appendLog(`Detected existing API on ${this.baseURL} without /desktop/runtime support; cannot verify workspace, replacing.\n`)
    } else if (forceRestart) {
      this.appendLog(`KITION_DESKTOP_FORCE_RESTART set; replacing existing API (PID ${info.pid ?? 'unknown'}) instead of adopting.\n`)
    } else {
      try {
        validateRuntimeInfo(info)
        if (expectedWorkspaceID && info.workspace_id === expectedWorkspaceID) {
          this.applyRuntimeInfo(info)
          return true
        }
        this.appendLog(`Existing API (PID ${info.pid ?? 'unknown'}) uses workspace ID ${info.workspace_id ?? '(unknown)'} but Electron expects ${expectedWorkspaceID}; replacing.\n`)
      } catch (error) {
        this.appendLog(`Existing API (PID ${info.pid ?? 'unknown'}) is incompatible: ${error.message}; replacing.\n`)
      }
    }

    const orphanPid = Number.isInteger(info?.pid) ? info.pid : 0
    if (orphanPid > 0) {
      try {
        process.kill(orphanPid, 'SIGTERM')
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH') {
          this.appendLog(`Failed to SIGTERM orphan API PID ${orphanPid}: ${error.message ?? error}\n`)
        }
      }
      const stopped = await waitForProcessExit(orphanPid, 5000)
      if (!stopped) {
        try {
          process.kill(orphanPid, 'SIGKILL')
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH') {
            this.appendLog(`Failed to SIGKILL orphan API PID ${orphanPid}: ${error.message ?? error}\n`)
          }
        }
        await waitForProcessExit(orphanPid, 3000)
      }
    }

    const portFreeDeadline = Date.now() + 5000
    while (Date.now() < portFreeDeadline) {
      if (!(await fetchHealth(this.healthURL, 500))) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (await fetchHealth(this.healthURL, 500)) {
      this.lastError = `unable to evict orphan API on ${this.baseURL} (workspace ID ${info?.workspace_id ?? 'unknown'}); please stop it manually`
      this.appendLog(`${this.lastError}\n`)
      return true
    }
    return false
  }

  appendLog(text) {
    if (!text) {
      return
    }
    this.logs = `${this.logs}${text}`.slice(-20000)
    if (this.logStream) {
      this.logStream.write(text)
    }
  }

  async stop() {
    const child = this.child
    if (!child) {
      return
    }

    const hasExited = () => Number.isInteger(child.exitCode) || typeof child.signalCode === 'string'
    const exitPromise = new Promise((resolve) => {
      if (hasExited()) {
        resolve(true)
        return
      }
      child.once('exit', () => resolve(true))
    })
    const waitForExit = (timeoutMs) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      void exitPromise.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

    if (!hasExited() && !child.killed) {
      child.kill('SIGTERM')
    }
    const exitedGracefully = await waitForExit(5000)

    if (!exitedGracefully && !hasExited()) {
      child.kill('SIGKILL')
      await waitForExit(3000)
    }

    if (this.child === child) {
      this.child = null
    }
    this.closeLogStream()
  }

  async waitForHealthy(timeoutMs = defaultHealthTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await fetchHealth(this.healthURL, 1000)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error(`api runtime did not become healthy at ${this.healthURL}`)
  }

  applyRuntimeInfo(info) {
    this.runtimeVersion = info.runtime_version
    this.protocolVersion = info.protocol_version
    this.capabilities = [...info.capabilities]
  }

  async refreshRuntimeInfo() {
    const info = await fetchRuntimeInfo(this.runtimeURL, 3000)
    validateRuntimeInfo(info)
    this.applyRuntimeInfo(info)
    return info
  }

  async buildCommand() {
    const configPath = await resolveDesktopApiConfigPath()
    const env = {
      ...process.env,
      KITION_API_CONFIG: configPath,
      KITION_PORTAL_BASE_URL: resolvePortalBaseURL(),
      KITION_DESKTOP_RUNTIME: 'true',
      KITION_DESKTOP_API_PORT: String(this.env.backend_port),
      KITION_DESKTOP_SQLITE_PATH: this.env.sqlite_path,
      KITION_DESKTOP_UPLOAD_DIR: this.env.uploads_dir,
      KITION_DESKTOP_LOG_DIR: this.env.logs_dir,
      KITION_DESKTOP_CACHE_DIR: this.env.cache_dir,
      KITION_DESKTOP_DATA_DIR: this.env.data_dir,
      KITION_DESKTOP_WORKSPACE_DIR: this.env.workspace_dir,
    }

    // Merge feature-toggle env overrides (proxy etc.). Empty-string entries
    // mean "explicitly unset", which lets the proxy manager neuter an
    // HTTPS_PROXY that leaked in from the outer shell.
    let overrides = null
    try {
      overrides = this.extraEnvProvider ? this.extraEnvProvider() : null
    } catch (error) {
      this.appendLog(`extraEnvProvider threw: ${error?.message ?? error}\n`)
      overrides = null
    }
    if (overrides && typeof overrides === 'object') {
      for (const [key, value] of Object.entries(overrides)) {
        if (value === '' || value == null) {
          delete env[key]
        } else {
          env[key] = String(value)
        }
      }
    }

    const explicitBinary = String(process.env.KITION_API_BINARY || '').trim()
    if (explicitBinary) {
      if (!isExecutableFile(explicitBinary)) {
        throw new Error(`configured runtime binary does not exist or is not executable: ${explicitBinary}`)
      }
      return {
        command: explicitBinary,
        args: ['all'],
        mode: 'env_binary',
        binaryPath: explicitBinary,
        configPath,
        workingDir: '',
        env,
      }
    }

    const packagedBinary = resolvePackagedApiBinary()
    if (packagedBinary) {
      return {
        command: packagedBinary,
        args: ['all'],
        mode: 'packaged_sidecar',
        binaryPath: packagedBinary,
        configPath,
        workingDir: '',
        env,
      }
    }

    throw new Error('Kition runtime is missing. Run `pnpm dev` or set KITION_API_BINARY to a verified runtime binary.')
  }

  closeLogStream() {
    if (!this.logStream) {
      return
    }
    this.logStream.end()
    this.logStream = null
  }
}
