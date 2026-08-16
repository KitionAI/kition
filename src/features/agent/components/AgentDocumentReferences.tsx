import { ChevronDown, FileText, Folder, X } from 'lucide-react'

import { cn } from '@/lib/utils'

export type AgentDocumentReference = {
  path: string
  kind?: 'file' | 'folder'
  current?: boolean
}

type AgentDocumentReferencesProps = {
  references: AgentDocumentReference[]
  onOpen?: (path: string) => void
  onRemove?: (path: string) => void
  className?: string
}

function getReferenceName(path: string) {
  return path.split('/').filter(Boolean).pop() || path
}

function ReferenceIcon({ kind }: { kind?: 'file' | 'folder' }) {
  return kind === 'folder'
    ? <Folder className="size-3.5 shrink-0" />
    : <FileText className="size-3.5 shrink-0" />
}

function ReferenceRow({
  reference,
  onOpen,
  onRemove,
}: {
  reference: AgentDocumentReference
  onOpen?: (path: string) => void
  onRemove?: (path: string) => void
}) {
  const name = getReferenceName(reference.path)
  const content = (
    <>
      <ReferenceIcon kind={reference.kind} />
      <span className="agent-document-reference__name">{name}</span>
    </>
  )

  return (
    <div className="agent-document-reference" title={reference.path}>
      {onOpen ? (
        <button
          type="button"
          className="agent-document-reference__main"
          onClick={() => onOpen(reference.path)}
        >
          {content}
        </button>
      ) : (
        <span className="agent-document-reference__main">{content}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          className="agent-document-reference__remove"
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          onClick={() => onRemove(reference.path)}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function AgentDocumentReferences({
  references,
  onOpen,
  onRemove,
  className,
}: AgentDocumentReferencesProps) {
  if (!references.length) {
    return null
  }
  if (references.length === 1) {
    return (
      <div className={cn('agent-document-references', className)}>
        <ReferenceRow
          reference={references[0]}
          onOpen={onOpen}
          onRemove={onRemove}
        />
      </div>
    )
  }

  const allFiles = references.every((reference) => reference.kind !== 'folder')
  return (
    <details
      className={cn('agent-document-references agent-document-references--select', className)}
    >
      <summary data-testid="agent-document-reference-select">
        <FileText className="size-3.5 shrink-0" />
        <span>{references.length} {allFiles ? 'files' : 'references'}</span>
        <ChevronDown className="agent-document-references__chevron size-3.5 shrink-0" />
      </summary>
      <div className="agent-document-references__menu">
        {references.map((reference) => (
          <ReferenceRow
            key={reference.path}
            reference={reference}
            onOpen={onOpen}
            onRemove={onRemove}
          />
        ))}
      </div>
    </details>
  )
}
