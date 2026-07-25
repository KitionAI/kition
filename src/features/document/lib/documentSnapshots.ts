import type { WorkspaceDocument } from '@/services/desktop'

export type DocumentSnapshot = {
  id: string
  path: string
  name: string
  content: string
  reason: string
  createdAt: string
  wordCount: number
}

const documentSnapshotStorageKey = 'kition.document.snapshots.v1'

export function readDocumentSnapshots(): DocumentSnapshot[] {
  if (typeof window === 'undefined') {
    return []
  }

  const rawValue = window.localStorage.getItem(documentSnapshotStorageKey)
  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)
    return Array.isArray(parsed) ? parsed.filter((item) => item?.path && item?.content !== undefined) : []
  } catch {
    return []
  }
}

export function writeDocumentSnapshots(items: DocumentSnapshot[]) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(documentSnapshotStorageKey, JSON.stringify(items.slice(0, 120)))
}

function createDocumentSnapshot(document: WorkspaceDocument, content: string, reason: string): DocumentSnapshot {
  const createdAt = new Date().toISOString()
  return {
    id: `${document.path}-${createdAt}`,
    path: document.path,
    name: document.name,
    content,
    reason,
    createdAt,
    wordCount: content.replace(/\s+/g, '').length,
  }
}

export function pushDocumentSnapshot(
  snapshots: DocumentSnapshot[],
  document: WorkspaceDocument,
  content: string,
  reason: string,
) {
  const latestForPath = snapshots.find((item) => item.path === document.path)
  if (latestForPath?.content === content) {
    return snapshots
  }

  const next = [
    createDocumentSnapshot(document, content, reason),
    ...snapshots,
  ]
  const perDocumentCount = new Map<string, number>()

  return next.filter((item) => {
    const count = perDocumentCount.get(item.path) || 0
    if (count >= 24) {
      return false
    }
    perDocumentCount.set(item.path, count + 1)
    return true
  }).slice(0, 120)
}
