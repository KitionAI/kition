import { Database, FileCode2, FileImage, FileSpreadsheet, FileText, Folder, FolderLock, PenTool, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentLocalSource } from '@/api/agent'
import type { AgentDocumentReference } from './AgentDocumentReferences'

export function AgentComposerContext({ documents, sources, disabled = false, onOpenPath, onRemoveDocument, onRemoveSource }: {
  documents: AgentDocumentReference[]
  sources: AgentLocalSource[]
  disabled?: boolean
  onOpenPath?: (path: string) => void
  onRemoveDocument: (path: string) => void
  onRemoveSource?: (sourceId: string) => void
}) {
  const { t } = useTranslation('agent')
  const count = documents.length + sources.length
  if (!count) return null
  return (
    <div className="agent-composer-context" role="list" aria-label={t('analysisWorkspace.contextCount', { count })}
      data-testid="agent-composer-context">
      {documents.map((document) => {
        const name = basename(document.path)
        const Icon = referenceIcon(document)
        return <span key={document.path} role="listitem" className="agent-composer-reference" data-testid="agent-composer-reference">
          <button type="button" className="agent-composer-reference__name" title={document.path}
            aria-description={document.current ? t('analysisWorkspace.current') : undefined}
            disabled={!onOpenPath} onClick={() => onOpenPath?.(document.path)}>
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{name}</span>
          </button>
          <button type="button" className="agent-composer-reference__remove" disabled={disabled}
            title={t('analysisWorkspace.removeReference', { name })}
            aria-label={t('analysisWorkspace.removeReference', { name })}
            onClick={() => onRemoveDocument(document.path)}><X className="size-3" aria-hidden="true" /></button>
        </span>
      })}
      {sources.map((source) => <span key={source.id} role="listitem" className="agent-composer-reference" data-testid="agent-composer-reference">
        <span className="agent-composer-reference__name" title={`${source.label} · ${t('analysisWorkspace.readOnlySource')}`}>
          <FolderLock className="size-3.5 shrink-0" aria-label={t('analysisWorkspace.readOnlySource')} />
          <span className="truncate">{source.label}</span>
        </span>
        {onRemoveSource ? <button type="button" className="agent-composer-reference__remove" disabled={disabled}
          title={t('analysisWorkspace.removeSource', { name: source.label })}
          aria-label={t('analysisWorkspace.removeSource', { name: source.label })}
          onClick={() => onRemoveSource(source.id)}><X className="size-3" aria-hidden="true" /></button> : null}
      </span>)}
    </div>
  )
}

function basename(path: string) { return path.split(/[\\/]/).filter(Boolean).pop() || path }

function referenceIcon(document: AgentDocumentReference) {
  if (document.kind === 'folder') return Folder
  const extension = document.path.split('.').pop()?.toLowerCase()
  if (extension === 'kiboard') return PenTool
  if (extension === 'sql') return Database
  if (/^(kitable|csv|xlsx?|tsv)$/.test(extension || '')) return FileSpreadsheet
  if (/^(png|jpe?g|webp|gif|svg|avif)$/.test(extension || '')) return FileImage
  if (/^(tsx?|jsx?|go|py|rs|java|json|ya?ml|sh|css|html)$/.test(extension || '')) return FileCode2
  return FileText
}
