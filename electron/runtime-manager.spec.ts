import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeRuntimeTarget,
  prepareRuntimeArchive,
  resolveRuntimeBinary,
  resolveRuntimeCacheRoot,
  validateRuntimeManifest,
} from './runtime-manager.mjs'

const cleanupPaths: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr}`)))
  })
}

async function sha256(filePath: string) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

async function createReleaseFixture(options: { checksum?: string; binaryContents?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-runtime-test-'))
  cleanupPaths.push(root)
  const sourceDir = path.join(root, 'source')
  await fs.mkdir(sourceDir)
  const binaryPath = path.join(sourceDir, 'kition-api')
  await fs.writeFile(binaryPath, options.binaryContents ?? '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const archiveName = 'kition-runtime-1.2.3-darwin-arm64.tar.gz'
  const archivePath = path.join(root, archiveName)
  await run('tar', ['-czf', archivePath, '-C', sourceDir, 'kition-api'])
  const archiveStat = await fs.stat(archivePath)
  const releaseTag = 'v1.2.3'
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: '1.2.3',
    protocolVersion: 1,
    releaseTag,
    assets: {
      'darwin-arm64': {
        name: archiveName,
        sha256: options.checksum ?? await sha256(archivePath),
        size: archiveStat.size,
      },
    },
  }
  const lockPath = path.join(root, 'runtime.lock.json')
  const manifestPath = path.join(root, 'runtime-manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await fs.writeFile(lockPath, JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: '1.2.3',
    protocolVersion: 1,
    releaseTag,
    repository: 'KitionAI/kition',
  }))

  let manifestRequests = 0
  let assetRequests = 0
  const server = createServer(async (req, res) => {
    if (req.url === `/${releaseTag}/runtime-manifest.json`) {
      manifestRequests += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(manifest))
      return
    }
    if (req.url === `/${releaseTag}/${archiveName}`) {
      assetRequests += 1
      res.setHeader('Content-Type', 'application/gzip')
      res.end(await fs.readFile(archivePath))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')

  return {
    root,
    lockPath,
    manifestPath,
    archivePath,
    cacheRoot: path.join(root, 'cache'),
    baseURL: `http://127.0.0.1:${address.port}`,
    requests: () => ({ manifest: manifestRequests, asset: assetRequests }),
  }
}

