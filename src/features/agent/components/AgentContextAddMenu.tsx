import { FileCheck2, FilePlus2, FileText, FolderPlus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AgentContextAddMenu({
  disabled = false,
  currentDocumentTitle,
  currentDocumentAttached = false,
  localSourceCount,
  onAddCurrentDocument,
  onAddLocalSource,
  onRequestDocumentReference,
}: {
  disabled?: boolean
  currentDocumentTitle?: string
  currentDocumentAttached?: boolean
  localSourceCount: number
  onAddCurrentDocument?: () => void
  onAddLocalSource?: () => void
  onRequestDocumentReference: () => void
}) {
  const { t } = useTranslation('agent')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  return (
    <div className="agent-context-add relative shrink-0" ref={menuRef}>
      <button
        type="button"
        className="agent-context-add__trigger inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
        onClick={() => setMenuOpen((current) => !current)}
        disabled={disabled}
        aria-label={t('analysisWorkspace.addContext')}
        title={t('analysisWorkspace.addContext')}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <Plus className="size-4" aria-hidden="true" />
      </button>
      {menuOpen ? (
        <div
          className="agent-context-add__menu absolute bottom-[calc(100%+8px)] left-0 z-30 w-60 overflow-hidden rounded-xl border bg-card p-1 shadow-lg"
          role="menu"
          style={{ borderColor: 'var(--document-border, hsl(var(--border)))' }}
        >
          {currentDocumentTitle && onAddCurrentDocument ? (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-60"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onAddCurrentDocument()
              }}
              disabled={currentDocumentAttached}
            >
              {currentDocumentAttached ? (
                <FileCheck2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
              ) : (
                <FilePlus2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate text-xs font-medium text-foreground">
                  {t('analysisWorkspace.addCurrentDocument', { name: currentDocumentTitle })}
                </strong>
                <small className="text-[11px] text-muted-foreground">
                  {currentDocumentAttached
                    ? t('mentions.attached')
                    : t('analysisWorkspace.referenceDocument')}
                </small>
              </span>
            </button>
          ) : null}
          {onAddLocalSource ? (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-45"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onAddLocalSource()
              }}
              disabled={localSourceCount >= 8}
            >
              <FolderPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="text-xs font-medium text-foreground">{t('analysisWorkspace.localFolder')}</strong>
                <small className="text-[11px] text-muted-foreground">{t('analysisWorkspace.readOnly')}</small>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-45"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              onRequestDocumentReference()
            }}
          >
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="text-xs font-medium text-foreground">{t('analysisWorkspace.workspaceDocument')}</strong>
              <small className="text-[11px] text-muted-foreground">{t('analysisWorkspace.referenceDocument')}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
