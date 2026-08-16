import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { AgentContextAddMenu } from './AgentContextAddMenu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentContextAddMenu', () => {
  it('puts the current document beside the other context sources', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onAddCurrentDocument = vi.fn()
    const onAddLocalSource = vi.fn()
    const onRequestDocumentReference = vi.fn()

    await act(async () => root.render(createElement(AgentContextAddMenu, {
      currentDocumentTitle: 'Project plan',
      localSourceCount: 0,
      onAddCurrentDocument,
      onAddLocalSource,
      onRequestDocumentReference,
    })))

    const trigger = container.querySelector<HTMLButtonElement>('.agent-context-add__trigger')
    expect(trigger?.getAttribute('aria-label')).toBe('Add context')
    expect(trigger?.textContent).toBe('')

    await act(async () => trigger?.click())
    const menuItems = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect(menuItems).toHaveLength(3)
    expect(menuItems[0]?.textContent).toContain('Add current document · Project plan')
    expect(menuItems[0]?.textContent).toContain('Reference in this turn')
    expect(menuItems[1]?.textContent).toContain('Local folder')
    expect(menuItems[1]?.textContent).toContain('Read only')
    expect(menuItems[2]?.textContent).toContain('Workspace document')
    expect(menuItems[2]?.textContent).toContain('Reference in this turn')
    expect(container.textContent).not.toContain('Upload file')

    await act(async () => menuItems[0]?.click())
    expect(onAddCurrentDocument).toHaveBeenCalledOnce()

    await act(async () => trigger?.click())
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]?.click()
    })
    expect(onAddLocalSource).toHaveBeenCalledOnce()

    await act(async () => trigger?.click())
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]?.click()
    })
    expect(onRequestDocumentReference).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })

  it('marks the current document as attached and prevents duplicate context', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onAddCurrentDocument = vi.fn()

    await act(async () => root.render(createElement(AgentContextAddMenu, {
      currentDocumentTitle: 'Project plan',
      currentDocumentAttached: true,
      localSourceCount: 0,
      onAddCurrentDocument,
      onRequestDocumentReference: vi.fn(),
    })))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.agent-context-add__trigger')?.click()
    })
    const currentDocumentItem = container.querySelector<HTMLButtonElement>('[role="menuitem"]')
    expect(currentDocumentItem?.disabled).toBe(true)
    expect(currentDocumentItem?.textContent).toContain('Attached')
    expect(onAddCurrentDocument).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    container.remove()
  })
})
