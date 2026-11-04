import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { expect, it } from 'vitest'

it('watches source files without scanning Rust builds and test artifacts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kition-vite-watch-')))
  const artifacts = ['target', 'src-tauri/target', 'test-results', 'playwright-report']
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('tooling/vite.config.ts'))
  expect(loaded).not.toBeNull()
  for (const dir of ['src', ...artifacts]) {
    await mkdir(join(root, dir), { recursive: true })
    await writeFile(join(root, dir, 'fixture.ts'), 'export const fixture = 1\n')
  }
  const server = await createServer({
    ...loaded!.config,
    configFile: false,
    root,
    publicDir: false,
    plugins: [],
    cacheDir: join(root, 'node_modules/.vite'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...loaded!.config.server, proxy: {}, middlewareMode: true },
  })
  try {
    await new Promise<void>((done) => server.watcher.once('ready', done))
    const watched = server.watcher.getWatched()
    const changed: string[] = []
    server.watcher.on('change', (file) => changed.push(file))
    await writeFile(join(root, 'src/fixture.ts'), 'export const fixture = 2\n')
    await expect.poll(() => changed).toContain(join(root, 'src/fixture.ts'))
    for (const dir of artifacts) expect(watched[join(root, dir)], dir).toBeUndefined()
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
