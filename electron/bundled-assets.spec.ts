import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createBundledAssetResponse,
  resolveBundledAssetPath,
} from './bundled-assets.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-bundled-assets-'))
  cleanupPaths.push(root)
  await fs.mkdir(path.join(root, 'onboarding'), { recursive: true })
  await fs.writeFile(path.join(root, 'onboarding', 'manifest.json'), '{"version":1}')
  return root
}

describe('bundled asset protocol', () => {
  it('serves a packaged renderer asset with its content type', async () => {
    const root = await createFixture()
    const response = await createBundledAssetResponse(
      'kition-bundled://assets/onboarding/manifest.json',
      root,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    await expect(response.text()).resolves.toBe('{"version":1}')
  })

  it('rejects unknown hosts and paths outside the renderer bundle', async () => {
    const root = await createFixture()

    expect(() => resolveBundledAssetPath('kition-bundled://other/onboarding/manifest.json', root))
      .toThrow('host is invalid')
    const response = await createBundledAssetResponse(
      'kition-bundled://assets/%2e%2e/%2e%2e/secret.txt',
      root,
    )
    expect(response.status).toBe(404)
  })
})
