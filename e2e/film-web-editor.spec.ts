import fs from 'node:fs/promises'
import fsSync, { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'film-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_film_sdk_bg.wasm')
const CLIP = path.join(process.cwd(), 'e2e', 'fixtures', 'film', 'bars.mp4')

type FilmSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  FilmDocument: { create(name: string, width: number, height: number): { execute(command: string, params: string): string; save(): Uint8Array; free(): void } }
}

/**
 * A real project made by the same engine the page runs: films/Trailer.fcproj with
 * clips/bars.mp4 on V1, named relative to the project ("../clips/bars.mp4"). Node lends the
 * workspace the way Kition's worker does.
 */
async function projectFixture(root: string) {
  Object.assign(globalThis, { kitionHost: {
    size: (file: string) => fsSync.statSync(path.join(root, 'films', file)).size,
    readRange: (file: string, offset: number, length: number) => {
      const bytes = fsSync.readFileSync(path.join(root, 'films', file))
      return new Uint8Array(bytes.subarray(offset, offset + length))
    },
  } })
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_film_sdk.js')).href)) as FilmSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.FilmDocument.create('Trailer.fcproj', 320, 180)
  const imported = JSON.parse(doc.execute('file.import', JSON.stringify({ paths: ['../clips/bars.mp4'] }))) as { items: number[] }
  doc.execute('timeline.place', JSON.stringify({ item: imported.items[0], track: 'V1', seconds: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** Serves workspace files with HEAD and Range, as Kition's file server does. */
async function serveWorkspace(page: Page, root: string) {
  await page.route('**/workspace-files/**', async (route: Route) => {
    const request = route.request()
    const relative = decodeURIComponent(new URL(request.url()).pathname.replace(/^.*\/workspace-files\//, ''))
    const file = path.join(root, relative)
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    const bytes = await fs.readFile(file)
    const stat = await fs.stat(file)
    // As the runtime's file server: Last-Modified (readable across origins) and the same exposed headers.
    const headers = { 'accept-ranges': 'bytes', etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    const range = /bytes=(\d+)-(\d+)?/.exec(request.headers().range ?? '')
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'content-length': String(bytes.length) }, body: '' })
    if (range) {
      const start = Number(range[1])
      const end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1)
      return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) })
    }
    return route.fulfill({ status: 200, headers, body: bytes })
  })
}

/** The canvas pixel at the centre. */
function centre(page: Page) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  })
}

test('edits a video project in the page with the Film engine, reading its media from the workspace', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Film engine is not built into public/kits/film-sdk')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    await fs.mkdir(path.join(host.root, 'films'), { recursive: true })
    await fs.mkdir(path.join(host.root, 'clips'), { recursive: true })
    await fs.copyFile(CLIP, path.join(host.root, 'clips', 'bars.mp4'))
    await fs.writeFile(path.join(host.root, 'films', 'Trailer.fcproj'), await projectFixture(host.root))
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    // Headless browsers cannot hear: record the loudest sample of every sound scheduled on WebAudio.
    await page.addInitScript(() => {
      const peaks: number[] = []
      ;(window as unknown as { soundPeaks: number[] }).soundPeaks = peaks
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<AudioBufferSourceNode['start']>) {
        const data = this.buffer?.getChannelData(0) ?? new Float32Array()
        peaks.push(data.reduce((max, value) => Math.max(max, Math.abs(value)), 0))
        return start.apply(this, args)
      }
    })
    const saves: Buffer[] = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      saves.push(route.request().postDataBuffer() ?? Buffer.alloc(0))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'films' }).first().click()
    await page.locator('.document-tree-row', { hasText: 'Trailer' }).first().click()

    await expect(page.getByTestId('kit-status-bar')).toContainText('320 x 180 px', { timeout: 60_000 })
    await expect(page.getByTestId('film-track-Video 1')).toContainText('bars.mp4')
    // The first frame of the clip, decoded in the worker from ranged workspace reads.
    await expect.poll(() => centre(page), { timeout: 20_000 }).not.toEqual([243, 243, 246])
    await expect.poll(async () => (await centre(page))?.some((channel) => channel > 40)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('film-web-editor.png') })

    // Seek on the ruler, step a frame, and play.
    const ruler = (await page.getByTestId('film-ruler').boundingBox())!
    const clip = (await page.locator('[data-testid^="film-clip-"]').first().boundingBox())!
    await page.mouse.click(clip.x + clip.width / 2, ruler.y + ruler.height / 2)
    await expect(page.getByTestId('film-timecode')).not.toHaveText('00:00:00:00')
    const seeked = await page.getByTestId('film-timecode').textContent()
    await page.getByTestId('kit-editor').press('ArrowRight')
    await expect(page.getByTestId('film-timecode')).not.toHaveText(seeked!)
    await page.getByTestId('film-track-Audio 1').waitFor()
    await expect(page.getByTestId('film-track-Audio 1')).toContainText('bars.mp4')
    await page.getByTestId('film-play').click()
    await expect(page.getByTestId('film-stats')).toContainText('fps', { timeout: 10_000 })
    // The clip's tone, mixed by the engine and scheduled ahead of the picture.
    await expect.poll(() => page.evaluate(() => Math.max(0, ...(window as unknown as { soundPeaks: number[] }).soundPeaks)), { timeout: 10_000 }).toBeGreaterThan(0.05)
    await page.getByTestId('film-play').click()

    // Split at the playhead, delete the second half, undo.
    await page.mouse.click(clip.x + clip.width / 2, ruler.y + ruler.height / 2)
    await page.getByTestId('film-split').click()
    const clips = page.getByTestId('film-track-Video 1').locator('[data-testid^="film-clip-"]')
    await expect(clips).toHaveCount(2)
    await clips.nth(1).click()
    await page.getByTestId('kit-editor').press('Backspace')
    await expect(clips).toHaveCount(1)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(clips).toHaveCount(2)

    // Media from the workspace, placed at the playhead (over what was there, as Overwrite does).
    const ids = () => clips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
    const before = await ids()
    await page.getByTestId('film-add-media').click()
    await page.getByTestId('film-media-clips/bars.mp4').click()
    await expect.poll(async () => (await ids()).some((id) => !before.includes(id))).toBe(true)

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(saves).toHaveLength(1)
    if (canReadBlobBodies(browserName)) {
      const saved = saves[0].toString('utf8')
      expect(saved).toContain('"format":"filmcraft.project"')
      expect(saved).toContain('../clips/bars.mp4')
    }
  } finally {
    await host.dispose()
  }
})

