import type { DesignAsset, DesignDocument, DesignNode } from './designTypes'
type Change<T> = { before: T | undefined; after: T | undefined }
type Header = Pick<DesignDocument, 'title' | 'pages' | 'provenance'>
export type DesignHistoryEntry = {
  nodes: Record<string, Change<DesignNode>>
  assets: Record<string, Change<DesignAsset>>
  header: { before: Header; after: Header }
}
function changes<T>(before: Record<string, T>, after: Record<string, T>) {
  const result: Record<string, Change<T>> = {}
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[id]) !== JSON.stringify(after[id]))
      result[id] = { before: before[id], after: after[id] }
  }
  return result
}
const header = (doc: DesignDocument): Header => ({
  title: doc.title,
  pages: doc.pages,
  provenance: doc.provenance,
})
export function designHistoryEntry(
  before: DesignDocument,
  after: DesignDocument,
): DesignHistoryEntry {
  return {
    nodes: changes(before.nodes, after.nodes),
    assets: changes(before.assets, after.assets),
    header: { before: header(before), after: header(after) },
  }
}
function mergeChanges<T>(
  first: Record<string, Change<T>>,
  next: Record<string, Change<T>>,
) {
  const result = { ...first }
  for (const [id, change] of Object.entries(next))
    result[id] =
      id in first ? { before: first[id].before, after: change.after } : change
  return result
}
export function mergeDesignHistory(
  first: DesignHistoryEntry,
  next: DesignHistoryEntry,
): DesignHistoryEntry {
  return {
    nodes: mergeChanges(first.nodes, next.nodes),
    assets: mergeChanges(first.assets, next.assets),
    header: { before: first.header.before, after: next.header.after },
  }
}
export function applyDesignHistory(
  doc: DesignDocument,
  entry: DesignHistoryEntry,
  side: 'before' | 'after',
): DesignDocument {
  const nodes = { ...doc.nodes },
    assets = { ...doc.assets }
  for (const [id, change] of Object.entries(entry.nodes)) {
    const value = change[side]
    if (value) nodes[id] = value
    else delete nodes[id]
  }
  for (const [id, change] of Object.entries(entry.assets)) {
    const value = change[side]
    if (value) assets[id] = value
    else delete assets[id]
  }
  return {
    ...doc,
    ...entry.header[side],
    nodes,
    assets,
    revision: doc.revision + 1,
  }
}
