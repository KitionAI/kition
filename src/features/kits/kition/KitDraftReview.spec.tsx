import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KitConnection } from '../host/mountKit'
import { KitDraftControls } from './KitDraftReview'
import { kitDraft, setKitDraft } from './kitDrafts'

const notices = vi.hoisted(() => [] as Array<[string, string]>)
vi.mock('@/lib/notify', () => ({
  notify: {
    success: (title: string) => notices.push(['success', title]),
    info: (title: string) => notices.push(['info', title]),
    error: (title: string) => notices.push(['error', title]),
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PATH = 'talks/Launch.pptx'
const summary = {
  created: [{ id: 's2', type: 'Slide', fields: ['shapes'] }],
  changed: [{ id: 'slide file', type: 'Presentation', fields: ['slides'] }],
  deleted: [],
  texts: [{ id: 'p1', field: 'text', before: 'Old title', after: 'New title' }],
}

function fakeConnection() {
  const draft = {
    state: vi.fn(),
    ready: vi.fn(),
    reopen: vi.fn(),
    compare: vi.fn(async () => ({ summary, before: 'QkVGT1JF', after: null })),
    merge: vi.fn(async () => {
      setKitDraft(PATH, { state: 'none', revision: null })
      return { merged: true, summary }
    }),
    discard: vi.fn(async () => {
      setKitDraft(PATH, { state: 'none', revision: null })
      return { state: 'none' as const, revision: null }
    }),
  }
  return { draft } as unknown as KitConnection & { draft: typeof draft }
}

let root: Root
let host: HTMLElement
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('the review of an agent draft of a kit document', () => {
  beforeEach(() => {
    notices.length = 0
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    setKitDraft(PATH, { state: 'none', revision: null })
  })

  it('shows nothing without a draft, a banner while the agent works, and the review once ready', async () => {
    const connection = fakeConnection()
    await act(async () => root.render(createElement(KitDraftControls, { connection, kitId: 'kit.slide', path: PATH, active: true })))
    expect(byTestId('kit-draft-banner')).toBeNull()
    await act(async () => setKitDraft(PATH, { state: 'open', revision: 1 }))
    expect(byTestId('kit-draft-banner')?.dataset.state).toBe('open')
    await act(async () => setKitDraft(PATH, { state: 'ready', revision: 2 }))
    expect(byTestId('kit-draft-banner')?.dataset.state).toBe('ready')

    await act(async () => byTestId('kit-draft-review')?.click())
    await vi.waitFor(() => expect(byTestId('kit-draft-summary')).not.toBeNull())
    expect(connection.draft.compare).toHaveBeenCalledWith({ maxSize: 640, schema: expect.objectContaining({ kit: 'kit.slide' }) })
    expect(byTestId('kit-draft-summary')?.textContent).toContain('1 object added')
    expect(byTestId('kit-draft-summary')?.textContent).toContain('1 object changed')
    expect(byTestId('kit-draft-before')?.querySelector('img')).not.toBeNull()
    expect(byTestId('kit-draft-after')?.querySelector('img')).toBeNull()
    expect(document.body.textContent).toContain('New title')

    // Merge is the person's: one click, recorded as the agent's edit on the person's behalf.
    await act(async () => byTestId('kit-draft-merge')?.click())
    await vi.waitFor(() => expect(connection.draft.merge).toHaveBeenCalled())
    await settle()
    expect(connection.draft.merge).toHaveBeenCalledWith({ kind: 'agent', principal: 'user:local', label: "Merged the agent's draft" }, expect.objectContaining({ kit: 'kit.slide' }))
    expect(notices).toEqual([['success', "Merged the agent's draft"]])
    expect(kitDraft(PATH).state).toBe('none')
    expect(byTestId('kit-draft-banner')).toBeNull()
    expect(byTestId('kit-draft-review-panel')).toBeNull()
  })

  it('discards from the banner and leaves the document alone', async () => {
    const connection = fakeConnection()
    await act(async () => root.render(createElement(KitDraftControls, { connection, kitId: 'kit.slide', path: PATH, active: true })))
    await act(async () => setKitDraft(PATH, { state: 'ready', revision: 2 }))
    await act(async () => byTestId('kit-draft-discard')?.click())
    await settle()
    expect(connection.draft.discard).toHaveBeenCalled()
    expect(connection.draft.merge).not.toHaveBeenCalled()
    expect(notices).toEqual([['info', "Discarded the agent's draft"]])
    expect(byTestId('kit-draft-banner')).toBeNull()
  })
})