test('creates a new video project from the create menu with the Film engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Film engine is not built into public/kits/film-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Untitled video.fcproj'), '{}')
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    const written: string[] = []
    // The runtime writes the new file; here the host's folder plays the workspace.
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path') ?? ''
      written.push(target)
      await fs.writeFile(path.join(host.root, target), route.request().postDataBuffer() ?? Buffer.alloc(0))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-video').click()

    // "Untitled video.fcproj" is taken, so the new project is numbered.
    await expect.poll(() => written).toEqual(['Untitled video 2.fcproj'])
    await expect(page.getByTestId('kit-status-bar')).toContainText('1920 x 1080 px', { timeout: 60_000 })
    await expect(page.getByTestId('film-track-Video 1')).toBeVisible()
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled video 2' })).toBeVisible()
    const saved = await fs.readFile(path.join(host.root, 'Untitled video 2.fcproj'), 'utf8')
    expect(saved).toContain('"format":"filmcraft.project"')
  } finally {
    await host.dispose()
  }
})

test('edits an mp4 through a video project and exports a new mp4, leaving the original as it was', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Film engine is not built into public/kits/film-sdk')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    await fs.mkdir(path.join(host.root, 'clips'), { recursive: true })
    const clip = path.join(host.root, 'clips', 'bars.mp4')
    await fs.copyFile(CLIP, clip)
    const original = await fs.readFile(clip)
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    const written: string[] = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path') ?? ''
      written.push(target)
      await fs.writeFile(path.join(host.root, target), route.request().postDataBuffer() ?? Buffer.alloc(0))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'clips' }).first().click()
    await page.locator('.document-tree-row', { hasText: 'bars' }).first().click()
    await page.getByTestId('film-edit-clip').click()

    // A project beside the clip, with the clip on a sequence of its own size, opened in Film.
    await expect.poll(() => written).toEqual(['clips/bars.fcproj'])
    await expect(page.getByTestId('kit-status-bar')).toContainText('160 x 90 px', { timeout: 60_000 })
    await expect(page.getByTestId('film-track-Video 1')).toContainText('bars.mp4')

    await page.getByTestId('film-export').click()
    await expect(page.getByText('Exported bars 2.mp4', { exact: true })).toBeVisible({ timeout: 90_000 })
    expect(written).toEqual(['clips/bars.fcproj', 'clips/bars 2.mp4'])
    const movie = await fs.readFile(path.join(host.root, 'clips', 'bars 2.mp4'))
    expect(movie.subarray(4, 8).toString()).toBe('ftyp')
    expect((await fs.readFile(clip)).equals(original)).toBe(true)
  } finally {
    await host.dispose()
  }
})

test('plays where a new audio context starts suspended, as in the desktop app (WebKit)', async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM), 'the Film engine is not built into public/kits/film-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    // WebKit starts a context suspended and runs it only after resume() in a gesture; playback
    // used to stop on its first frame there.
    await page.addInitScript(() => {
      const Native = window.AudioContext
      window.AudioContext = class extends Native {
        private resumed = false
        get state() {
          return (this.resumed ? super.state : 'suspended') as AudioContextState
        }
        resume() {
          this.resumed = true
          return super.resume()
        }
      } as typeof AudioContext
    })
    await fs.mkdir(path.join(host.root, 'films'), { recursive: true })
    await fs.mkdir(path.join(host.root, 'clips'), { recursive: true })
    await fs.copyFile(CLIP, path.join(host.root, 'clips', 'bars.mp4'))
    await fs.writeFile(path.join(host.root, 'films', 'Trailer.fcproj'), await projectFixture(host.root))
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'films' }).first().click()
    await page.locator('.document-tree-row', { hasText: 'Trailer' }).first().click()
    await expect(page.getByTestId('kit-status-bar')).toContainText('320 x 180 px', { timeout: 60_000 })
    await page.getByTestId('film-play').click()
    await expect(page.getByTestId('film-timecode')).not.toHaveText('00:00:00:00', { timeout: 5_000 })
    await expect(page.getByTestId('film-play')).toHaveAttribute('aria-label', 'Pause')
  } finally {
    await host.dispose()
  }
})
