import { memo, useEffect } from 'react'
import { TableEditor } from '@/features/table/components/TableEditor'
import { registerOpenTable } from '@/features/table/lib/openTables'
import { KitionTableProviders } from '@/features/table/host/KitionTableProviders'
import { useDocumentReadOnly } from '@/services/documentAccess'
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
  // Co-editing follows the open `.kitable` files; a viewer of a shared one may only look.
  useEffect(() => (/\.kitable$/i.test(documentPath) ? registerOpenTable({ path: documentPath }) : undefined), [documentPath])
  const readOnly = useDocumentReadOnly(documentPath)
  return (
    <KitionTableProviders>
      <TableEditor
        agentOpen={agentOpen}
        documentPath={documentPath}
        markerContent={markerContent}
        pinnedTableId={pinnedTableId}
        onOpenDocument={onOpenDocument}
        onAgentContextChange={onAgentContextChange}
        onAgentOpenChange={onAgentOpenChange}
        readOnly={readOnly}
      />
    </KitionTableProviders>
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
