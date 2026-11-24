import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { serveWorkspace } from './helpers/embeddedKit'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

/**
 * Kition serves a kit's checkpoints and view state (Kit UI protocol sections 7m and 7n) through the desktop shell's
 * document store and app data. No pinned kit package calls these capabilities yet, so the test speaks for the kit at
 * the host-call level: over the host channel the open Vector editor was handed, as a kit editor does. The shell is the
 * Playwright stand-in (`helpers/desktopHost.ts`); the store's own rules are tested in `src-tauri` (cases
 * kition.kits.checkpoints/store-rules and view-state-outside-workspace).
 */

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'vector-ui', 'engine')
const SDK_WASM = path.join(SDK_DIR, 'kition_vector_kit_bg.wasm')
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'vector-ui', 'kit-ui.json')

type NodeVectorSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  VectorDocument: { create(name: string, width: number, height: number): { save(): Uint8Array; execute(command: string, params: string): string; free(): void } }
}

async function drawingFixture() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_vector_kit.js')).href)) as NodeVectorSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  const doc = sdk.VectorDocument.create('Logo.kvector', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 20, y: 20, width: 80, height: 60 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

type Answer = { result?: Record<string, unknown>; error?: { code: number; message?: string; data?: { reason?: string } } }

/** Sends `method` from inside the kit's frame over the host channel it received with the handshake. */
async function fromKit(page: Page, method: string, params: Record<string, unknown>, bytes: Record<string, number[]> = {}): Promise<Answer> {
  const frame = page.frames().find((candidate) => candidate.url().includes('/kits/vector-ui/'))
  if (!frame) throw new Error('the Vector kit frame is not open')
  return frame.evaluate(async ({ method, params, bytes }) => {
    const port = (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort
    if (!port) throw new Error('the kit has no host channel')
    const id = `e2e-${method}-${Math.random()}`
    const buffers = Object.fromEntries(Object.entries(bytes).map(([key, values]) => [key, new Uint8Array(values).buffer]))
    return new Promise<Answer>((resolve) => {
      const answer = (event: MessageEvent) => {
        if (event.data?.id !== id) return
        port.removeEventListener('message', answer)
        // ArrayBuffers come back as their lengths.
        const result = event.data.result as Record<string, unknown> | undefined
        const plain = result && Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value instanceof ArrayBuffer ? { byteLength: value.byteLength } : value]))
        resolve({ ...(plain ? { result: plain } : {}), ...(event.data.error ? { error: event.data.error } : {}) })
      }
      port.addEventListener('message', answer)
      port.postMessage({ jsonrpc: '2.0', id, method, params: { ...params, ...buffers } })
    })
  }, { method, params, bytes })
}

test('a kit records, lists, renames, reads and deletes its checkpoints, and keeps view state outside the workspace', async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Vector kit is not built into public/kits/vector-ui')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Logo.kvector'), await drawingFixture())
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    // Every frame keeps the host channel it is handed, so the test can speak for the kit.
    await page.addInitScript(() => {
      window.addEventListener('message', (event) => {
        if ((event.data as { kitionKitUi?: number } | null)?.kitionKitUi === 1 && event.ports[0]) (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort = event.ports[0]
      })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Logo' }).first().click()
    const view = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(view.getByTestId('vector-status')).toContainText('objects', { timeout: 30_000 })

    // A replica write asks for a labelled checkpoint and is answered with it, the kit's own.
    const written = await fromKit(page, 'host/replicaWrite', { path: 'Logo.kvector', fileStamp: 'e2e', checkpoint: { label: 'Draft', description: 'For review' } }, { snapshot: [1, 2, 3], blobs: [] })
    expect(written.error).toBeUndefined()
    const checkpoint = written.result?.checkpoint as { id: string; origin: string; label: string; description: string; available: boolean }
    expect(checkpoint).toMatchObject({ origin: 'kit', label: 'Draft', description: 'For review', available: true })
    expect(host.calls.some((call) => call.command === 'write_document_store' && (call.args.request as { checkpoint?: { origin?: string } })?.checkpoint?.origin === 'kit')).toBe(true)

    // Listed (labelled ones, newest first), renamed, read, deleted.
    const listed = await fromKit(page, 'host/checkpointList', { path: 'Logo.kvector', labelled: true })
    expect(listed.result).toMatchObject({ checkpoints: [{ id: checkpoint.id, label: 'Draft' }], more: false })
    const renamed = await fromKit(page, 'host/checkpointUpdate', { path: 'Logo.kvector', id: checkpoint.id, label: 'Final', description: '' })
    expect(renamed.result?.checkpoint).toMatchObject({ id: checkpoint.id, label: 'Final' })
    expect(renamed.result?.checkpoint).not.toHaveProperty('description')
    const read = await fromKit(page, 'host/checkpointRead', { path: 'Logo.kvector', id: checkpoint.id })
    expect(read.error).toBeUndefined()
    expect(read.result).toMatchObject({ checkpoint: { id: checkpoint.id }, blobs: { byteLength: 0 } })
    expect((await fromKit(page, 'host/checkpointUpdate', { path: 'Logo.kvector', id: 'none', label: 'x' })).error).toMatchObject({ code: -32000, data: { reason: 'not-found' } })
    expect((await fromKit(page, 'host/checkpointList', { path: 'Logo.kvector', before: 'none' })).error).toMatchObject({ code: -32000, data: { reason: 'not-found' } })
    expect((await fromKit(page, 'host/checkpointUpdate', { path: 'Logo.kvector', id: checkpoint.id, label: 'x'.repeat(201) })).error).toMatchObject({ data: { reason: 'too-long' } })
    expect((await fromKit(page, 'host/checkpointDelete', { path: 'Logo.kvector', id: checkpoint.id })).error).toBeUndefined()
    expect((await fromKit(page, 'host/checkpointList', { path: 'Logo.kvector' })).result).toMatchObject({ checkpoints: [], more: false })
    // Only this editor's document.
    expect((await fromKit(page, 'host/checkpointList', { path: 'Other.kvector' })).error).toBeTruthy()

    // View state: kept in the app's data, never in the workspace, and read back whole.
    expect((await fromKit(page, 'host/viewStateWrite', { path: 'Logo.kvector', state: { v: 1, zoom: 2 } }, { bytes: [9, 8, 7] })).error).toBeUndefined()
    expect((await fromKit(page, 'host/viewStateRead', { path: 'Logo.kvector' })).result).toEqual({ state: { v: 1, zoom: 2 }, bytes: { byteLength: 3 } })
    const kept = await fs.readdir(path.join(host.dataDir, 'view-state'), { recursive: true })
    expect(kept.some((name) => String(name).endsWith('.bin'))).toBe(true)
    expect(host.calls.filter((call) => call.command === 'write_view_state')).toHaveLength(1)
    expect((await fromKit(page, 'host/viewStateWrite', { path: 'Logo.kvector', state: { text: 'x'.repeat(256 * 1024) } })).error).toMatchObject({ code: -32000, data: { reason: 'too-large' } })
    expect((await fromKit(page, 'host/viewStateWrite', { path: 'Logo.kvector', state: null })).error).toBeUndefined()
    expect((await fromKit(page, 'host/viewStateRead', { path: 'Logo.kvector' })).result).toEqual({ state: null })
  } finally {
    await host.dispose()
  }
})
