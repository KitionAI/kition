import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProxyManager } from './proxy-manager.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('ProxyManager browser sessions', () => {
  it('applies saved proxy changes to registered embedded-browser partitions', async () => {
    const proxyEnvKeys = [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'https_proxy',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
      'KITION_SMTP_PROXY',
    ] as const
    const previousEnv = Object.fromEntries(
      proxyEnvKeys.map((key) => [key, process.env[key]]),
    )
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-proxy-manager-'))
    tempDirs.push(dataDir)
    const defaultSession = { setProxy: vi.fn(async () => {}) }
    const browserPartition = { setProxy: vi.fn(async () => {}) }
    const secureStore = {
      get: vi.fn(async () => ''),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    }
    const manager = new ProxyManager({
      env: { data_dir: dataDir },
      secureStore,
      getSession: () => defaultSession,
    })

    try {
      await manager.applyToSession(browserPartition)
      expect(browserPartition.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })

      await manager.save({
        enabled: true,
        scheme: 'http',
        host: 'proxy.example.test',
        port: 8080,
        username: '',
        noProxy: 'localhost, 127.0.0.1',
      })
      await manager.apply()

      const expectedProxy = {
        proxyRules:
          'http=http://proxy.example.test:8080;https=http://proxy.example.test:8080',
        proxyBypassRules: '<local>,localhost,127.0.0.1',
      }
      expect(defaultSession.setProxy).toHaveBeenLastCalledWith(expectedProxy)
      expect(browserPartition.setProxy).toHaveBeenLastCalledWith(expectedProxy)

      await manager.save({
        enabled: true,
        scheme: 'socks5',
        host: '127.0.0.1',
        port: 7890,
        username: '',
        noProxy: 'localhost',
      })
      await manager.apply()
      const expectedSocksProxy = {
        proxyRules: 'socks5://127.0.0.1:7890',
        proxyBypassRules: '<local>,localhost',
      }
      expect(defaultSession.setProxy).toHaveBeenLastCalledWith(expectedSocksProxy)
      expect(browserPartition.setProxy).toHaveBeenLastCalledWith(expectedSocksProxy)

      await manager.save({ enabled: false })
      await manager.apply()
      expect(defaultSession.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
      expect(browserPartition.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    } finally {
      for (const key of proxyEnvKeys) {
        if (previousEnv[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = previousEnv[key]
        }
      }
    }
  })
})
