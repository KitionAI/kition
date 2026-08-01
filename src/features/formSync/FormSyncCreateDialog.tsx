import { useEffect, useMemo, useState } from 'react'
import { FileInput } from 'lucide-react'

import { getDataDocument } from '@/api/dataDocuments'
import { Button } from '@/registry/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { Input } from '@/registry/ui/input'
import type { DataDocument, DataTable } from '@/types/dataDocument'

import { createFormSyncWorkflow, type FormSyncWorkflow } from './api'
import { buildInitialFormFields, findTargetTable } from './formBuilder'

export function FormSyncCreateDialog({
  open,
  documentId,
  initialTableId,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  documentId: string
  initialTableId?: number
  onOpenChange: (open: boolean) => void
  onCreated: (workflow: FormSyncWorkflow) => void
}) {
  const [document, setDocument] = useState<DataDocument | null>(null)
  const [tableId, setTableId] = useState('')
  const [name, setName] = useState('New form')
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !documentId) return
    let cancelled = false
    setStatus('loading')
    setError('')
    void getDataDocument(Number(documentId))
      .then((nextDocument) => {
        if (cancelled) return
        setDocument(nextDocument)
        const selected = findTargetTable(nextDocument.tables, String(initialTableId || ''))
          || nextDocument.tables?.[0]
        setTableId(selected?.id != null ? String(selected.id) : '')
        setName(selected?.title ? `${selected.title} form` : 'New form')
        setStatus('idle')
      })
      .catch((requestError) => {
        if (cancelled) return
        setError(requestError instanceof Error ? requestError.message : 'Failed to load tables')
        setStatus('idle')
      })
    return () => { cancelled = true }
  }, [documentId, initialTableId, open])

  const selectedTable = useMemo(
    () => findTargetTable(document?.tables, tableId),
    [document?.tables, tableId],
  )

  async function createDraft() {
    if (!selectedTable || !name.trim()) return
    const fields = buildInitialFormFields(selectedTable)
    if (fields.length === 0) {
      setError('The selected table has no fields that can be used in a form.')
      return
    }
    setStatus('saving')
    setError('')
    try {
      const published = false
      const workflow = await createFormSyncWorkflow({
        name: name.trim(),
        template_id: createCustomTemplateId(),
        fields: fields.map(({ targetFieldTitle: _targetFieldTitle, ...field }) => field),
        target: {
          document_id: documentId,
          table_id: String(selectedTable.id),
          field_mappings: fields.map((field) => ({
            source_key: field.key,
            target_field_title: field.targetFieldTitle,
          })),
        },
        schedule: { enabled: true, interval_minutes: 5 },
        published,
      })
      onCreated(workflow)
      onOpenChange(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to create form')
    } finally {
      setStatus('idle')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="gap-0 p-0" data-testid="form-sync-create-dialog">
        <DialogHeader className="space-y-2 border-b px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileInput className="size-4" />
            </span>
            <div>
              <DialogTitle>Create form</DialogTitle>
              <DialogDescription>Start as a local draft. You can configure and publish it when ready.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="grid gap-5 px-6 py-5">
          <label className="grid gap-2 text-sm font-medium">
            Form name
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Destination table
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary"
              value={tableId}
              onChange={(event) => {
                const nextId = event.target.value
                setTableId(nextId)
                const table = findTargetTable(document?.tables, nextId)
                if (table?.title) setName(`${table.title} form`)
              }}
              disabled={status === 'loading'}
            >
              {(document?.tables || []).map((table: DataTable) => (
                <option key={table.id} value={table.id}>{table.title || table.name}</option>
              ))}
            </select>
          </label>
          <div className="rounded-xl border bg-muted/35 p-4 text-sm text-muted-foreground">
            Compatible table fields will be added automatically. Nothing is sent to Kition Cloud until you publish the form.
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => void createDraft()}
            disabled={!selectedTable || !name.trim() || status !== 'idle'}
            loading={status === 'saving'}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function createCustomTemplateId() {
  const token = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `custom-form-${token.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}
