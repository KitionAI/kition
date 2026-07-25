import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { validateDesktopRenderer } from './validate-desktop-renderer.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createFixture(indexHtml: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-renderer-'))
  cleanupPaths.push(rootDir)
  await fs.mkdir(path.join(rootDir, 'dist', 'assets'), { recursive: true })
  await fs.writeFile(path.join(rootDir, 'dist', 'index.html'), indexHtml)
  await fs.writeFile(path.join(rootDir, 'dist', 'assets', 'app.js'), 'export {}')
  await fs.writeFile(path.join(rootDir, 'dist', 'assets', 'app.css'), '')
  await fs.writeFile(path.join(rootDir, 'dist', 'logo-mark.png'), '')
  return rootDir
}

describe('validateDesktopRenderer', () => {
  it('accepts file-compatible relative assets', async () => {
    const rootDir = await createFixture(`
      <script type="module" src="./assets/app.js"></script>
      <link rel="stylesheet" href="./assets/app.css">
    `)

    await expect(validateDesktopRenderer({ rootDir })).resolves.toEqual([
      './assets/app.js',
      './assets/app.css',
    ])
  })

  it('rejects root-relative assets that produce a packaged black screen', async () => {
    const rootDir = await createFixture('<script type="module" src="/assets/app.js"></script>')

    await expect(validateDesktopRenderer({ rootDir })).rejects.toThrow(
      'root-relative assets that cannot load over file://',
    )
  })

  it('rejects missing relative assets', async () => {
    const rootDir = await createFixture('<script type="module" src="./assets/missing.js"></script>')

    await expect(validateDesktopRenderer({ rootDir })).rejects.toThrow(
      'references missing assets: ./assets/missing.js',
    )
  })

  it('rejects a root-relative logo reference hidden inside a JavaScript bundle', async () => {
    const rootDir = await createFixture('<script type="module" src="./assets/app.js"></script>')
    await fs.writeFile(
      path.join(rootDir, 'dist', 'assets', 'app.js'),
      'export const logo = "/logo-mark.png"',
    )

    await expect(validateDesktopRenderer({ rootDir })).rejects.toThrow(
      'root-relative logo-mark.png reference',
    )
  })
})
