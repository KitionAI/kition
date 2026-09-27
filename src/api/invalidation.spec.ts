import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watcher = vi.hoisted(() => ({
  handler: null as null | ((change: { path: string; eventType: 'add' | 'change' | 'unlink' }) => void),
  unsubscribe: vi.fn(),
}))

vi.mock('@/services/desktop', () => ({
  subscribeWorkspaceDocumentExternalChanges: vi.fn((handler) => {
    watcher.handler = handler
    return watcher.unsubscribe
  }),
}))

// Only the event names are needed; keep the HTTP modules (and the axios
// client they build at import time) out of this test.
vi.mock('./formSync', () => ({ FORM_SYNC_CHANGED_EVENT: 'kition:form-sync:changed' }))
vi.mock('./emailSync', () => ({ EMAIL_SYNC_CHANGED_EVENT: 'kition:email-sync:changed' }))
vi.mock('./connections', () => ({ CONNECTIONS_CHANGED_EVENT: 'kition:connections:changed' }))

import { queryKeys } from './queryKeys'
import { FORM_SYNC_CHANGED_EVENT } from './formSync'
import {
  installWorkspaceInvalidation,
  invalidateForWorkspaceChange,
  setInvalidationWorkspaceRoot,
  WORKSPACE_RELOAD_EVENT,
} from './invalidation'

const ROOT = '/workspace/demo'

function seed(client: QueryClient) {
  const keys = {
    tree: queryKeys.workspaceTree(ROOT),
    index: queryKeys.kitableIndex(ROOT),
    kitable: queryKeys.documentByPath(ROOT, 'a/b.kitable'),
    note: queryKeys.documentByPath(ROOT, 'notes/today.md'),
    otherRootTree: queryKeys.workspaceTree('/workspace/other'),
    workflows: queryKeys.workflows(),
    connections: queryKeys.connections(),
  }
  for (const key of Object.values(keys)) client.setQueryData(key, { seeded: true })
  return keys
}

function isInvalidated(client: QueryClient, key: readonly unknown[]) {
  return client.getQueryState(key)?.isInvalidated === true
}

let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setInvalidationWorkspaceRoot(ROOT)
  watcher.handler = null
  watcher.unsubscribe.mockClear()
})

afterEach(() => {
  client.clear()
})

describe('invalidateForWorkspaceChange', () => {
  it('a changed .kitable file invalidates that document and the kitable index only', async () => {
    const keys = seed(client)

    await invalidateForWorkspaceChange(client, { path: 'a/b.kitable', eventType: 'change' })

    expect(isInvalidated(client, keys.kitable)).toBe(true)
    expect(isInvalidated(client, keys.index)).toBe(true)
    expect(isInvalidated(client, keys.note)).toBe(false)
    expect(isInvalidated(client, keys.tree)).toBe(false)
    expect(isInvalidated(client, keys.otherRootTree)).toBe(false)
    expect(isInvalidated(client, keys.workflows)).toBe(false)
  })

  it('an added or removed file also invalidates the tree listing', async () => {
    const keys = seed(client)

    await invalidateForWorkspaceChange(client, { path: 'notes/today.md', eventType: 'unlink' })

    expect(isInvalidated(client, keys.note)).toBe(true)
    expect(isInvalidated(client, keys.tree)).toBe(true)
    expect(isInvalidated(client, keys.index)).toBe(false)
  })
})

describe('installWorkspaceInvalidation', () => {
  it('wires the watcher, the reload event, and runtime change events, and disposes them', async () => {
    const keys = seed(client)
    const dispose = installWorkspaceInvalidation(client)
    expect(watcher.handler).not.toBeNull()

    watcher.handler?.({ path: 'a/b.kitable', eventType: 'add' })
    await Promise.resolve()
    expect(isInvalidated(client, keys.index)).toBe(true)

    client.setQueryData(keys.otherRootTree, { seeded: true })
    window.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD_EVENT))
    await Promise.resolve()
    expect(isInvalidated(client, keys.tree)).toBe(true)
    expect(isInvalidated(client, keys.otherRootTree)).toBe(false)

    window.dispatchEvent(new CustomEvent(FORM_SYNC_CHANGED_EVENT))
    await Promise.resolve()
    expect(isInvalidated(client, keys.workflows)).toBe(true)
    expect(isInvalidated(client, keys.connections)).toBe(false)

    dispose()
    expect(watcher.unsubscribe).toHaveBeenCalledTimes(1)
    client.setQueryData(keys.connections, { seeded: true })
    window.dispatchEvent(new CustomEvent(FORM_SYNC_CHANGED_EVENT))
    await Promise.resolve()
    expect(isInvalidated(client, keys.connections)).toBe(false)
  })
})
