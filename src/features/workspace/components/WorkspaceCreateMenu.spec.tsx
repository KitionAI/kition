import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('WorkspaceCreateMenu', () => {
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
})
