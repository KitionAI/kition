import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setDocumentSchemaNotice } from '@/services/documentSchema'
import { DocumentSchemaBanner } from './DocumentSchemaBanner'

const updates = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(async () => undefined),
  installUpdate: vi.fn(async () => undefined),
}))
vi.mock('@/services/desktopUpdates', () => updates)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  setDocumentSchemaNotice('Slide.kitionslide', null)
})

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<DocumentSchemaBanner path="Slide.kitionslide" kitName="Slide" kitVersion="0.5.0" />))
  return container
}

const banner = () => container!.querySelector<HTMLElement>('[data-testid="document-schema-banner"]')

describe('DocumentSchemaBanner', () => {
  it('shows nothing while the document needs no newer kit', async () => {
    await render()
    expect(banner()).toBeNull()
  })

  it('says a newer kit edited the document, that it stays read-only, and which versions differ', async () => {
    await render()
    await act(async () => setDocumentSchemaNotice('Slide.kitionslide', { kit: 'kit.slide', needs: 4, reads: 3, blocked: true }))
    expect(banner()?.dataset.blocked).toBe('true')
    expect(banner()?.textContent).toContain('This document was edited with a newer Slide. Update to keep editing.')
    expect(banner()?.textContent).toContain('read-only here')
    expect(container!.querySelector('[data-testid="document-schema-versions"]')?.textContent).toBe(
      'This Kition has Slide 0.5.0, which reads documents up to version 3; this one needs version 4.',
    )
  })

  it('checks for an update and installs the one available', async () => {
    updates.checkForUpdates.mockResolvedValueOnce({ phase: 'available', version: '0.2.0' })
    await render()
    await act(async () => setDocumentSchemaNotice('Slide.kitionslide', { kit: 'kit.slide', needs: 4, reads: 3, blocked: false }))
    expect(banner()?.textContent).toContain('cannot be edited here')
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="document-schema-check"]')!.click())
    expect(container!.querySelector('[data-testid="document-schema-update-outcome"]')?.textContent).toBe('Kition 0.2.0 is available.')
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="document-schema-install"]')!.click())
    expect(updates.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updates.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('says to update Kition where it cannot update itself', async () => {
    updates.checkForUpdates.mockResolvedValueOnce({ phase: 'unsupported', reason: 'web preview' })
    await render()
    await act(async () => setDocumentSchemaNotice('Slide.kitionslide', { kit: 'kit.slide', needs: Number.NaN, reads: Number.NaN, blocked: true }))
    expect(container!.querySelector('[data-testid="document-schema-versions"]')).toBeNull()
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="document-schema-check"]')!.click())
    expect(container!.querySelector('[data-testid="document-schema-update-outcome"]')?.textContent).toBe('Update Kition to its latest version to keep editing.')
  })
})
