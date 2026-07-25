// src/features/search/service/events.ts
import type { SearchService } from './searchService'
import { extractNoteDocs } from '../sources/noteSource'
import { extractKitableDocs, type KitableTableInput } from '../sources/kitableSource'

const DEBOUNCE_MS = 300

type Loaders = {
  readMarkdown: (vaultPath: string) => Promise<string>
  loadKitableTable: (vaultPath: string, tableId: string) => Promise<KitableTableInput>
}

export function attachEventBridges(service: SearchService, loaders: Loaders): () => void {
  const noteBatch = new Map<string, ReturnType<typeof setTimeout>>()
  const recordBatch = new Map<string, ReturnType<typeof setTimeout>>()

  const onNoteChange = (vaultPath: string) => {
    if (noteBatch.has(vaultPath)) clearTimeout(noteBatch.get(vaultPath)!)
    noteBatch.set(vaultPath, setTimeout(async () => {
      noteBatch.delete(vaultPath)
      try {
        const content = await loaders.readMarkdown(vaultPath)
        await service.removeByVaultPath([vaultPath])
        await service.upsert(extractNoteDocs({ vaultPath, content }))
      } catch (e) { console.warn('[search] note resync failed', vaultPath, e) }
    }, DEBOUNCE_MS))
  }

  const onNoteDelete = (vaultPath: string) => {
    void service.removeByVaultPath([vaultPath])
  }

  const onKitableMutation = (vaultPath: string, tableId: string) => {
    const key = `${vaultPath}::${tableId}`
    if (recordBatch.has(key)) clearTimeout(recordBatch.get(key)!)
    recordBatch.set(key, setTimeout(async () => {
      recordBatch.delete(key)
      try {
        const input = await loaders.loadKitableTable(vaultPath, tableId)
        // For V1: if any record/field/view of any table changes, we resync
        // ALL tables in that .kitable. This is acceptable because each .kitable
        // typically has 1-3 tables.
        await service.removeByVaultPath([vaultPath])
        await service.upsert(extractKitableDocs(input))
      } catch (e) { console.warn('[search] kitable resync failed', vaultPath, tableId, e) }
    }, DEBOUNCE_MS))
  }

  function fileHandler(e: Event) {
    const detail = (e as CustomEvent).detail as { vaultPath: string; kind: 'create' | 'change' | 'delete' }
    if (!detail?.vaultPath) return
    if (!detail.vaultPath.endsWith('.md')) return
    if (detail.kind === 'delete') onNoteDelete(detail.vaultPath)
    else onNoteChange(detail.vaultPath)
  }

  function recordHandler(e: Event) {
    const d = (e as CustomEvent).detail as { vaultPath: string; tableId: string }
    if (d?.vaultPath && d?.tableId) onKitableMutation(d.vaultPath, d.tableId)
  }

  window.addEventListener('kition:workspace:file:change', fileHandler)
  window.addEventListener('kition:workspace:file:create', fileHandler)
  window.addEventListener('kition:workspace:file:delete', fileHandler)
  ;[
    'kition:data-document:record:upsert', 'kition:data-document:record:delete',
    'kition:data-document:field:upsert', 'kition:data-document:field:delete',
    'kition:data-document:view:upsert', 'kition:data-document:view:delete',
    'kition:data-document:table:rename',
  ].forEach(name => window.addEventListener(name, recordHandler))

  return () => {
    window.removeEventListener('kition:workspace:file:change', fileHandler)
    window.removeEventListener('kition:workspace:file:create', fileHandler)
    window.removeEventListener('kition:workspace:file:delete', fileHandler)
    ;[
      'kition:data-document:record:upsert', 'kition:data-document:record:delete',
      'kition:data-document:field:upsert', 'kition:data-document:field:delete',
      'kition:data-document:view:upsert', 'kition:data-document:view:delete',
      'kition:data-document:table:rename',
    ].forEach(name => window.removeEventListener(name, recordHandler))
  }
}