describe('runtime target and manifest contracts', () => {
  it('normalizes supported targets', () => {
    expect(normalizeRuntimeTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(normalizeRuntimeTarget('win32', 'x64')).toBe('windows-x64')
    expect(normalizeRuntimeTarget('linux', 'amd64')).toBe('linux-x64')
  })

  it('uses portable platform cache locations', () => {
    expect(resolveRuntimeCacheRoot({ platform: 'darwin', homedir: '/Users/alice', env: {} }))
      .toBe('/Users/alice/Library/Caches/Kition/runtime')
    expect(resolveRuntimeCacheRoot({ platform: 'linux', homedir: '/home/test-user', env: {} }))
      .toBe('/home/test-user/.cache/kition/runtime')
  })

  it('rejects a protocol mismatch', () => {
    expect(() => validateRuntimeManifest({
      schemaVersion: 1,
      runtimeVersion: '1.2.3',
      protocolVersion: 2,
      releaseTag: 'v1.2.3',
      assets: {},
    }, {
      schemaVersion: 1,
      runtimeVersion: '1.2.3',
      protocolVersion: 1,
      releaseTag: 'v1.2.3',
      repository: 'KitionAI/kition',
    }, 'darwin-arm64')).toThrow('Runtime protocol 2 does not match client protocol 1')
  })
})

describe('runtime download and cache', () => {
  it('downloads once and reuses a verified cache entry', async () => {
    const fixture = await createReleaseFixture()
    const first = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })
    expect(first.source).toBe('download')
    expect(await fs.readFile(first.binaryPath, 'utf8')).toContain('exit 0')

    const second = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })
    expect(second.source).toBe('cache')
    expect(fixture.requests()).toEqual({ manifest: 1, asset: 1 })
  })

  it('bypasses configured proxies for loopback runtime asset servers', async () => {
    const fixture = await createReleaseFixture()
    const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const
    const previous = Object.fromEntries(proxyVariables.map((key) => [key, process.env[key]]))
    try {
      process.env.HTTP_PROXY = 'http://127.0.0.1:1'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
      process.env.ALL_PROXY = 'http://127.0.0.1:1'
      process.env.http_proxy = 'http://127.0.0.1:1'
      process.env.https_proxy = 'http://127.0.0.1:1'
      process.env.all_proxy = 'http://127.0.0.1:1'
      delete process.env.NO_PROXY
      delete process.env.no_proxy

      const resolved = await resolveRuntimeBinary({
        platform: 'darwin',
        arch: 'arm64',
        lockPath: fixture.lockPath,
        cacheRoot: fixture.cacheRoot,
        env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
      })
      expect(resolved.source).toBe('download')
      expect(fixture.requests()).toEqual({ manifest: 1, asset: 1 })
    } finally {
      for (const key of proxyVariables) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('supports verified offline cache reuse and fails on an offline miss', async () => {
    const fixture = await createReleaseFixture()
    await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })
    const cached = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_OFFLINE: '1' },
    })
    expect(cached.source).toBe('cache')

    await expect(resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'x64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_OFFLINE: '1' },
    })).rejects.toMatchObject({ code: 'runtime_missing' })
  })

  it('fails closed on a checksum mismatch', async () => {
    const fixture = await createReleaseFixture({ checksum: '0'.repeat(64) })
    await expect(resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })).rejects.toMatchObject({ code: 'runtime_checksum_mismatch' })
  })

  it('replaces a corrupted cached binary', async () => {
    const fixture = await createReleaseFixture()
    const first = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })
    await fs.writeFile(first.binaryPath, 'corrupted')

    const repaired = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })
    expect(repaired.source).toBe('download')
    expect(await fs.readFile(repaired.binaryPath, 'utf8')).toContain('exit 0')
    expect(fixture.requests()).toEqual({ manifest: 2, asset: 2 })
  })

  it('serializes concurrent downloads for the same target', async () => {
    const fixture = await createReleaseFixture()
    const options = {
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    }
    const [first, second] = await Promise.all([
      resolveRuntimeBinary(options),
      resolveRuntimeBinary(options),
    ])
    expect([first.source, second.source].sort()).toEqual(['cache', 'download'])
    expect(fixture.requests()).toEqual({ manifest: 1, asset: 1 })
  })

  it('uses an explicit runtime binary without network access', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-runtime-explicit-'))
    cleanupPaths.push(root)
    const binaryPath = path.join(root, 'kition-api')
    await fs.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const resolved = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      env: { KITION_API_BINARY: binaryPath },
      fetchImpl: () => { throw new Error('network should not be used') },
    })
    expect(resolved.source).toBe('explicit')
    expect(resolved.binaryPath).toBe(binaryPath)
  })

  it('prepares a verified local Release asset for Electron packaging', async () => {
    const fixture = await createReleaseFixture()
    const outputDir = path.join(fixture.root, 'prepared-runtime')
    const prepared = await prepareRuntimeArchive({
      manifestPath: fixture.manifestPath,
      archivePath: fixture.archivePath,
      outputDir,
      target: 'darwin-arm64',
      platform: 'darwin',
      lockPath: fixture.lockPath,
    })
    expect(prepared.runtimeVersion).toBe('1.2.3')
    expect(await fs.readFile(prepared.binaryPath, 'utf8')).toContain('exit 0')
    expect(await fs.readFile(path.join(outputDir, '.runtime.json'), 'utf8')).toContain('archiveSha256')
  })

  it('runs a downloaded fixture runtime and reaches its health endpoint', async () => {
    const runtimeScript = `#!/usr/bin/env node
const http = require('node:http')
const port = Number(process.env.KITION_DESKTOP_API_PORT)
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/health') {
    res.end(JSON.stringify({ code: 0, data: 'healthy' }))
    return
  }
  if (req.url === '/desktop/runtime') {
    res.end(JSON.stringify({ code: 0, data: {
      pid: process.pid,
      workspace_id: 'e3b07878c7578421',
      runtime_version: '1.2.3',
      protocol_version: 1,
      build_commit: 'fixture',
      capabilities: ['documents']
    } }))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
    const fixture = await createReleaseFixture({ binaryContents: runtimeScript })
    const resolved = await resolveRuntimeBinary({
      platform: 'darwin',
      arch: 'arm64',
      lockPath: fixture.lockPath,
      cacheRoot: fixture.cacheRoot,
      env: { KITION_RUNTIME_BASE_URL: fixture.baseURL },
    })

    const portServer = createServer()
    await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
    const portAddress = portServer.address()
    if (!portAddress || typeof portAddress === 'string') throw new Error('port probe did not bind')
    const port = portAddress.port
    await new Promise<void>((resolve) => portServer.close(() => resolve()))

    const child = spawn(resolved.binaryPath, [], {
      env: { ...process.env, KITION_DESKTOP_API_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOutput = ''
    let childExited = false
    child.stdout.on('data', (chunk) => { childOutput += chunk.toString() })
    child.stderr.on('data', (chunk) => { childOutput += chunk.toString() })
    child.once('exit', () => { childExited = true })
    try {
      let healthy = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`)
          if (response.ok) {
            healthy = true
            break
          }
        } catch {
          // Runtime is still starting.
        }
        if (childExited) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(healthy, childOutput).toBe(true)
      const response = await fetch(`http://127.0.0.1:${port}/desktop/runtime`)
      const payload = await response.json()
      expect(payload.data).toMatchObject({ runtime_version: '1.2.3', protocol_version: 1 })
    } finally {
      if (!childExited) {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
    }
  })
})
