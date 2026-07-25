import { useCallback, useState } from 'react'

/**
 * useConnectionsModalState — owns the open / editing-id pair the
 * connection-settings modal hangs off of.
 *
 * Extracted from WorkflowHomePage (WF-C1i). The page had three different
 * sites that needed to open the modal (action-panel "Configure SMTP"
 * button, drawer empty-connection slot, drawer's "Edit connection" link)
 * and each was repeating the same two-setter dance. Folding it into a
 * hook gives the page a single fat result object: `openCreate()`,
 * `openEdit(id)`, `close()`, plus the controlled `isOpen` / `editingId`
 * the modal binds to.
 *
 * State is intentionally minimal — the actual ConnectionView list lives
 * elsewhere (useConnectionsList or whichever data hook owns it) and the
 * modal looks up by id on render.
 */
export interface UseConnectionsModalStateResult {
  isOpen: boolean
  editingId: string | null
  openCreate: () => void
  openEdit: (id: string | null) => void
  close: () => void
}

export function useConnectionsModalState(): UseConnectionsModalStateResult {
  const [isOpen, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const openCreate = useCallback(() => {
    setEditingId(null)
    setOpen(true)
  }, [])

  const openEdit = useCallback((id: string | null) => {
    setEditingId(id)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setEditingId(null)
  }, [])

  return { isOpen, editingId, openCreate, openEdit, close }
}
