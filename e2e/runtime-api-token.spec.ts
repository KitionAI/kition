import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

/**
 * Kit frame isolation, phase 1 (contracts/runtime/transport.schema.json): the runtime answers only
 * callers holding this launch's API token. The first test runs Kition with a token as the desktop
 * shell hands it over and checks where it goes; the second attacks a real runtime from another
 * page on this machine (scripts/inspect-api-token.sh builds it and sets KITION_E2E_RUNTIME_BINARY).
 */

const TOKEN = 'e2e-launch-token-0123456789abcdef'
const BACKEND = 'http://127.0.0.1:18101'

type NodePhotoDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const photo = kitEngine<{ PhotoDocument: { create(name: string, width: number, height: number): NodePhotoDocument } }>('photo', 'kition_photo_sdk')

async function posterFixture() {
  const sdk = await photo.load()
  const doc = sdk.PhotoDocument.create('Poster.psd', 240, 160)
  doc.execute('layer.new.layer', JSON.stringify({ name: 'Ink' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** String values reachable from `window`'s own properties, one level deep, as JSON where possible. */
async function windowText(page: Page | ReturnType<Page['frames']>[number]) {
  return page.evaluate(() => {
    const target = window as unknown as Record<string, unknown>
    return Object.getOwnPropertyNames(window).map((name) => {
      try {
        const value = target[name]
        if (typeof value === 'string') return value
        if (value && typeof value === 'object' && !(value instanceof Node) && value !== window) return JSON.stringify(value)
      } catch {
        // Cross-origin or circular: nothing a script could read as text either.
      }
      return ''
    }).join('\n')
  })
}

test('Kition sends its launch token to the runtime only, and hands kits signed URLs instead', async ({ page, baseURL }) => {
  test.skip(!photo.built, 'the Photo kit editor is not built into public/kits/photo-ui')
  test.setTimeout(120_000)
  const requests: Request[] = []
  page.on('request', (request) => requests.push(request))
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await posterFixture(), {}, { desktop: { apiToken: TOKEN } })
  try {
    await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })

    // The token left `window` as the renderer loaded: neither Kition's page nor the kit's frame
    // finds it there, nor in the desktop globals.
    expect(await page.evaluate(() => '__KITION_API_TOKEN__' in window)).toBe(false)
    expect(await windowText(page)).not.toContain(TOKEN)
    const kitFrame = page.frames().find((frame) => frame.url().includes('/kits/'))
    expect(kitFrame).toBeTruthy()
    expect(await windowText(kitFrame!)).not.toContain(TOKEN)
    expect(await kitFrame!.evaluate(() => (window.parent as unknown as Record<string, unknown>).__KITION_API_TOKEN__ ?? null)).toBeNull()

    // Every request to the runtime carried the token or was signed; no URL carries the token.
    const toRuntime = requests.filter((request) => request.url().startsWith(BACKEND))
    expect(toRuntime.length).toBeGreaterThan(0)
    for (const request of requests) expect(request.url(), request.url()).not.toContain(TOKEN)
    for (const request of toRuntime) {
      const url = new URL(request.url())
      if (url.pathname === '/health') continue
      const headers = await request.allHeaders()
      const signed = url.pathname.startsWith('/_signed/')
      expect(signed || headers['kition-token'] === TOKEN, `${request.method()} ${request.url()}`).toBe(true)
      if (signed) expect(['GET', 'HEAD']).toContain(request.method())
    }
    // Kition read the document through a signed file URL.
    expect(toRuntime.some((request) => /^\/_signed\/\d+\.\d+\.[0-9a-f]{64}\/workspace-files\/Poster\.psd$/.test(new URL(request.url()).pathname))).toBe(true)
    // Requests with a body (Kition's own API calls) never travel as signed URLs.
    expect(toRuntime.filter((request) => request.method() !== 'GET' && request.method() !== 'HEAD').every((request) => !request.url().includes('/_signed/'))).toBe(true)
  } finally {
    await host.dispose()
  }
})

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

test.describe('a real runtime', () => {
  const binary = process.env.KITION_E2E_RUNTIME_BINARY || ''
  let runtime: ChildProcess | null = null
  let dir = ''
  let api = ''

  test.beforeAll(async () => {
    if (!binary || !existsSync(binary)) return
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-api-token-'))
    const port = await freePort()
    api = `http://127.0.0.1:${port}`
    const workspace = path.join(dir, 'workspace')
    await fs.mkdir(path.join(workspace, '.kition', 'docs'), { recursive: true })
    await fs.mkdir(path.join(workspace, 'art'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.kition', 'docs', 'index.json'), '{"store":"private"}')
    await fs.writeFile(path.join(workspace, 'art', 'note.txt'), 'the note')
    const config = path.join(dir, 'runtime.toml')
    await fs.writeFile(config, [
      '[app]', 'name = "Kition API token e2e"', 'version = "0.0.0-e2e"', 'apiPrefix = "/api/v1"', 'jwtSecret = "e2e"', 'disableAuth = true', 'autoMigrate = true', 'autoSeed = true',
      '[server.http]', `port = ${port}`,
      '[sqlite]', `path = ${JSON.stringify(path.join(dir, 'data', 'runtime.db'))}`,
      '[storage]', `uploadDir = ${JSON.stringify(path.join(dir, 'uploads'))}`, `workspaceDir = ${JSON.stringify(workspace)}`,
      '[logger.default]', 'level = "error"',
    ].join('\n'))
    const env = { ...process.env }
    delete env.KITION_API_TOKEN_FILE
    runtime = spawn(binary, ['--config', config, 'all'], { env, stdio: 'ignore' })
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const healthy = await fetch(`${api}/health`).then((response) => response.ok, () => false)
      if (healthy && existsSync(path.join(dir, 'data', 'api-token'))) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('the runtime did not start')
  })

  test.afterAll(async () => {
    runtime?.kill()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  test('another page on this machine can neither read the API nor act through it', async ({ page, baseURL }) => {
    test.skip(!binary || !existsSync(binary), 'KITION_E2E_RUNTIME_BINARY names no runtime (scripts/inspect-api-token.sh builds one)')
    const token = (await fs.readFile(path.join(dir, 'data', 'api-token'), 'utf8')).trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') expect((await fs.stat(path.join(dir, 'data', 'api-token'))).mode & 0o777).toBe(0o600)
    const pwned = path.join(dir, 'pwned')
    const hook = JSON.stringify({ name: 'x', event: 'session_started', matcher: '', workdir: '', command: `touch ${pwned}`, timeout_seconds: 5, enabled: true })

    // A page served from another local port: the development server here.
    await page.goto(new URL('/logo-mark.png', baseURL).toString())
    const attempts = await page.evaluate(async ({ api, hook }) => {
      const attempt = async (url: string, init?: RequestInit) => {
        try {
          const response = await fetch(url, init)
          return `${response.type}:${response.status}:${await response.text().catch(() => '')}`
        } catch (error) {
          return `blocked:${(error as Error).name}`
        }
      }
      const image = (url: string) => new Promise<string>((resolve) => {
        const img = new Image()
        img.onload = () => resolve('loaded')
        img.onerror = () => resolve('error')
        img.src = url
      })
      return {
        createHook: await attempt(`${api}/api/v1/desktop/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'kition-token': 'guess' }, body: hook }),
        createHookFormPost: await attempt(`${api}/api/v1/desktop/hooks`, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: hook }),
        triggerHooks: await attempt(`${api}/api/v1/desktop/hooks/lifecycle`, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{"event":"session_started"}' }),
        store: await attempt(`${api}/workspace-files/.kition/docs/index.json`),
        storeNoCors: await attempt(`${api}/workspace-files/.kition/docs/index.json`, { mode: 'no-cors' }),
        save: await attempt(`${api}/api/v1/kits/files?path=art/note.txt&document=art/note.txt`, { method: 'PUT', body: 'overwritten' }),
        runtime: await attempt(`${api}/api/v1/desktop/runtime`),
        health: await attempt(`${api}/health`),
        storeImage: await image(`${api}/workspace-files/.kition/docs/index.json`),
      }
    }, { api, hook })

    // Nothing readable: CORS refuses this origin, so even the open health probe answers it nothing.
    for (const key of ['createHook', 'store', 'save', 'runtime', 'health'] as const) expect(attempts[key], key).toBe('blocked:TypeError')
    // Requests a page may send blind reach the runtime opaque, and are refused there.
    for (const key of ['createHookFormPost', 'triggerHooks', 'storeNoCors'] as const) expect(attempts[key], key).toBe('opaque:0:')
    expect(attempts.storeImage).toBe('error')
    expect(JSON.stringify(attempts)).not.toContain(token)

    // Nothing changed. The token holder sees no hook, the file as it was, and no command ran.
    const hooks = await fetch(`${api}/api/v1/desktop/hooks`, { headers: { 'Kition-Token': token } }).then((response) => response.json() as Promise<{ data: { items: unknown[] } }>)
    expect(hooks.data.items).toEqual([])
    expect(await fs.readFile(path.join(dir, 'workspace', 'art', 'note.txt'), 'utf8')).toBe('the note')
    expect(existsSync(pwned)).toBe(false)

    // Without a browser's origin rules: no token, a wrong one, or the right one from another origin.
    const refused = await Promise.all([
      fetch(`${api}/api/v1/desktop/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: hook }),
      fetch(`${api}/api/v1/desktop/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'kition-token': token.replace(/.$/, (last) => (last === '0' ? '1' : '0')) }, body: hook }),
      fetch(`${api}/api/v1/desktop/hooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'kition-token': token, origin: 'http://localhost:5555' }, body: hook }),
      fetch(`${api}/workspace-files/.kition/docs/index.json`),
    ])
    expect(refused.map((response) => response.status)).toEqual([401, 401, 403, 401])
    expect((await fetch(`${api}/api/v1/desktop/hooks`, { headers: { 'Kition-Token': token } }).then((response) => response.json() as Promise<{ data: { items: unknown[] } }>)).data.items).toEqual([])
  })
})
