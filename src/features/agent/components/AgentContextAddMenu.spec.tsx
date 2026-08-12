import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { AgentContextAddMenu } from './AgentContextAddMenu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentContextAddMenu', () => {
  it('opens the compact local-folder and workspace-document menu', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onAddLocalSource = vi.fn()
    const onRequestDocumentReference = vi.fn()

    await act(async () => root.render(createElement(AgentContextAddMenu, {
      localSourceCount: 0,
      onAddLocalSource,
      onRequestDocumentReference,
    })))

    const trigger = container.querySelector<HTMLButtonElement>('.agent-context-add__trigger')
    expect(trigger?.getAttribute('aria-label')).toBe('Add context')
    expect(trigger?.textContent).toBe('')

    await act(async () => trigger?.click())
    const menuItems = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect(menuItems).toHaveLength(2)
    expect(menuItems[0]?.textContent).toContain('Local folder')
    expect(menuItems[0]?.textContent).toContain('Read only')
    expect(menuItems[1]?.textContent).toContain('Workspace document')
    expect(menuItems[1]?.textContent).toContain('Reference in this turn')
    expect(container.textContent).not.toContain('Upload file')

    await act(async () => menuItems[0]?.click())
    expect(onAddLocalSource).toHaveBeenCalledOnce()

    await act(async () => trigger?.click())
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]?.click()
    })
    expect(onRequestDocumentReference).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })
})
