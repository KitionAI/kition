import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('WorkspaceCreateMenu', () => {
  it('places the Board entry after Table', async () => {
    const { WorkspaceCreateMenu } = await import('./WorkspaceCreateMenu')
    const onCreateBoard = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WorkspaceCreateMenu, {
        open: true,
        onCreateDocument: vi.fn(),
        onCreateFolder: vi.fn(),
        onCreateTable: vi.fn(),
        onCreateBoard,
        onImportTableFile: vi.fn(),
      }))
    })

    const options = Array.from(container.querySelectorAll('button'))
    expect(options.map((button) => button.textContent?.trim())).toEqual([
      'Document',
      'Table',
      'Board',
      'Import spreadsheet',
      'Folder',
    ])
    await act(async () => options[2].click())
    expect(onCreateBoard).toHaveBeenCalledOnce()

    await act(async () => root?.unmount())
    container.remove()
  })

  it('exposes the spreadsheet-to-Kitable entry point', async () => {
    const { WorkspaceCreateMenu } = await import('./WorkspaceCreateMenu')
    const onImportTableFile = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WorkspaceCreateMenu, {
        open: true,
        onCreateDocument: vi.fn(),
        onCreateFolder: vi.fn(),
        onCreateTable: vi.fn(),
        onImportTableFile,
      }))
    })

    const importButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Import spreadsheet') as HTMLButtonElement
    expect(importButton).toBeTruthy()
    await act(async () => importButton.click())
    expect(onImportTableFile).toHaveBeenCalledOnce()

    await act(async () => root?.unmount())
    container.remove()
  })

  it('shows kit icons for the kits it creates', async () => {
    const { WorkspaceCreateMenu } = await import('./WorkspaceCreateMenu')
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WorkspaceCreateMenu, {
        open: true,
        onCreateDocument: vi.fn(),
        onCreateFolder: vi.fn(),
        onCreateTable: vi.fn(),
        onCreateBoard: vi.fn(),
        onCreateDesign: vi.fn(),
        kitCreations: [{ id: 'video', label: 'createMenu.format.video', kit: 'film', onCreate: vi.fn() }],
      }))
    })

    const kits = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-kit-icon]'))
      .map((image) => image.dataset.kitIcon)
    expect(kits).toEqual(['document', 'table', 'film', 'design', 'board'])

    await act(async () => root?.unmount())
    container.remove()
  })
})
