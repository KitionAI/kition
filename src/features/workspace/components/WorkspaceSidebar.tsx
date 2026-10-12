import type { KitCreationItem } from '@/features/workspace/hooks/useKitCreations'
import { ChevronDown, ChevronRight, Folder, LoaderCircle, PanelLeftClose, Plus, RefreshCw, Search, Zap } from 'lucide-react'
import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkspaceCreateMenu } from '@/features/workspace/components/WorkspaceCreateMenu'
import type { DocumentCreateFormat } from '@/features/document/lib/documentCreation'
import type { WorkspaceImportEntry } from '@/features/workspace/hooks/useWorkspaceTreeCreateActions'
import { handleDesktopChromeDoubleClick } from '@/lib/windowChrome'
import { carriesFiles } from '@/lib/fileDropGuard'
import { cn } from '@/lib/utils'

export function WorkspaceSidebar({
  loading,
  rootPath,
  workspaceDisplayName,
  privateExpanded,
  createMenuOpen,
  createMenuTriggerPath,
  createMenuVariant,
  treeContent,
  mediaSections,
  onTogglePrivate,
  onOpenCreateMenu,
  onCloseCreateMenu,
  onCreateFolder,
  onCreateDocument,
  onCreateTable,
  onImportTableFile,
  onPasteFiles,
  onRefresh,
  onOpenWorkflows,
  onCreateBoard,
  onCreateDesign,
  kitCreations,
  onToggleSidebar,
  onOpenSearch,
}: {
  loading: boolean
  rootPath: string
  workspaceDisplayName: string
  privateExpanded: boolean
  createMenuOpen: boolean
  createMenuTriggerPath: string
  createMenuVariant?: 'workspace' | 'kitable'
  treeContent: ReactNode
  mediaSections?: ReactNode
  onTogglePrivate: () => void
  onOpenCreateMenu: () => void
  onCloseCreateMenu: () => void
  onCreateFolder: () => void
  onCreateDocument: (format: DocumentCreateFormat) => void
  onCreateTable: () => void
  onImportTableFile?: () => void
  onPasteFiles?: (entries: WorkspaceImportEntry[]) => void
  onRefresh?: () => void
  /** Opens the workspace-global Workflows tab. Replaces the old root-level
   *  virtual "Workflows" tree node — kept as a header-bar shortcut so the
   *  entry point survives without taking a row in the tree. */
  onOpenWorkflows?: () => void
  /** Creates a durable native SVG Board file in the active workspace folder. */
  onCreateBoard?: () => void
  onCreateDesign?: () => void
  /** The create menu's kit items (Image, Video project). */
  kitCreations?: readonly KitCreationItem[]
  onToggleSidebar?: () => void
  /** Opens the standalone full-text search modal (Codex-style palette). */
  onOpenSearch?: () => void
}) {
  // The create menu can be triggered from two anchors: the sidebar header `+`
  // (createMenuTriggerPath === '') or any tree row's inline `+` (path !== '').
  // Each anchor carries the class below; a click outside any anchor closes.
  useEffect(() => {
    if (!createMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.document-create-menu-anchor')) {
        return
      }
      onCloseCreateMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseCreateMenu()
      }
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [createMenuOpen, onCloseCreateMenu])
  const { t } = useTranslation('workspace')
  // Callback ref into state so the menu re-renders once the button mounts and
  // computes its portal coords from the real bounding rect.
  const [headerCreateAnchor, setHeaderCreateAnchor] = useState<HTMLButtonElement | null>(null)

  const [fileDragOver, setFileDragOver] = useState(false)

  /** Imports files and folders from a paste or an OS drop into the workspace root. */
  function importTransfer(transfer: DataTransfer | null, preventDefault: () => void) {
    if (!onPasteFiles || !transfer) {
      return
    }
    // Entries must be read while the event is dispatching; the transfer is emptied afterwards.
    const rootEntries = snapshotClipboardFileEntries(transfer)
    const fallbackFiles = !rootEntries.length ? Array.from(transfer.files || []) : []
    if (!rootEntries.length && !fallbackFiles.length) {
      return
    }
    preventDefault()
    void (async () => {
      const collected: WorkspaceImportEntry[] = []
      for (const entry of rootEntries) {
        try {
          await collectFileSystemEntry(entry, '', collected)
        } catch {
          // ignore individual entry failures; continue with others
        }
      }
      if (!collected.length && fallbackFiles.length) {
        for (const file of fallbackFiles) {
          if (file && file.name) {
            collected.push({ file, relativePath: file.name })
          }
        }
      }
      if (collected.length) {
        onPasteFiles(collected)
      }
    })()
  }

  function handlePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    importTransfer(event.clipboardData, () => event.preventDefault())
  }

  // Rows take drops into their folder and stop propagation; a drop anywhere
  // else in the tree area imports into the workspace root.
  function handleFileDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!onPasteFiles || !carriesFiles(event.nativeEvent)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setFileDragOver(true)
  }

  function handleFileDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFileDragOver(false)
    }
  }

  function handleFileDrop(event: ReactDragEvent<HTMLDivElement>) {
    setFileDragOver(false)
    if (!carriesFiles(event.nativeEvent)) {
      return
    }
    importTransfer(event.dataTransfer, () => event.preventDefault())
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="document-tree"
      onPaste={onPasteFiles ? handlePaste : undefined}
      tabIndex={onPasteFiles ? 0 : undefined}
    >
      <div className="workspace-sidebar-header" onDoubleClick={handleDesktopChromeDoubleClick}>
        <div className="workspace-sidebar-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected
            className="workspace-sidebar-tab is-active"
            aria-label={t('sidebar.tabs.files')}
            title={t('sidebar.tabs.files')}
            data-testid="sidebar-tab-files"
          >
            <Folder className="size-4" />
          </button>
          <button
            type="button"
            className="workspace-sidebar-tab"
            onClick={() => onOpenSearch?.()}
            aria-label={t('sidebar.tabs.search')}
            title={t('sidebar.tabs.search')}
            data-testid="sidebar-tab-search"
          >
            <Search className="size-4" />
          </button>
        </div>
        {/* Workflows are reached via per-kitable virtual leaves now — the
            previous global header button was removed because it implied
            workflows are workspace-scoped, which conflicts with the
            trigger.tableId binding. */}
        {onToggleSidebar ? (
          <button
            type="button"
            className="workspace-sidebar-header-action"
            onClick={onToggleSidebar}
            aria-label={t('sidebar.collapseSidebar')}
            title={t('sidebar.collapseSidebar')}
          >
            <PanelLeftClose className="size-4" />
          </button>
        ) : null}
      </div>
      {loading ? (
        <div className="px-2.5 py-2">
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t('sidebar.loadingDirectory')}
          </div>
        </div>
      ) : (
        <>
          <div className="shrink-0 px-2.5 pb-2 pt-2" onDoubleClick={handleDesktopChromeDoubleClick}>
            <div className="document-private-heading">
              <button
                type="button"
                className="document-sidebar-section-toggle"
                onClick={onTogglePrivate}
                aria-label={privateExpanded ? t('sidebar.collapseSection', { name: workspaceDisplayName }) : t('sidebar.expandSection', { name: workspaceDisplayName })}
                title={rootPath || workspaceDisplayName}
              >
                {privateExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                <span>{workspaceDisplayName}</span>
              </button>
              <span className="relative document-create-menu-anchor">
                <button
                  ref={setHeaderCreateAnchor}
                  type="button"
                  className="document-private-create"
                  onClick={onOpenCreateMenu}
                  aria-label={t('sidebar.newPageIn', { name: workspaceDisplayName })}
                  title={t('sidebar.newPage')}
                >
                  <Plus className="size-4" />
                </button>
                <WorkspaceCreateMenu
                  open={createMenuOpen && createMenuTriggerPath === ''}
                  variant={createMenuVariant ?? 'workspace'}
                  anchorEl={headerCreateAnchor}
                  onCreateFolder={onCreateFolder}
                  onCreateTable={onCreateTable}
                  onCreateBoard={onCreateBoard}
                  onCreateDesign={onCreateDesign}
                  kitCreations={kitCreations}
                  onImportTableFile={onImportTableFile}
                  onCreateDocument={onCreateDocument}
                />
              </span>
              {onOpenWorkflows ? (
                <button
                  type="button"
                  className="document-private-create"
                  onClick={onOpenWorkflows}
                  aria-label={t('sidebar.openWorkflows')}
                  title={t('sidebar.workflows')}
                  data-testid="workspace-sidebar-workflows"
                >
                  <Zap className="size-3.5" />
                </button>
              ) : null}
              {onRefresh ? (
                <button
                  type="button"
                  className="document-private-create"
                  onClick={onRefresh}
                  aria-label={t('sidebar.refresh')}
                  title={t('sidebar.refresh')}
                >
                  <RefreshCw className="size-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          <div
            className={cn(
              'document-tree-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-lg px-2.5 pb-2',
              fileDragOver && 'bg-primary/5 ring-1 ring-inset ring-primary/40',
            )}
            data-testid="document-tree-drop-zone"
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            <div className="document-private-section">
              {privateExpanded ? treeContent : null}
              {mediaSections}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function snapshotClipboardFileEntries(clipboard: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = []
  const items = clipboard.items
  if (!items) {
    return entries
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.kind !== 'file') {
      continue
    }
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry) {
      entries.push(entry)
    }
  }
  return entries
}

async function collectFileSystemEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: WorkspaceImportEntry[],
): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry)
    if (!file || !file.name) {
      return
    }
    out.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name })
    return
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const reader = dirEntry.createReader()
    const children = await readAllDirectoryEntries(reader)
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    for (const child of children) {
      await collectFileSystemEntry(child, nextPrefix, out)
    }
  }
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}
