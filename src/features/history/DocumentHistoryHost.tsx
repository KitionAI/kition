import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EmbeddedKit } from '@/features/kits/public'
import { notify } from '@/lib/notify'
import { documentStoreStatus, onDocumentStoreAccess, type DocumentStoreStatus } from '@/services/desktop'
import { DocumentHistoryDialog } from './DocumentHistoryDialog'
import { historyDocumentFor } from './historyDocuments'

const OPEN_EVENT = 'kition:history:open'
const STORE_NOTICE = 'document-store-read-only'

/** Asks the window to show the version history of the document open at `path`. */
export function requestDocumentHistory(path: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { path } }))
}

/** Whether the document open at `path` has a version history to show (an open document, board, or kit document). */
export function canShowDocumentHistory(path: string) {
  return historyDocumentFor(path) !== null
}

/**
 * Tells the person when this window does not write the workspace's document store (another Kition holds its lock,
 * on this computer or on another device that syncs the workspace), and when it takes the store over.
 */
function useDocumentStoreNotice() {
  const { t } = useTranslation('history')
  useEffect(() => {
    let live = true
    let readOnly = false
    const show = (status: DocumentStoreStatus) => {
      if (!live) return
      if (status.writable) {
        if (readOnly) {
          notify.dismiss(STORE_NOTICE)
          notify.success(t('store.writable'))
        }
        readOnly = false
        return
      }
      readOnly = true
      const holder = status.holder
      const description = !holder ? t('store.readOnlyUnknown') : holder.sameHost ? t('store.readOnlySame') : t('store.readOnlyOther', { host: holder.host })
      notify.warning(t('store.readOnlyTitle'), { id: STORE_NOTICE, description, duration: Number.POSITIVE_INFINITY })
    }
    void documentStoreStatus().then(show, () => undefined)
    const stop = onDocumentStoreAccess(show)
    return () => {
      live = false
      stop()
    }
  }, [t])
}

/**
 * The window's version history: the dialog `requestDocumentHistory` opens, and the notice of a read-only document
 * store. `kitFor` names the kit package that shows a kit document's past versions.
 */
export function DocumentHistoryHost({ kitFor }: { kitFor: (kitId: string) => EmbeddedKit | null }) {
  const [path, setPath] = useState<string | null>(null)
  useDocumentStoreNotice()
  useEffect(() => {
    const open = (event: Event) => {
      const wanted = (event as CustomEvent<{ path?: string }>).detail?.path
      if (wanted) setPath(wanted)
    }
    window.addEventListener(OPEN_EVENT, open)
    return () => window.removeEventListener(OPEN_EVENT, open)
  }, [])
  return path ? <DocumentHistoryDialog key={path} path={path} kitFor={kitFor} onClose={() => setPath(null)} /> : null
}
