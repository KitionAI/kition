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
vi.mock('./connections', () => ({ CONNECTIONS_CHANGED_EVENT: 'kition:connections:changed' }))

import { queryKeys } from './queryKeys'
import { WORKFLOW_CHANGED_EVENT } from '@/lib/workflowEvents'
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
    table: queryKeys.documentByPath(ROOT, 'a/b.ktable'),
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
  it('a changed table file invalidates that document only, and tells the table pickers', async () => {
    const keys = seed(client)
    const heard = vi.fn()
    window.addEventListener('kition:table-files:changed', heard)

    await invalidateForWorkspaceChange(client, { path: 'a/b.ktable', eventType: 'change' })
    window.removeEventListener('kition:table-files:changed', heard)

    expect(heard).toHaveBeenCalledOnce()
    expect(isInvalidated(client, keys.table)).toBe(true)
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
    expect(isInvalidated(client, keys.table)).toBe(false)
  })
})

describe('installWorkspaceInvalidation', () => {
  it('wires the watcher, the reload event, and runtime change events, and disposes them', async () => {
    const keys = seed(client)
    const dispose = installWorkspaceInvalidation(client)
    expect(watcher.handler).not.toBeNull()

    watcher.handler?.({ path: 'a/b.ktable', eventType: 'add' })
    await Promise.resolve()
    expect(isInvalidated(client, keys.table)).toBe(true)

    client.setQueryData(keys.otherRootTree, { seeded: true })
    window.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD_EVENT))
    await Promise.resolve()
    expect(isInvalidated(client, keys.tree)).toBe(true)
    expect(isInvalidated(client, keys.otherRootTree)).toBe(false)

    window.dispatchEvent(new CustomEvent(WORKFLOW_CHANGED_EVENT))
    await Promise.resolve()
    expect(isInvalidated(client, keys.workflows)).toBe(true)
    expect(isInvalidated(client, keys.connections)).toBe(false)

    dispose()
    expect(watcher.unsubscribe).toHaveBeenCalledTimes(1)
    client.setQueryData(keys.connections, { seeded: true })
    window.dispatchEvent(new CustomEvent(WORKFLOW_CHANGED_EVENT))
    await Promise.resolve()
    expect(isInvalidated(client, keys.connections)).toBe(false)
  })
})
