import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'

/** How long one listing of the workspace serves. */
const TTL_MS = 10_000

let cache: { rootPath: string; fetchedAt: number; files: WorkspaceDocumentTreeItem[] } | null = null
let inflight: { rootPath: string; promise: Promise<WorkspaceDocumentTreeItem[]> } | null = null

function markdownFiles(items: readonly WorkspaceDocumentTreeItem[], out: WorkspaceDocumentTreeItem[] = []) {
  for (const item of items) {
    if (item.type === 'file' && /\.md$/i.test(item.path)) out.push(item)
    if (item.children?.length) markdownFiles(item.children, out)
  }
  return out
}

/** A workspace reload makes both the cached list and an older request obsolete. */
export function invalidateWorkspaceNotes() {
  cache = null
  inflight = null
}

/** The current workspace's notes, sharing a recent or in-flight list only for the same root. */
export async function loadWorkspaceNotes(rootPath: string): Promise<WorkspaceDocumentTreeItem[]> {
  if (cache?.rootPath === rootPath && Date.now() - cache.fetchedAt < TTL_MS) return cache.files
  if (inflight?.rootPath === rootPath) return inflight.promise
  const promise: Promise<WorkspaceDocumentTreeItem[]> = listWorkspaceDocuments().then(response => {
    if (response.root_path !== rootPath) throw new Error('Workspace changed while listing search documents')
    const files = markdownFiles(response.items ?? [])
    if (inflight?.promise === promise) cache = { rootPath, fetchedAt: Date.now(), files }
    return files
  }).finally(() => {
    if (inflight?.promise === promise) inflight = null
  })
  inflight = { rootPath, promise }
  return promise
}
