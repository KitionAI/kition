import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { validateDesktopRenderer } from './validate-desktop-renderer.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createFixture(indexHtml: string, { logo = true } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-renderer-'))
  cleanupPaths.push(rootDir)
  await fs.mkdir(path.join(rootDir, 'dist', 'assets'), { recursive: true })
  await fs.writeFile(path.join(rootDir, 'dist', 'index.html'), indexHtml)
  await fs.writeFile(path.join(rootDir, 'dist', 'assets', 'app.js'), 'export {}')
  await fs.writeFile(path.join(rootDir, 'dist', 'assets', 'app.css'), '')
  if (logo) await fs.writeFile(path.join(rootDir, 'dist', 'logo-mark.png'), '')
  return rootDir
}

describe('validateDesktopRenderer', () => {
  it('accepts root-relative and relative assets served from the app origin', async () => {
    const rootDir = await createFixture(`
      <script type="module" src="/assets/app.js"></script>
      <link rel="stylesheet" href="./assets/app.css">
    `)

    await expect(validateDesktopRenderer({ rootDir })).resolves.toEqual([
      '/assets/app.js',
      './assets/app.css',
    ])
  })

  it('rejects missing assets', async () => {
    const rootDir = await createFixture('<script type="module" src="/assets/missing.js"></script>')

    await expect(validateDesktopRenderer({ rootDir })).rejects.toThrow(
      'references missing assets: /assets/missing.js',
    )
  })

  it('requires a JavaScript entry', async () => {
    const rootDir = await createFixture('<link rel="stylesheet" href="/assets/app.css">')

    await expect(validateDesktopRenderer({ rootDir })).rejects.toThrow('JavaScript entry asset')
  })

  it('requires the logo mark', async () => {
    const rootDir = await createFixture('<script type="module" src="/assets/app.js"></script>', { logo: false })

    await expect(validateDesktopRenderer({ rootDir })).rejects.toThrow('missing logo-mark.png')
  })
})
