import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon as LoaderCircle } from '@kition/tessera-icons/react'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle, TextInput } from '@kition/tessera-ui'
import { notify } from '@/lib/notify'
import { SyncRpcError } from '@/lib/sync'
import { collabConfigured, CollabUnavailableError } from './syncConnection'
import { onCollabSettingsChanged } from './collabSettings'
import { ShareDialog, type SharedDialogDocument } from './ShareDialog'
import { openSharedDocument, roomRole, shareDocument, syncDocumentToMyDevices, type SharedKit } from './shareActions'
import { SyncedDocumentsDialog } from './SyncedDocumentsDialog'

const SHARE_EVENT = 'kition:collab:share'
const OPEN_SHARED_EVENT = 'kition:collab:open-shared'
const SYNC_EVENT = 'kition:collab:sync-to-devices'
const SYNCED_LIST_EVENT = 'kition:collab:synced-documents'

/** Asks the window's co-editing dialogs to sync the document open at `path` to this person's devices. */
export function requestSyncDocument(path: string) {
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { path } }))
}

/** Asks the window's co-editing dialogs to show this person's synced documents not in this workspace yet. */
export function requestSyncedDocuments() {
  window.dispatchEvent(new Event(SYNCED_LIST_EVENT))
}

/** Asks the window's co-editing dialogs to share the document open at `path`. */
export function requestShareDocument(path: string) {
  window.dispatchEvent(new CustomEvent(SHARE_EVENT, { detail: { path } }))
}

/** Asks the window's co-editing dialogs to open a shared document from a link. */
export function requestOpenSharedDocument() {
  window.dispatchEvent(new Event(OPEN_SHARED_EVENT))
}

/** Whether this window may co-edit (a sync server and a Kition Pro session); follows changes. */
export function useCollabAvailable() {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let live = true
    const check = () => void collabConfigured().then((next) => live && setAvailable(next))
    check()
    const stop = onCollabSettingsChanged(check)
    return () => {
      live = false
      stop()
    }
  }, [])
  return available
}

function useErrorText() {
  const { t } = useTranslation('workspace')
  return useCallback((error: unknown) => {
    if (error instanceof CollabUnavailableError) return t(error.reason === 'off' ? 'collab.needsPro' : 'collab.unreachable')
    if (error instanceof SyncRpcError && error.reason === 'forbidden') return t('collab.needsPro')
    if (error instanceof SyncRpcError && error.reason === 'not-found') return t('collab.linkNotFound')
    return error instanceof Error ? error.message : String(error)
  }, [t])
}

async function copyText(text: string) {
  try {
    await navigator.clipboard?.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * The window's co-editing dialogs: sharing a document (and showing its link), opening a shared
 * one from a link, syncing a document to this person's devices, and their synced documents. `kitFor` names the kits this build can open shared documents of;
 * `onOpened` shows a document opened from a link.
 */
export function CollabDialogs({ kitFor, onOpened }: { kitFor: (kitId: string) => SharedKit | null; onOpened: (path: string) => void }) {
  const { t } = useTranslation('workspace')
  const errorText = useErrorText()
  /** The document being shared, while its dialog is open. */
  const [shared, setShared] = useState<SharedDialogDocument | null>(null)
  const [opening, setOpening] = useState<{ link: string; busy: boolean; error: string } | null>(null)
  const [listing, setListing] = useState(false)

  useEffect(() => {
    const onShare = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (!path) return
      const toast = notify.loading(t('collab.sharing'))
      void shareDocument(path).then(
        async ({ docId, shareLink }) => {
          notify.dismiss(toast)
          await copyText(shareLink)
          setShared({ docId, path, shareLink, role: roomRole(docId) ?? 'owner' })
        },
        (error: unknown) => {
          notify.dismiss(toast)
          notify.error(t('collab.shareFailed'), { description: errorText(error) })
        },
      )
    }
    const onOpenShared = () => setOpening({ link: '', busy: false, error: '' })
    const onSync = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (!path) return
      const toast = notify.loading(t('collab.syncing'))
      void syncDocumentToMyDevices(path).then(
        () => {
          notify.dismiss(toast)
          notify.success(t('collab.synced.done'), { description: t('collab.synced.doneDescription') })
        },
        (error: unknown) => {
          notify.dismiss(toast)
          notify.error(t('collab.syncFailed'), { description: errorText(error) })
        },
      )
    }
    const onList = () => setListing(true)
    window.addEventListener(SHARE_EVENT, onShare)
    window.addEventListener(OPEN_SHARED_EVENT, onOpenShared)
    window.addEventListener(SYNC_EVENT, onSync)
    window.addEventListener(SYNCED_LIST_EVENT, onList)
    return () => {
      window.removeEventListener(SHARE_EVENT, onShare)
      window.removeEventListener(OPEN_SHARED_EVENT, onOpenShared)
      window.removeEventListener(SYNC_EVENT, onSync)
      window.removeEventListener(SYNCED_LIST_EVENT, onList)
    }
  }, [errorText, t])

  const submit = () => {
    if (!opening?.link.trim() || opening.busy) return
    const link = opening.link
    setOpening({ link, busy: true, error: '' })
    void openSharedDocument(link, kitFor).then(
      (path) => {
        setOpening(null)
        onOpened(path)
      },
      (error: unknown) => setOpening({ link, busy: false, error: errorText(error) }),
    )
  }

  return (
    <>
      <ShareDialog shared={shared} onClose={() => setShared(null)} errorText={errorText} />
      <SyncedDocumentsDialog open={listing} onClose={() => setListing(false)} kitFor={kitFor} onOpened={onOpened} errorText={errorText} />
      <Modal open={Boolean(opening)} onOpenChange={(open) => !open && !opening?.busy && setOpening(null)}>
        <ModalContent size="sm" className="gap-0 p-0" data-testid="collab-open-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <ModalHeader className="space-y-2 border-b px-5 py-4">
              <ModalTitle>{t('collab.openShared')}</ModalTitle>
              <ModalDescription>{t('collab.openSharedDescription')}</ModalDescription>
            </ModalHeader>
            <div className="space-y-2 px-5 py-4">
              <TextInput size="lg"
                value={opening?.link ?? ''}
                onChange={(event) => setOpening((current) => (current ? { ...current, link: event.target.value, error: '' } : current))}
                placeholder={t('collab.linkPlaceholder')}
                aria-label={t('collab.linkLabel')}
                data-testid="collab-open-link"
                autoFocus
                disabled={opening?.busy}
              />
              {opening?.error ? (
                <p className="text-[13px] text-destructive" role="alert" data-testid="collab-open-error">
                  {opening.error}
                </p>
              ) : null}
            </div>
            <ModalFooter className="border-t px-5 py-4">
              <Button size="md" type="button" variant="secondary" onClick={() => setOpening(null)} disabled={opening?.busy}>
                {t('collab.cancel')}
              </Button>
              <Button size="md" variant="primary" type="submit" disabled={!opening?.link.trim() || opening?.busy} data-testid="collab-open-submit">
                {opening?.busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {t('collab.open')}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  )
}
