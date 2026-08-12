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
    <div
      className="agent-context-tray mb-2 flex flex-col gap-1 border-b pb-2"
      data-testid="agent-context-tray"
      style={{ borderColor: 'var(--document-border, hsl(var(--border)))' }}
    >
      <div className="agent-context-tray__header flex min-h-6 items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('analysisWorkspace.contextTitle')}
        </span>
      </div>

      <div
        className="agent-context-tray__items flex min-w-0 flex-wrap content-start gap-1.5 overflow-y-auto pr-1"
        style={{
          maxHeight: '3.875rem',
          overscrollBehavior: 'contain',
          scrollbarColor: 'hsl(var(--muted-foreground) / 0.28) transparent',
          scrollbarWidth: 'thin',
        }}
      >
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
      <span className="min-w-0 truncate font-medium">{label}</span>
    </>
  )
  return (
    <div
      className={cn(
        'agent-context-chip flex h-7 min-w-0 max-w-[14rem] items-center overflow-hidden rounded-md border bg-card text-xs text-foreground',
        className,
      )}
      title={title}
      style={{ borderColor: 'var(--document-border, hsl(var(--border)))' }}
    >
      {onOpen ? (
        <button
          type="button"
          className="agent-context-chip__main flex h-full min-w-0 items-center gap-1.5 px-2 text-left transition-colors hover:bg-muted/60"
          onClick={onOpen}
        >
          {content}
        </button>
      ) : (
        <span className="agent-context-chip__main flex h-full min-w-0 items-center gap-1.5 px-2 text-left">
          {content}
        </span>
      )}
      {onRemove ? (
        <button
          type="button"
          className="agent-context-chip__remove grid h-full w-7 shrink-0 place-items-center border-l text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          style={{ borderColor: 'var(--document-border, hsl(var(--border)))' }}
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
