import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('WorkspaceCreateMenu', () => {
  it('groups every file type by what it is for, with Folder last', async () => {
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
        kitCreations: [
          { id: 'image', label: 'createMenu.format.image', kit: 'photo', group: 'visual', extension: 'psd', onCreate: vi.fn() },
          { id: 'slide', label: 'createMenu.format.slide', kit: 'slide', group: 'visual', extension: 'kitionslide', onCreate: vi.fn() },
          { id: 'spreadsheet', label: 'createMenu.format.spreadsheet', kit: 'sheet', group: 'data', extension: 'xlsx', onCreate: vi.fn() },
          { id: 'word', label: 'createMenu.format.word', kit: 'word', group: 'documents', extension: 'docx', onCreate: vi.fn() },
          { id: 'video', label: 'createMenu.format.video', kit: 'film', group: 'media', extension: 'kitionfilm', onCreate: vi.fn() },
        ],
      }))
    })

    const groups = Array.from(container.querySelectorAll('[role="group"]')).map((group) => ({
      label: group.getAttribute('aria-label'),
      items: Array.from(group.querySelectorAll('button')).map((button) => button.textContent?.trim()),
    }))
    // Kition's own types and the kits mix; portable formats show their extension.
    expect(groups).toEqual([
      { label: 'Documents', items: ['Document.md', 'Word document.docx'] },
      { label: 'Data', items: ['Table', 'Spreadsheet.xlsx'] },
      { label: 'Visual', items: ['Slides', 'Board', 'Image.psd'] },
      { label: 'Media', items: ['Video project'] },
    ])
    const options = Array.from(container.querySelectorAll('button'))
    expect(options.at(-1)?.textContent?.trim()).toBe('Folder')
    expect(options.some((button) => /import/i.test(button.textContent ?? ''))).toBe(false)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="workspace-create-board"]')?.click())
    expect(onCreateBoard).toHaveBeenCalledOnce()

    await act(async () => root?.unmount())
    container.remove()
  })

  it('leaves out a group with nothing to create in this build', async () => {
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
      }))
    })

    expect(Array.from(container.querySelectorAll('[role="group"]')).map((group) => group.getAttribute('aria-label'))).toEqual(['Documents', 'Data'])

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
        kitCreations: [{ id: 'video', label: 'createMenu.format.video', kit: 'film', group: 'media', extension: 'kitionfilm', onCreate: vi.fn() }],
      }))
    })

    const kits = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-kit-icon]'))
      .map((image) => image.dataset.kitIcon)
    expect(kits).toEqual(['document', 'table', 'board', 'design', 'film'])
    const sources = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-kit-icon]'))
      .map((image) => image.getAttribute('src'))
    expect(sources.every((src) => src?.endsWith('-small.svg'))).toBe(true)

    await act(async () => root?.unmount())
    container.remove()
  })
})
