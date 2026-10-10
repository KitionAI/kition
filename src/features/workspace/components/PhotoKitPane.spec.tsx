import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KitsDocumentView } from '@/api/kits'
import { PhotoKitPane } from './PhotoKitPane'

const api = vi.hoisted(() => ({
  openKitDocument: vi.fn(),
  getKitDocument: vi.fn(),
  runKitCommand: vi.fn(),
  saveKitDocument: vi.fn(),
}))
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/kits', async () => {
  const actual = await vi.importActual<typeof import('@/api/kits')>('@/api/kits')
  return {
    ...actual,
    ...api,
    kitPreviewURL: (kitId: string, documentId: string, version: number) => `/preview/${kitId}/${documentId}?v=${version}`,
  }
})
vi.mock('@/services/desktop', () => ({ resolveApiURL: (path: string) => path, isDesktopRuntime: () => false }))
vi.mock('@/lib/notify', () => ({ notify: { success, error } }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function view(overrides: Partial<KitsDocumentView> = {}): KitsDocumentView {
  return {
    kitId: 'kit.photo',
    documentId: '7',
    path: 'art/cover.psd',
    title: 'cover.psd',
    format: 'psd',
    readOnly: false,
    dirty: false,
    canUndo: false,
    canRedo: false,
    version: 1,
    summary: '96 x 64 px, Rgb, 8-bit, 2 layers',
    details: {
      width: 96,
      height: 64,
      mode: 'Rgb',
      depth: 8,
      layers: [
        { name: 'Ink', kind: 'Pixel', visible: true },
        { name: 'Background', kind: 'Pixel', visible: false },
      ],
    },
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function render(active = true) {
  await act(async () => root.render(createElement(PhotoKitPane, { path: 'art/cover.psd', active })))
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const saveButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Save'))!

describe('PhotoKitPane', () => {
  it('opens the file in the kit and shows the preview, summary, and layers', async () => {
    api.openKitDocument.mockResolvedValue(view())
    await render()
    expect(api.openKitDocument).toHaveBeenCalledWith('art/cover.psd')
    expect(byTestId('photo-kit-preview')?.getAttribute('src')).toBe('/preview/kit.photo/7?v=1')
    expect(byTestId('photo-kit-summary')?.textContent).toBe('96 x 64 px, Rgb, 8-bit, 2 layers')
    expect(byTestId('photo-kit-layers')?.textContent).toContain('Ink')
    expect(byTestId('photo-kit-layers')?.textContent).toContain('Background')
    expect(button('Undo')?.disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
  })

  it('refreshes the preview when the agent changes the document', async () => {
    api.openKitDocument.mockResolvedValue(view())
    api.getKitDocument.mockResolvedValue(view({ version: 3, dirty: true, canUndo: true }))
    await render()
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(api.getKitDocument).toHaveBeenCalledWith('kit.photo', '7')
    expect(byTestId('photo-kit-preview')?.getAttribute('src')).toBe('/preview/kit.photo/7?v=3')
    expect(byTestId('photo-kit-unsaved')).not.toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('does not poll while the tab is in the background', async () => {
    api.openKitDocument.mockResolvedValue(view())
    await render(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(api.getKitDocument).not.toHaveBeenCalled()
  })

  it('undoes and saves through the kit', async () => {
    api.openKitDocument.mockResolvedValue(view({ dirty: true, canUndo: true }))
    api.runKitCommand.mockResolvedValue({ changed: true, result: null, document: view({ version: 2, dirty: true, canRedo: true }) })
    api.saveKitDocument.mockResolvedValue(view({ version: 2, dirty: false, canRedo: true }))
    await render()
    await act(async () => button('Undo')!.click())
    expect(api.runKitCommand).toHaveBeenCalledWith('kit.photo', '7', 'edit.undo')
    expect(button('Redo')?.disabled).toBe(false)
    await act(async () => saveButton().click())
    expect(api.saveKitDocument).toHaveBeenCalledWith('kit.photo', '7')
    expect(success).toHaveBeenCalledWith('Image saved')
    expect(byTestId('photo-kit-unsaved')).toBeNull()
  })

  it('explains when the Photo kit is not installed and retries', async () => {
    const notInstalled = Object.assign(new Error('Kition Photo is not installed. Set KITION_KIT_PHOTO_BINARY to a kit-photo build and restart Kition.'), {
      response: { status: 409, data: { code: 40901, data: { reason: 'not_installed' } } },
    })
    api.openKitDocument.mockRejectedValueOnce(notInstalled).mockResolvedValueOnce(view())
    await render()
    expect(byTestId('photo-kit-unavailable')?.textContent).toContain('Photo is not installed')
    expect(byTestId('photo-kit-unavailable')?.textContent).toContain('KITION_KIT_PHOTO_BINARY')
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again'))!
    await act(async () => retry.click())
    expect(byTestId('photo-kit-pane')).not.toBeNull()
  })
})
