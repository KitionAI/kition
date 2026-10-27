import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FileIcon as File, FolderIcon as Folder, UploadIcon as Upload } from '@kition/tessera-icons/react'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle, TextInput } from '@kition/tessera-ui'
import { cn } from '@/lib/cn'
import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { extensionOf, sanitizeFileName } from '../host/files'
import type { KitFilesPickParams } from '../host/protocol'
import { visiblePath } from './kitionFiles'
import { pickWorkspaceFile } from './pickWorkspaceFile'

type Entry = { path: string; name: string; folder: string; kind: 'file' | 'folder' }

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')

function flatten(items: WorkspaceDocumentTreeItem[], out: Entry[] = []) {
  for (const item of items) {
    if (!visiblePath(item.path)) continue
    out.push({ path: item.path, name: item.name, folder: parentOf(item.path), kind: item.type })
    if (item.type === 'folder') flatten(item.children ?? [], out)
  }
  return out
}

/**
 * The workspace picker a kit's `files/pick` opens (KitFiles 1.0 FA6): only the workspace's own
 * files and folders, never hidden ones; "Import from this computer" copies a file into the
 * workspace first, beside the document. Answers the chosen workspace paths; none when cancelled.
 */
function WorkspaceFilePicker({ request, documentPath, onSettle }: { request: KitFilesPickParams; documentPath: string; onSettle: (paths: string[]) => void }) {
  const { t } = useTranslation('workspace')
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [folder, setFolder] = useState(parentOf(documentPath))
  const [name, setName] = useState(request.suggestedName ? sanitizeFileName(request.suggestedName) : '')
  const [importing, setImporting] = useState(false)
  const accept = request.accept.map((extension) => extension.toLowerCase())

  useEffect(() => {
    let cancelled = false
    void listWorkspaceDocuments()
      .then((answer) => {
        if (!cancelled) setEntries(flatten(answer.items ?? []))
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return (entries ?? [])
      .filter((entry) => (request.mode === 'open' ? entry.kind === 'file' && (!accept.length || accept.includes(extensionOf(entry.name))) : entry.kind === 'folder'))
      .filter((entry) => !wanted || entry.path.toLowerCase().includes(wanted))
      .sort((a, b) => a.path.localeCompare(b.path))
  }, [accept, entries, query, request.mode])

  const choose = (path: string) => {
    if (request.mode === 'save') setFolder(path)
    else setChosen((current) => (request.mode === 'open' && request.multiple ? (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]) : [path]))
  }
  const savedName = sanitizeFileName(name || request.suggestedName || '')
  const saveExtension = extensionOf(savedName)
  const canSave = Boolean(name.trim()) && (!accept.length || accept.includes(saveExtension))
  const target = folder ? `${folder}/${savedName}` : savedName
  const replaces = request.mode === 'save' && canSave && Boolean(entries?.some((entry) => entry.kind === 'file' && entry.path === target))
  const confirm = () => onSettle(request.mode === 'save' ? (canSave ? [target] : []) : chosen)
  const importFile = async () => {
    setImporting(true)
    try {
      const imported = await pickWorkspaceFile(documentPath, accept)
      if (imported) onSettle([imported])
    } finally {
      setImporting(false)
    }
  }

  const title = t(`kitEditor.filePicker.title.${request.mode}`)
  const selected = (path: string) => (request.mode === 'save' ? folder === path : chosen.includes(path))
  return (
    <Modal open onOpenChange={(open) => !open && onSettle([])}>
      <ModalContent size="md" data-testid="kit-file-picker" data-mode={request.mode}>
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          <ModalDescription>{t(`kitEditor.filePicker.body.${request.mode}`)}</ModalDescription>
        </ModalHeader>
        {request.mode === 'save' ? (
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            <span>{t('kitEditor.filePicker.name')}</span>
            <TextInput size="lg" value={name} onChange={(event) => setName(event.target.value)} data-testid="kit-file-picker-name" />
          </label>
        ) : null}
        <TextInput size="md" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('kitEditor.filePicker.search')} aria-label={t('kitEditor.filePicker.search')} data-testid="kit-file-picker-search" />
        <div className="max-h-72 min-h-32 overflow-auto rounded-lg border border-border" role="listbox" aria-label={title} aria-multiselectable={request.mode === 'open' && request.multiple ? true : undefined}>
          {request.mode === 'save' ? (
            <PickerRow icon={<Folder className="size-4" />} name={t('kitEditor.filePicker.workspaceRoot')} detail="" selected={folder === ''} onSelect={() => setFolder('')} testId="kit-file-picker-root" />
          ) : null}
          {entries === null ? <p className="px-3 py-4 text-[13px] text-muted-foreground">{t('kitEditor.filePicker.loading')}</p> : null}
          {entries !== null && !shown.length && request.mode !== 'save' ? <p className="px-3 py-4 text-[13px] text-muted-foreground" data-testid="kit-file-picker-empty">{t('kitEditor.filePicker.empty')}</p> : null}
          {shown.map((entry) => (
            <PickerRow
              key={entry.path}
              icon={entry.kind === 'folder' ? <Folder className="size-4" /> : <File className="size-4" />}
              name={entry.name}
              detail={entry.folder}
              selected={selected(entry.path)}
              onSelect={() => choose(entry.path)}
              onConfirm={request.mode === 'save' ? undefined : () => onSettle([entry.path])}
              testId="kit-file-picker-entry"
            />
          ))}
        </div>
        {replaces ? <p className="text-[13px] text-muted-foreground" data-testid="kit-file-picker-replaces">{t('kitEditor.filePicker.replaces', { name: savedName })}</p> : null}
        <ModalFooter>
          {request.mode === 'open' ? (
            <Button size="md" variant="subtle" className="mr-auto" disabled={importing} onClick={() => void importFile()} data-testid="kit-file-picker-import">
              <Upload className="size-4" />
              {t('kitEditor.filePicker.import')}
            </Button>
          ) : null}
          <Button size="md" variant="subtle" onClick={() => onSettle([])} data-testid="kit-file-picker-cancel">
            {t('kitEditor.filePicker.cancel')}
          </Button>
          <Button size="md" variant="primary" disabled={request.mode === 'save' ? !canSave : !chosen.length} onClick={confirm} data-testid="kit-file-picker-confirm">
            {t(`kitEditor.filePicker.confirm.${request.mode}`)}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

function PickerRow({ icon, name, detail, selected, onSelect, onConfirm, testId }: {
  icon: ReactNode
  name: string
  detail: string
  selected: boolean
  onSelect: () => void
  onConfirm?: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={cn('flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted/60', selected && 'bg-accent text-accent-foreground')}
      onClick={onSelect}
      onDoubleClick={onConfirm}
      data-testid={testId}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{name}</span>
      {detail ? <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span> : null}
    </button>
  )
}

/**
 * The workspace picker a kit editing `documentPath` asks for (`pick` answers the chosen workspace
 * paths, none when cancelled); `dialog` is the picker while one is open.
 */
export function useWorkspacePicker(documentPath: string): { pick: (request: KitFilesPickParams) => Promise<string[]>; dialog: ReactNode } {
  const [asked, setAsked] = useState<{ request: KitFilesPickParams; settle: (paths: string[]) => void } | null>(null)
  const pick = useCallback((request: KitFilesPickParams) => new Promise<string[]>((settle) => setAsked({ request, settle })), [])
  const dialog = asked ? (
    <WorkspaceFilePicker
      request={asked.request}
      documentPath={documentPath}
      onSettle={(paths) => {
        asked.settle(paths)
        setAsked(null)
      }}
    />
  ) : null
  return { pick, dialog }
}
