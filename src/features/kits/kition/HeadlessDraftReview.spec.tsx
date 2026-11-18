import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KitsDraftComparison, KitsHeadlessDraft } from '@/api/kits'
import { HeadlessDraftBadge, HeadlessDraftReviewHost } from './HeadlessDraftReview'
import { refreshHeadlessDrafts, resetHeadlessDraftsForTest } from './headlessDrafts'

const PATH = 'reports/Budget.xlsx'

const api = vi.hoisted(() => ({
  drafts: [] as KitsHeadlessDraft[],
  comparison: null as KitsDraftComparison | null,
  stale: false,
  merged: [] as Array<{ path: string; overwrite: boolean }>,
  discarded: [] as string[],
}))
vi.mock('@/api/kits', () => ({
  listKitDrafts: async () => api.drafts,
  compareKitDraft: async () => api.comparison,
  mergeKitDraft: async (path: string, overwrite: boolean) => {
    if (api.stale && !overwrite) throw Object.assign(new Error('stale'), { response: { status: 409, data: { data: { reason: 'stale' } } } })
    api.merged.push({ path, overwrite })
    api.drafts = []
    return { path, merged: true, sha256: '0'.repeat(64) }
  },
  discardKitDraft: async (path: string) => {
    api.discarded.push(path)
    api.drafts = []
    return { path, discarded: true }
  },
  kitDraftRefusal: (error: unknown) => (error as { response?: { data?: { data?: { reason?: string } } } }).response?.data?.data?.reason ?? null,
}))

const open = vi.hoisted(() => ({ document: null as null | { dirty: boolean; fileChanged: (version: string) => void } }))
vi.mock('./kitConnections', () => ({
  mountedKitDocument: () =>
    open.document ? { path: PATH, kitId: 'kit.sheet', connection: { state: async () => ({ dirty: open.document!.dirty, revision: 1, title: '' }), fileChanged: open.document.fileChanged } } : null,
}))
vi.mock('./kitionHost', () => ({ KITION_KIT_HOST: { stamp: async () => 'stamp-2' } }))

const notices = vi.hoisted(() => [] as Array<[string, string, string | undefined]>)
vi.mock('@/lib/notify', () => ({
  notify: {
    success: (title: string, options?: { description?: string }) => notices.push(['success', title, options?.description]),
    info: (title: string) => notices.push(['info', title, undefined]),
    error: (title: string, options?: { description?: string }) => notices.push(['error', title, options?.description]),
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function draft(overrides: Partial<KitsHeadlessDraft> = {}): KitsHeadlessDraft {
  return { version: 1, path: PATH, kit: 'kit.sheet', mode: 'replica', state: 'ready', baseSha256: 'a'.repeat(64), created: 1, updated: 1, stale: false, ...overrides }
}

const comparison: KitsDraftComparison = {
  path: PATH,
  kit: 'kit.sheet',
  mode: 'replica',
  state: 'ready',
  stale: false,
  diff: { created: [{ id: 'c1', type: 'Cell', fields: ['value'] }], changed: [], deleted: [], texts: [{ id: 'c1', field: 'value', before: '', after: 'Q3' }] },
  summary: { base: '1 sheet', draft: '1 sheet, 1 cell more' },
  previews: { base: 'QkFTRQ==' },
}

let root: Root
let host: HTMLElement
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function render() {
  await act(async () => root.render(createElement(Fragment, null, createElement(HeadlessDraftBadge, { path: PATH }), createElement(HeadlessDraftReviewHost))))
  await act(async () => refreshHeadlessDrafts())
}

describe('headless drafts in the workspace', () => {
  beforeEach(() => {
    Object.assign(api, { drafts: [draft()], comparison, stale: false, merged: [], discarded: [] })
    open.document = null
    notices.length = 0
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    resetHeadlessDraftsForTest()
  })

  it('marks a file with a draft and opens its review: both sides and what the merge adds', async () => {
    await render()
    const badge = byTestId('headless-draft-badge')
    expect(badge?.dataset.state).toBe('ready')
    await act(async () => badge?.click())
    await vi.waitFor(() => expect(byTestId('headless-draft-summary')).not.toBeNull())
    expect(byTestId('headless-draft-summary')?.textContent).toContain('1 object added')
    expect(byTestId('headless-draft-before')?.querySelector('img')).not.toBeNull()
    expect(byTestId('headless-draft-after')?.textContent).toContain('1 cell more')
    expect(document.body.textContent).toContain('Q3')
    expect(byTestId('headless-draft-stale')).toBeNull()
  })

  it('merges as the person decides, and a clean open editor reloads the file', async () => {
    const fileChanged = vi.fn()
    open.document = { dirty: false, fileChanged }
    await render()
    await act(async () => byTestId('headless-draft-badge')?.click())
    await vi.waitFor(() => expect((byTestId('headless-draft-merge') as HTMLButtonElement | null)?.disabled).toBe(false))
    await act(async () => byTestId('headless-draft-merge')?.click())
    await vi.waitFor(() => expect(api.merged).toEqual([{ path: PATH, overwrite: false }]))
    expect(fileChanged).toHaveBeenCalledWith('stamp-2')
    await vi.waitFor(() => expect(byTestId('headless-draft-review')).toBeNull())
    expect(byTestId('headless-draft-badge')).toBeNull()
    expect(notices[0]?.[0]).toBe('success')
  })

  it('asks before a merge would replace edits made to the file since the draft forked', async () => {
    api.stale = true
    await render()
    await act(async () => byTestId('headless-draft-badge')?.click())
    await vi.waitFor(() => expect((byTestId('headless-draft-merge') as HTMLButtonElement | null)?.disabled).toBe(false))
    await act(async () => byTestId('headless-draft-merge')?.click())
    await vi.waitFor(() => expect(byTestId('headless-draft-overwrite')).not.toBeNull())
    expect(byTestId('headless-draft-stale')).not.toBeNull()
    expect(api.merged).toEqual([])
    await act(async () => byTestId('headless-draft-overwrite')?.click())
    await vi.waitFor(() => expect(api.merged).toEqual([{ path: PATH, overwrite: true }]))
  })

  it('never replaces unsaved edits in an open editor', async () => {
    open.document = { dirty: true, fileChanged: vi.fn() }
    await render()
    await act(async () => byTestId('headless-draft-badge')?.click())
    await vi.waitFor(() => expect((byTestId('headless-draft-merge') as HTMLButtonElement | null)?.disabled).toBe(false))
    await act(async () => byTestId('headless-draft-merge')?.click())
    await vi.waitFor(() => expect(notices.some(([level]) => level === 'error')).toBe(true))
    expect(notices.find(([level]) => level === 'error')?.[2]).toContain('unsaved edits')
    expect(api.merged).toEqual([])
    expect(byTestId('headless-draft-review')).not.toBeNull()
  })

  it('discards the draft and leaves the file', async () => {
    await render()
    await act(async () => byTestId('headless-draft-badge')?.click())
    await act(async () => byTestId('headless-draft-discard')?.click())
    await vi.waitFor(() => expect(api.discarded).toEqual([PATH]))
    expect(api.merged).toEqual([])
    await vi.waitFor(() => expect(byTestId('headless-draft-badge')).toBeNull())
  })

  it('says when the kit compares by summary and preview only', async () => {
    api.comparison = { ...comparison, mode: 'file', diff: null, diffUnavailable: 'a copy of the file has no replica history to compare' }
    await render()
    await act(async () => byTestId('headless-draft-badge')?.click())
    await vi.waitFor(() => expect(byTestId('headless-draft-no-diff')).not.toBeNull())
  })
})
