import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'

/** How long one listing of the workspace serves. */
const TTL_MS = 10_000

let cache: { fetchedAt: number; files: WorkspaceDocumentTreeItem[] } | null = null
let inflight: Promise<WorkspaceDocumentTreeItem[]> | null = null

function markdownFiles(items: readonly WorkspaceDocumentTreeItem[], out: WorkspaceDocumentTreeItem[] = []) {
  for (const item of items) {
    if (item.type === 'file' && /\.md$/i.test(item.path)) out.push(item)
    if (item.children?.length) markdownFiles(item.children, out)
  }
  return out
}

/** The workspace's notes (`.md` files) the search index reads: listed at most once every ten seconds. */
export async function loadWorkspaceNotes(): Promise<WorkspaceDocumentTreeItem[]> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.files
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const files = markdownFiles((await listWorkspaceDocuments()).items ?? [])
      cache = { fetchedAt: Date.now(), files }
      return files
    } finally {
      inflight = null
    }
  })()
  return inflight
}
