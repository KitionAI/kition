import {
  FileText,
  FolderLock,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentLocalSource } from '@/api/agent'
import type { AgentDocumentReference } from '@/features/agent/components/AgentDocumentReferences'
import { cn } from '@/lib/utils'

type AgentContextTrayProps = {
  documents: AgentDocumentReference[]
  sources: AgentLocalSource[]
  disabled?: boolean
  onOpenPath?: (path: string) => void
  onRemoveDocument: (path: string) => void
  onRemoveSource?: (sourceId: string) => void
}

export function AgentContextTray({
  documents,
  sources,
  disabled = false,
  onOpenPath,
  onRemoveDocument,
  onRemoveSource,
}: AgentContextTrayProps) {
  const { t } = useTranslation('agent')
  const hasContext = Boolean(documents.length || sources.length)

  if (!hasContext) {
    return null
  }

  return (
    <div className="agent-context-tray" data-testid="agent-context-tray">
      <div className="agent-context-tray__header">
        <span>{t('analysisWorkspace.contextTitle')}</span>
      </div>

      <div className="agent-context-tray__items">
        {documents.map((document) => (
          <ContextChip
            key={document.path}
            className="is-document"
            icon={document.kind === 'folder'
              ? <FolderLock className="size-3.5" aria-hidden="true" />
              : <FileText className="size-3.5" aria-hidden="true" />}
            label={getPathBasename(document.path)}
            title={document.path}
            onOpen={onOpenPath ? () => onOpenPath(document.path) : undefined}
            onRemove={() => onRemoveDocument(document.path)}
            removeLabel={t('analysisWorkspace.removeReference', {
              name: getPathBasename(document.path),
            })}
          />
        ))}
        {sources.map((source) => (
          <ContextChip
            key={source.id}
            className="is-source"
            icon={<FolderLock className="size-3.5" aria-hidden="true" />}
            label={source.label}
            title={`${source.label} · ${t('analysisWorkspace.readOnlySource')}`}
            onRemove={onRemoveSource && !disabled
              ? () => onRemoveSource(source.id)
              : undefined}
            removeLabel={t('analysisWorkspace.removeSource', { name: source.label })}
          />
        ))}
      </div>
    </div>
  )
}

function ContextChip({
  className,
  icon,
  label,
  title,
  onOpen,
  onRemove,
  removeLabel,
}: {
  className?: string
  icon: ReactNode
  label: string
  title: string
  onOpen?: () => void
  onRemove?: () => void
  removeLabel?: string
}) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
    </>
  )
  return (
    <div className={cn('agent-context-chip', className)} title={title}>
      {onOpen ? (
        <button type="button" className="agent-context-chip__main" onClick={onOpen}>
          {content}
        </button>
      ) : (
        <span className="agent-context-chip__main">{content}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          className="agent-context-chip__remove"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

function getPathBasename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
