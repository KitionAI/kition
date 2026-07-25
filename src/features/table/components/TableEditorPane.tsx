import { memo } from 'react'
import { TableEditor } from '@/features/table/components/TableEditor'
import type { DataDocument, DataTable } from '@/types/dataDocument'

export const TableEditorPane = memo(function TableEditorPane({
  agentOpen,
  documentPath,
  markerContent,
  pinnedTableId,
  onOpenDocument,
  onAgentContextChange,
  onAgentOpenChange,
}: {
  agentOpen: boolean
  documentPath: string
  markerContent: string
  pinnedTableId?: number
  onOpenDocument?: (path: string) => void
  onAgentContextChange?: (context: {
    documentPath: string
    activeDocument: DataDocument | null
    activeTable: DataTable | null
    onTableChanged?: () => Promise<void> | void
  }) => void
  onAgentOpenChange: (open: boolean) => void
}) {
  return (
    <TableEditor
      agentOpen={agentOpen}
      documentPath={documentPath}
      markerContent={markerContent}
      pinnedTableId={pinnedTableId}
      onOpenDocument={onOpenDocument}
      onAgentContextChange={onAgentContextChange}
      onAgentOpenChange={onAgentOpenChange}
    />
  )
}, (previous, next) => (
  previous.agentOpen === next.agentOpen
  && previous.documentPath === next.documentPath
  && previous.markerContent === next.markerContent
  && previous.pinnedTableId === next.pinnedTableId
  && previous.onOpenDocument === next.onOpenDocument
  && previous.onAgentContextChange === next.onAgentContextChange
  && previous.onAgentOpenChange === next.onAgentOpenChange
))
