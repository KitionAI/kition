// src/features/search/service/events.ts
import type { SearchService } from './searchService'
import { extractNoteDocs } from '../sources/noteSource'
import { isTableFilePath, onTableFilesChanged } from '@/api/kitTables'
import { reindexTableFile, type TableSearchFile } from '../sources/tableSource'

const DEBOUNCE_MS = 300

type Loaders = {
  readMarkdown: (vaultPath: string) => Promise<string>
  /** Every table of a table file, read through the Table kit, with the file's stamp. */
  loadTableFile: (vaultPath: string) => Promise<TableSearchFile>
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

  const onTableFileChange = (vaultPath: string) => {
    if (recordBatch.has(vaultPath)) clearTimeout(recordBatch.get(vaultPath)!)
    recordBatch.set(vaultPath, setTimeout(async () => {
      recordBatch.delete(vaultPath)
      try {
        await reindexTableFile(service, vaultPath, loaders.loadTableFile)
      } catch (e) { console.warn('[search] table file resync failed', vaultPath, e) }
    }, DEBOUNCE_MS))
  }

  function fileHandler(e: Event) {
    const detail = (e as CustomEvent).detail as { vaultPath: string; kind: 'create' | 'change' | 'delete' }
    if (!detail?.vaultPath) return
    if (isTableFilePath(detail.vaultPath)) {
      if (detail.kind === 'delete') void service.removeByVaultPath([detail.vaultPath])
      else onTableFileChange(detail.vaultPath)
      return
    }
    if (!detail.vaultPath.endsWith('.md')) return
    if (detail.kind === 'delete') onNoteDelete(detail.vaultPath)
    else onNoteChange(detail.vaultPath)
  }

  window.addEventListener('kition:workspace:file:change', fileHandler)
  window.addEventListener('kition:workspace:file:create', fileHandler)
  window.addEventListener('kition:workspace:file:delete', fileHandler)
  // A table file saved from its editor, or written by a host feature in this window.
  const stopTables = onTableFilesChanged((vaultPath) => {
    if (vaultPath) onTableFileChange(vaultPath)
  })

  return () => {
    window.removeEventListener('kition:workspace:file:change', fileHandler)
    window.removeEventListener('kition:workspace:file:create', fileHandler)
    window.removeEventListener('kition:workspace:file:delete', fileHandler)
    stopTables()
  }
}
