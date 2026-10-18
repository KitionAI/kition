import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { blobHashOfURL } from '../lib/blobAttachments'
import { useTableDataSource, type TableDataSource } from './TableDataSource'
import { resolveTableFileURL, TableHostProvider, useTableHost, type TableHost } from './TableHost'

type BlobURL = { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed' }

/**
 * Object URLs of the blobs of one document, made from the bytes the data source reads
 * (`attachments.read`): loaded on first use, kept while the document is open, revoked after.
 */
class BlobURLCache {
  private readonly entries = new Map<string, BlobURL>()
  private disposed = false

  constructor(
    private readonly read: NonNullable<TableDataSource['attachments']>['read'],
    private readonly documentId: number,
    private readonly onLoaded: () => void,
  ) {}

  /** The blob's URL, or `''` while it loads (it starts loading now) or when it cannot be read. */
  url(hash: string): string {
    const entry = this.entries.get(hash)
    if (entry) return entry.state === 'ready' ? entry.url : ''
    this.entries.set(hash, { state: 'loading' })
    void this.load(hash)
    return ''
  }

  private async load(hash: string) {
    try {
      const blob = await this.read({ documentId: this.documentId, hash })
      if (this.disposed) return
      const bytes = blob.data.slice()
      const type = blob.mimeType || 'application/octet-stream'
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type }))
      this.entries.set(hash, { state: 'ready', url })
      this.onLoaded()
    } catch {
      if (!this.disposed) this.entries.set(hash, { state: 'failed' })
    }
  }

  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) if (entry.state === 'ready') URL.revokeObjectURL(entry.url)
    this.entries.clear()
  }
}

const TableBlobDocumentContext = createContext<((documentId: number | null) => void) | null>(null)

/**
 * The document whose blobs `TableBlobScope` resolves: the editor reports the document it shows,
 * once it knows it.
 */
export function useTableBlobDocument(documentId: number | null) {
  const setDocumentId = useContext(TableBlobDocumentContext)
  useEffect(() => {
    setDocumentId?.(documentId)
  }, [documentId, setDocumentId])
}

/**
 * Gives everything inside it a host (`useTableHost`) that also handles attachments held in the
 * document as blobs (`kition-blob:<sha256>` URLs):
 *
 * - `resolveFileURL` resolves a blob URL with the app's `resolveBlobURL` (a URL the page loads,
 *   such as a runtime route), or else with an object URL made from the bytes the data source's
 *   `attachments.read` answers; other URLs go to the app's `resolveFileURL` as before.
 * - `uploadAttachment` is the app's, or else the data source's `attachments.put`.
 *
 * The host changes when a blob finishes loading, so what shows it draws again.
 */
export function TableBlobScope({ children }: { children: ReactNode }) {
  const host = useTableHost()
  const dataSource = useTableDataSource()
  const [documentId, setDocumentId] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(0)
  const read = dataSource.attachments?.read

  const cache = useMemo(() => {
    if (documentId == null || !read || host.resolveBlobURL) return null
    let scheduled = false
    return new BlobURLCache(read, documentId, () => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        setLoaded((count) => count + 1)
      })
    })
  }, [documentId, read, host.resolveBlobURL])

  useEffect(() => () => cache?.dispose(), [cache])

  const scoped = useMemo<TableHost>(() => {
    const put = dataSource.attachments?.put
    return {
      ...host,
      resolveFileURL: (url) => {
        const hash = blobHashOfURL(url)
        if (!hash) return resolveTableFileURL(host, url)
        if (documentId == null) return ''
        if (host.resolveBlobURL) return host.resolveBlobURL({ documentId, hash })
        return cache ? cache.url(hash) : ''
      },
      uploadAttachment: host.uploadAttachment ?? (put ? (params) => put(params) : undefined),
    }
    // `loaded` is a dependency on purpose: a new host makes what shows blobs draw again.
  }, [host, dataSource, documentId, cache, loaded])

  return (
    <TableBlobDocumentContext.Provider value={setDocumentId}>
      <TableHostProvider value={scoped}>{children}</TableHostProvider>
    </TableBlobDocumentContext.Provider>
  )
}
