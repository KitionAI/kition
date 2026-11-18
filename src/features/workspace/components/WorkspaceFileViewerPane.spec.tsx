import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceFileViewerPane } from './WorkspaceFileViewerPane'

const { copyImage, success, error } = vi.hoisted(() => ({
  copyImage: vi.fn(), success: vi.fn(), error: vi.fn(),
}))
vi.mock('@/services/desktop', () => ({
  copyImageToClipboard: copyImage, openWorkspaceFile: vi.fn(), revealWorkspaceFolder: vi.fn(),
}))
vi.mock('@/services/workspaceFiles', () => ({
  resolveWorkspaceFileURL: (path: string) => `/workspace-files/${path.split('/').map(encodeURIComponent).join('/')}`,
}))
vi.mock('@/lib/notify', () => ({ notify: { success, error } }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const imagePath = 'Agent/images/Generated preview.png'

beforeEach(() => {
  vi.clearAllMocks()
  copyImage.mockResolvedValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(active = true) {
  await act(async () => root.render(createElement(WorkspaceFileViewerPane, { path: imagePath, format: 'image', active })))
}
async function openMenu() {
  await act(async () => container.querySelector('img')!.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }),
  ))
}
async function selectCopy() {
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
}

describe('WorkspaceFileViewerPane image clipboard', () => {
  it('copies the resolved image through the clipboard service and restores focus after selecting the menu item', async () => {
    await render()
    await openMenu()
    expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('Copy image')
    await selectCopy()
    expect(copyImage).toHaveBeenCalledWith('/workspace-files/Agent/images/Generated%20preview.png')
    expect(success).toHaveBeenCalledWith('Image copied')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('img'))
  })

  it.each([false, new Error('Clipboard is unavailable')])('reports an unsuccessful clipboard write and allows retrying: %s', async (failure) => {
    if (failure instanceof Error) copyImage.mockRejectedValueOnce(failure)
    else copyImage.mockResolvedValueOnce(failure)
    await render()
    await openMenu()
    await selectCopy()
    expect(success).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('Could not copy image', expect.any(Object))
    await openMenu()
    await selectCopy()
    expect(success).toHaveBeenCalledWith('Image copied')
  })

  it('dismisses the menu on Escape or when its image tab becomes inactive', async () => {
    await render()
    await act(async () => container.querySelector('img')!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }),
    ))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
    expect(document.activeElement).toBe(container.querySelector('img'))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await openMenu()
    await render(false)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(copyImage).not.toHaveBeenCalled()
  })
})
