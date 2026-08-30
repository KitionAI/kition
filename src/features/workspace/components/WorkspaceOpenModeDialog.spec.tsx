import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceOpenModeDialog } from './WorkspaceOpenModeDialog'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('WorkspaceOpenModeDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers current-window and new-window actions', async () => {
    const onOpenCurrent = vi.fn()
    const onOpenNew = vi.fn()

    await act(async () => {
      root.render(createElement(WorkspaceOpenModeDialog, {
        open: true,
        workspaceName: 'Research',
        workspacePath: '/Users/alice/projects/research',
        onOpenChange: vi.fn(),
        onOpenCurrent,
        onOpenNew,
      }))
    })

    const currentButton = document.querySelector<HTMLButtonElement>('[data-testid="workspace-open-current"]')
    const newButton = document.querySelector<HTMLButtonElement>('[data-testid="workspace-open-new"]')
    expect(currentButton).not.toBeNull()
    expect(newButton).not.toBeNull()

    await act(async () => {
      currentButton?.click()
      newButton?.click()
    })

    expect(onOpenCurrent).toHaveBeenCalledOnce()
    expect(onOpenNew).toHaveBeenCalledOnce()
  })
})
