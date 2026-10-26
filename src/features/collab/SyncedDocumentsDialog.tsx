/**
 * "Your synced documents": the documents this person syncs to their devices or co-edits that are
 * not in this workspace yet (`rooms/list`, kept current by `rooms/changed`), each with Open here,
 * which makes a local file of it in the chosen folder. The file is a new replica of the same
 * document, relayed to its room like any shared document, so edits on any device reach the others.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon as LoaderCircle } from '@kition/tessera-icons/react'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kition/tessera-ui'
import type { RoomListing } from '@/lib/sync'
import { canOpenKit, openSyncedDocument, type SharedKit } from './shareActions'
import { listDocumentsElsewhere, onDocumentListChanged, workspaceFolders } from './syncedDocuments'

type Listed = { rooms: RoomListing[] | null; error: string }

function useFormats() {
  const { i18n } = useTranslation('workspace')
  return useMemo(() => {
    const locale = i18n.language || 'en-US'
    const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    const unit = (value: number, name: 'byte' | 'kilobyte' | 'megabyte' | 'gigabyte') =>
      new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: name === 'byte' ? 0 : 1 }).format(value)
    const size = (bytes: number) => {
      if (bytes < 1024) return unit(bytes, 'byte')
      if (bytes < 1024 ** 2) return unit(bytes / 1024, 'kilobyte')
      if (bytes < 1024 ** 3) return unit(bytes / 1024 ** 2, 'megabyte')
      return unit(bytes / 1024 ** 3, 'gigabyte')
    }
    return { time: (ms: number) => time.format(ms), size }
  }, [i18n.language])
}

export function SyncedDocumentsDialog({
  open,
  onClose,
  kitFor,
  onOpened,
  errorText,
}: {
  open: boolean
  onClose: () => void
  kitFor: (kitId: string) => SharedKit | null
  onOpened: (path: string) => void
  errorText: (error: unknown) => string
}) {
  const { t } = useTranslation('workspace')
  const formats = useFormats()
  const [listed, setListed] = useState<Listed>({ rooms: null, error: '' })
  const [folders, setFolders] = useState<string[]>([''])
  const [folder, setFolder] = useState('')
  /** The document being opened, and why the last open failed. */
  const [opening, setOpening] = useState<{ docId: string | null; error: string }>({ docId: null, error: '' })

  const refresh = useCallback(() => {
    void listDocumentsElsewhere().then(
      (rooms) => setListed({ rooms, error: '' }),
      (error: unknown) => setListed({ rooms: [], error: errorText(error) }),
    )
  }, [errorText])

  useEffect(() => {
    if (!open) return
    setListed({ rooms: null, error: '' })
    setOpening({ docId: null, error: '' })
    refresh()
    void workspaceFolders().then(setFolders, () => setFolders(['']))
    let live = true
    let stop: (() => void) | null = null
    // Kept current while open: a document synced or shared from another device shows up at once.
    void onDocumentListChanged(refresh).then(
      (off) => (live ? (stop = off) : off()),
      () => undefined,
    )
    return () => {
      live = false
      stop?.()
    }
  }, [open, refresh])

  const openHere = (room: RoomListing) => {
    if (opening.docId) return
    setOpening({ docId: room.docId, error: '' })
    void openSyncedDocument(room, folder, kitFor).then(
      (path) => {
        setOpening({ docId: null, error: '' })
        onClose()
        onOpened(path)
      },
      (error: unknown) => setOpening({ docId: null, error: errorText(error) }),
    )
  }

  const rooms = listed.rooms

  return (
    <Modal open={open} onOpenChange={(next) => !next && !opening.docId && onClose()}>
      <ModalContent size="lg" className="gap-0 p-0" data-testid="collab-synced-dialog">
        <ModalHeader className="space-y-2 border-b px-5 py-4">
          <ModalTitle>{t('collab.synced.title')}</ModalTitle>
          <ModalDescription>{t('collab.synced.description')}</ModalDescription>
        </ModalHeader>
        <div className="space-y-3 px-5 py-4">
          <label className="flex items-center gap-2 text-[13px]">
            <span className="shrink-0 text-muted-foreground">{t('collab.synced.folder')}</span>
            <select
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-[13px] outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/30"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              disabled={Boolean(opening.docId)}
              data-testid="collab-synced-folder"
            >
              {folders.map((path) => (
                <option key={path} value={path}>
                  {path || t('collab.synced.workspaceRoot')}
                </option>
              ))}
            </select>
          </label>
          {rooms === null ? (
            <div className="flex justify-center py-6">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label={t('collab.synced.loading')} />
            </div>
          ) : null}
          {listed.error ? (
            <p className="text-[13px] text-destructive" role="alert" data-testid="collab-synced-error">
              {listed.error}
            </p>
          ) : null}
          {rooms && !rooms.length && !listed.error ? (
            <p className="py-4 text-center text-[13px] text-muted-foreground" data-testid="collab-synced-empty">
              {t('collab.synced.empty')}
            </p>
          ) : null}
          {rooms?.length ? (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto" data-testid="collab-synced-list">
              {rooms.map((room) => {
                const openable = canOpenKit(room.kit, kitFor)
                const busy = opening.docId === room.docId
                const access = room.private ? t('collab.synced.private') : room.role === 'owner' ? t('collab.synced.shared') : t(`collab.role.${room.role}`)
                return (
                  <li key={room.docId} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2" data-testid="collab-synced-document" data-name={room.name}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{room.name}</div>
                      <div className="truncate text-[12px] text-muted-foreground">
                        {t('collab.synced.meta', { access, updated: formats.time(room.updated), size: formats.size(room.size) })}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!openable || Boolean(opening.docId)}
                      title={openable ? undefined : t('collab.synced.cannotOpen')}
                      onClick={() => openHere(room)}
                      data-testid="collab-synced-open"
                    >
                      {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                      {t('collab.synced.openHere')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {opening.error ? (
            <p className="text-[13px] text-destructive" role="alert" data-testid="collab-synced-open-error">
              {opening.error}
            </p>
          ) : null}
        </div>
        <ModalFooter className="border-t px-5 py-4">
          <Button size="md" type="button" variant="secondary" onClick={onClose} disabled={Boolean(opening.docId)}>
            {t('collab.close')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
