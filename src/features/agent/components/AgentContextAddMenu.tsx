import { FileText, FolderPlus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AgentContextAddMenu({
  disabled = false,
  localSourceCount,
  onAddLocalSource,
  onRequestDocumentReference,
}: {
  disabled?: boolean
  localSourceCount: number
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
    <div className="agent-context-add" ref={menuRef}>
      <button
        type="button"
        className="agent-context-add__trigger"
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
        <div className="agent-context-add__menu" role="menu">
          {onAddLocalSource ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onAddLocalSource()
              }}
              disabled={localSourceCount >= 8}
            >
              <FolderPlus className="size-4" aria-hidden="true" />
              <span>
                <strong>{t('analysisWorkspace.localFolder')}</strong>
                <small>{t('analysisWorkspace.readOnly')}</small>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              onRequestDocumentReference()
            }}
          >
            <FileText className="size-4" aria-hidden="true" />
            <span>
              <strong>{t('analysisWorkspace.workspaceDocument')}</strong>
              <small>{t('analysisWorkspace.referenceDocument')}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
