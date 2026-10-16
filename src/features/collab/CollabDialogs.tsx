import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { notify } from '@/lib/notify'
import { SyncRpcError } from '@/lib/sync'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/registry/ui/dialog'
import { collabConfigured, CollabUnavailableError } from './syncConnection'
import { onCollabSettingsChanged } from './collabSettings'
import { openSharedDocument, shareKitDocument, type SharedKit } from './shareActions'

const SHARE_EVENT = 'kition:collab:share'
const OPEN_SHARED_EVENT = 'kition:collab:open-shared'

/** Asks the window's co-editing dialogs to share the kit document open at `path`. */
export function requestShareKitDocument(path: string) {
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
 * The window's co-editing dialogs: sharing a document (and showing its link), and opening a
 * shared one from a link. `kitFor` names the kits this build can open shared documents of;
 * `onOpened` shows a document opened from a link.
 */
export function CollabDialogs({ kitFor, onOpened }: { kitFor: (kitId: string) => SharedKit | null; onOpened: (path: string) => void }) {
  const { t } = useTranslation('workspace')
  const errorText = useErrorText()
  const [shared, setShared] = useState<{ link: string } | null>(null)
  const [opening, setOpening] = useState<{ link: string; busy: boolean; error: string } | null>(null)

  useEffect(() => {
    const onShare = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (!path) return
      const toast = notify.loading(t('collab.sharing'))
      void shareKitDocument(path).then(
        async (link) => {
          notify.dismiss(toast)
          await copyText(link)
          setShared({ link })
        },
        (error: unknown) => {
          notify.dismiss(toast)
          notify.error(t('collab.shareFailed'), { description: errorText(error) })
        },
      )
    }
    const onOpenShared = () => setOpening({ link: '', busy: false, error: '' })
    window.addEventListener(SHARE_EVENT, onShare)
    window.addEventListener(OPEN_SHARED_EVENT, onOpenShared)
    return () => {
      window.removeEventListener(SHARE_EVENT, onShare)
      window.removeEventListener(OPEN_SHARED_EVENT, onOpenShared)
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
      <Dialog open={Boolean(shared)} onOpenChange={(open) => !open && setShared(null)}>
        <DialogContent size="sm" className="gap-0 p-0" data-testid="collab-share-dialog">
          <DialogHeader className="space-y-2 border-b px-5 py-4">
            <DialogTitle>{t('collab.sharedTitle')}</DialogTitle>
            <DialogDescription>{t('collab.sharedDescription')}</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4">
            <Input readOnly value={shared?.link ?? ''} aria-label={t('collab.linkLabel')} data-testid="collab-share-link" onFocus={(event) => event.currentTarget.select()} />
          </div>
          <DialogFooter className="border-t px-5 py-4">
            <Button type="button" variant="outline" onClick={() => setShared(null)}>
              {t('collab.close')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (shared) void copyText(shared.link).then((copied) => copied && notify.success(t('collab.linkCopied')))
              }}
            >
              {t('collab.copyLink')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(opening)} onOpenChange={(open) => !open && !opening?.busy && setOpening(null)}>
        <DialogContent size="sm" className="gap-0 p-0" data-testid="collab-open-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <DialogHeader className="space-y-2 border-b px-5 py-4">
              <DialogTitle>{t('collab.openShared')}</DialogTitle>
              <DialogDescription>{t('collab.openSharedDescription')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 px-5 py-4">
              <Input
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
            <DialogFooter className="border-t px-5 py-4">
              <Button type="button" variant="outline" onClick={() => setOpening(null)} disabled={opening?.busy}>
                {t('collab.cancel')}
              </Button>
              <Button type="submit" disabled={!opening?.link.trim() || opening?.busy} data-testid="collab-open-submit">
                {opening?.busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {t('collab.open')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
