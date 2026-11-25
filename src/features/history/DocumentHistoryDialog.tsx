import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon as LoaderCircle } from '@kition/tessera/icons/react'
import { cn } from '@/lib/cn'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kition/tessera/ui'
import { KitFrame, type EmbeddedKit } from '@/features/kits/public'
import { notify } from '@/lib/notify'
import { historyDocumentFor, type HistoryDocument } from './historyDocuments'
import { loadHistory, previewOf, restoreEntry, type HistoryEntry, type HistoryPreview } from './historyModel'

const ORIGINS = new Set(['save', 'agent', 'script', 'edit', 'open'])

function useTimeFormat() {
  const { i18n } = useTranslation('history')
  return useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }), [i18n.language])
}

function HistoryItem({ entry, selected, onSelect }: { entry: HistoryEntry; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation('history')
  const time = useTimeFormat()
  const title = t(`origin.${ORIGINS.has(entry.origin) ? entry.origin : 'other'}`)
  const author = entry.author?.startsWith('agent') ? t('agent') : entry.author ? t('you') : ''
  const detail = [author, entry.label].filter(Boolean).join(' · ')
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        data-testid="history-entry"
        data-origin={entry.origin}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors',
          selected ? 'bg-brand/10 text-foreground' : 'hover:bg-accent',
        )}
      >
        <span className="text-[13px] font-medium text-foreground">{time.format(entry.time)}</span>
        <span className="text-[12px] text-muted-foreground">{title}</span>
        {detail ? <span className="text-[12px] text-muted-foreground">{detail}</span> : null}
      </button>
    </li>
  )
}

function HistorySection({ label, entries, selected, onSelect }: { label: string; entries: HistoryEntry[]; selected: string | null; onSelect: (entry: HistoryEntry) => void }) {
  if (!entries.length) return null
  return (
    <section className="space-y-1">
      <h3 className="px-3 pt-2 text-[12px] font-semibold text-muted-foreground">{label}</h3>
      <ul className="space-y-0.5" data-testid="history-device">
        {entries.map((entry) => (
          <HistoryItem key={entry.id} entry={entry} selected={selected === entry.id} onSelect={() => onSelect(entry)} />
        ))}
      </ul>
    </section>
  )
}

function PreviewPane({ document, preview, kit }: { document: HistoryDocument; preview: HistoryPreview; kit: EmbeddedKit | null }) {
  const { t } = useTranslation('history')
  const kitPreview = useMemo(() => ({ snapshot: preview.snapshot.slice().buffer as ArrayBuffer, blobs: preview.blobs.slice().buffer as ArrayBuffer }), [preview])
  if (!kit) return <p className="p-5 text-[13px] text-muted-foreground">{t('previewFailed')}</p>
  return <KitFrame kit={kit} path={document.path} active preview={kitPreview} />
}

/**
 * The version history of the document open at `path`: this device's checkpoints; a chosen version is shown read-only
 * (the document's kit draws it from the checkpoint's snapshot), and restored by the kit as one new change.
 */
export function DocumentHistoryDialog({ path, onClose, kitFor }: { path: string; onClose: () => void; kitFor: (kitId: string) => EmbeddedKit | null }) {
  const { t } = useTranslation('history')
  const time = useTimeFormat()
  const document = useMemo(() => historyDocumentFor(path), [path])
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<HistoryEntry | null>(null)
  const [preview, setPreview] = useState<{ id: string; preview: HistoryPreview | null; failed: boolean } | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!document) return undefined
    let live = true
    void loadHistory(document).then(
      (device) => live && setEntries(device),
      (error: unknown) => {
        console.warn('[history] could not read the history', error)
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [document])

  useEffect(() => {
    if (!document || !selected) return undefined
    let live = true
    setPreview({ id: selected.id, preview: null, failed: false })
    void previewOf(document, selected).then(
      (next) => live && setPreview({ id: selected.id, preview: next, failed: false }),
      (error: unknown) => {
        console.warn('[history] could not show a version', error)
        if (live) setPreview({ id: selected.id, preview: null, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [document, selected])

  const restore = async () => {
    if (!document || !selected || restoring) return
    setRestoring(true)
    try {
      await restoreEntry(document, selected, t('restoreLabel', { time: time.format(selected.time) }))
      notify.success(t('restored'), { description: t('restoredUndoable') })
      onClose()
    } catch (error) {
      notify.error(t('restoreFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setRestoring(false)
    }
  }

  const name = path.split('/').pop() ?? path
  const empty = entries && !entries.length
  const kit = document ? kitFor(document.kitId) : null

  return (
    <Modal open onOpenChange={(open) => !open && !restoring && onClose()}>
      <ModalContent size="none" className="h-[min(720px,85vh)] gap-0 overflow-hidden p-0 md:max-w-[1040px]" data-testid="history-dialog">
        <ModalHeader className="space-y-1 border-b px-5 py-4">
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{name}</ModalDescription>
        </ModalHeader>
        <div className="flex min-h-0 flex-1">
          <nav className="w-[280px] shrink-0 overflow-y-auto border-r p-2" aria-label={t('title')}>
            {!document || failed ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">{t('readFailed')}</p>
            ) : !entries ? (
              <p className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t('reading')}
              </p>
            ) : empty ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground" data-testid="history-empty">{t('empty')}</p>
            ) : (
              <div className="space-y-2">
                <HistorySection label={t('device')} entries={entries} selected={selected?.id ?? null} onSelect={setSelected} />
              </div>
            )}
          </nav>
          <div className="relative min-w-0 flex-1 bg-surface-soft" data-testid="history-preview">
            {!selected ? (
              <p className="p-5 text-[13px] text-muted-foreground">{t('select')}</p>
            ) : preview?.failed ? (
              <p className="p-5 text-[13px] text-muted-foreground" role="alert">{t('previewFailed')}</p>
            ) : !preview?.preview || !document ? (
              <p className="flex items-center gap-2 p-5 text-[13px] text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t('previewOpening')}
              </p>
            ) : (
              <PreviewPane key={preview.id} document={document} preview={preview.preview} kit={kit} />
            )}
          </div>
        </div>
        <ModalFooter className="border-t px-5 py-3">
          <Button size="md" variant="secondary" onClick={onClose} disabled={restoring}>{t('close')}</Button>
          <Button size="md" variant="primary" onClick={() => void restore()} disabled={!selected || !preview?.preview || restoring} data-testid="history-restore">
            {restoring ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {restoring ? t('restoring') : t('restore')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
