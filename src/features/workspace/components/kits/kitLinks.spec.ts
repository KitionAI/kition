import { describe, expect, it, vi } from 'vitest'
import { openKitLink, resolveKitLink, type KitLinkOpener } from './kitLinks'

const FILES = ['notes/Plan.md', 'notes/plan.ktable', 'Plan.md', 'archive/Plan.md', 'Guides/Guide one.md', '.kition/Plan.md', 'pictures/a.png']

describe('resolveKitLink', () => {
  it('resolves a path from the document’s folder, or from the root with a leading slash', () => {
    expect(resolveKitLink({ path: 'Plan.md' }, 'notes/Today.md', FILES)).toEqual({ path: 'notes/Plan.md', exists: true })
    expect(resolveKitLink({ path: '../Guides/Guide one.md' }, 'notes/Today.md', FILES)).toEqual({ path: 'Guides/Guide one.md', exists: true })
    expect(resolveKitLink({ path: '/pictures/a.png' }, 'notes/Today.md', FILES)).toEqual({ path: 'pictures/a.png', exists: true })
    expect(resolveKitLink({ path: 'New.md' }, 'notes/Today.md', FILES)).toEqual({ path: 'notes/New.md', exists: false })
  })

  it('refuses a path above the workspace, in a hidden folder, or an id alone', () => {
    expect(resolveKitLink({ path: '../../outside.md' }, 'notes/Today.md', FILES)).toBeNull()
    expect(resolveKitLink({ path: '/.kition/Plan.md' }, 'notes/Today.md', FILES)).toBeNull()
    expect(resolveKitLink({ docId: 'd1' }, 'notes/Today.md', FILES)).toBeNull()
    expect(resolveKitLink({ name: '../Plan' }, 'notes/Today.md', FILES)).toBeNull()
  })

  it('finds a name beside the document and of its extension first, never in a hidden folder', () => {
    expect(resolveKitLink({ name: 'Plan' }, 'notes/Today.md', FILES)).toEqual({ path: 'notes/Plan.md', exists: true })
    expect(resolveKitLink({ name: 'plan' }, 'Today.md', FILES)).toEqual({ path: 'Plan.md', exists: true })
    expect(resolveKitLink({ name: 'Plan' }, 'other/Today.ktable', FILES)).toEqual({ path: 'notes/plan.ktable', exists: true })
    expect(resolveKitLink({ name: 'Ideas' }, 'notes/Today.md', FILES)).toEqual({ path: 'notes/Ideas.md', exists: false })
    expect(resolveKitLink({ name: 'Plan' }, 'notes/Today.md', ['.kition/Plan.md'])).toEqual({ path: 'notes/Plan.md', exists: false })
  })
})

describe('openKitLink', () => {
  const opener = (overrides: Partial<KitLinkOpener> = {}): KitLinkOpener & { opened: unknown[] } => {
    const opened: unknown[] = []
    return { opened, files: async () => FILES, create: vi.fn(async () => true), open: (path, view) => void opened.push({ path, view }), ...overrides }
  }
  const reason = (error: unknown) => (error as { data?: { reason?: string } }).data?.reason

  it('opens the linked file with its view', async () => {
    const host = opener()
    expect(await openKitLink('notes/Today.md', { link: { name: 'Plan' }, view: { heading: ['Goals'] }, placement: 'tab' }, host)).toEqual({ opened: true })
    expect(host.opened).toEqual([{ path: 'notes/Plan.md', view: { heading: ['Goals'] } }])
    expect(host.create).not.toHaveBeenCalled()
  })

  it('answers not-found for a missing file unless asked to create it, and no-kit when no kit makes it', async () => {
    const host = opener()
    expect(reason(await openKitLink('notes/Today.md', { link: { name: 'Ideas' }, placement: 'tab' }, host).catch((error: unknown) => error))).toBe('not-found')
    expect(await openKitLink('notes/Today.md', { link: { name: 'Ideas' }, placement: 'beside', create: { kit: 'kit.note' } }, host)).toEqual({ opened: true })
    expect(host.create).toHaveBeenCalledWith('notes/Ideas.md', 'kit.note')
    expect(host.opened).toEqual([{ path: 'notes/Ideas.md', view: undefined }])
    const none = opener({ create: async () => false })
    expect(reason(await openKitLink('notes/Today.md', { link: { path: 'Ideas.xyz' }, placement: 'tab', create: {} }, none).catch((error: unknown) => error))).toBe('no-kit')
    expect(reason(await openKitLink('notes/Today.md', { link: { docId: 'd1' }, placement: 'tab' }, host).catch((error: unknown) => error))).toBe('not-found')
  })
})
