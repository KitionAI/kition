import { useEffect, useMemo, useState } from 'react'
import { FileInputIcon as FileInput } from '@kition/tessera-icons/react'

import { listTableFiles, type KitTablesTable } from '@/api/kitTables'
import { Button, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle, TextInput } from '@kition/tessera-ui'
import { createFormSyncWorkflow, type FormSyncWorkflow } from './api'
import { buildInitialFormFields, findTargetTable, loadFormTargetTable } from './formBuilder'

export function FormSyncCreateDialog({
  open,
  documentPath,
  initialTableId,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  /** The table file the form writes to. */
  documentPath: string
  initialTableId?: string
  onOpenChange: (open: boolean) => void
  onCreated: (workflow: FormSyncWorkflow) => void
}) {
  const [tables, setTables] = useState<KitTablesTable[] | null>(null)
  const [tableId, setTableId] = useState('')
  const [name, setName] = useState('New form')
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !documentPath) return
    let cancelled = false
    setStatus('loading')
    setError('')
    void listTableFiles()
      .then(({ files }) => {
        if (cancelled) return
        const nextTables = files.find((file) => file.path === documentPath)?.tables ?? []
        setTables(nextTables)
        const selected = findTargetTable(nextTables, String(initialTableId || ''))
          || nextTables[0]
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
  }, [documentPath, initialTableId, open])

  const selectedTable = useMemo(
    () => findTargetTable(tables ?? undefined, tableId),
    [tables, tableId],
  )

  async function createDraft() {
    if (!selectedTable || !name.trim()) return
    setStatus('saving')
    setError('')
    try {
      const fields = buildInitialFormFields(await loadFormTargetTable(documentPath, selectedTable.id))
      if (fields.length === 0) {
        setError('The selected table has no fields that can be used in a form.')
        return
      }
      const published = false
      const workflow = await createFormSyncWorkflow({
        name: name.trim(),
        template_id: createCustomTemplateId(),
        fields: fields.map(({ targetFieldTitle: _targetFieldTitle, ...field }) => field),
        target: {
          document_path: documentPath,
          table_id: selectedTable.id,
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
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="lg" className="gap-0 p-0" data-testid="form-sync-create-dialog">
        <ModalHeader className="space-y-2 border-b px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileInput className="size-4" />
            </span>
            <div>
              <ModalTitle>Create form</ModalTitle>
              <ModalDescription>Start as a local draft. You can configure and publish it when ready.</ModalDescription>
            </div>
          </div>
        </ModalHeader>
        <div className="grid gap-5 px-6 py-5">
          <label className="grid gap-2 text-sm font-medium">
            Form name
            <TextInput size="lg" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Destination table
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary"
              value={tableId}
              onChange={(event) => {
                const nextId = event.target.value
                setTableId(nextId)
                const table = findTargetTable(tables ?? undefined, nextId)
                if (table?.title) setName(`${table.title} form`)
              }}
              disabled={status === 'loading'}
            >
              {(tables || []).map((table) => (
                <option key={table.id} value={table.id}>{table.title || table.name}</option>
              ))}
            </select>
          </label>
          <div className="rounded-xl border bg-muted/35 p-4 text-sm text-muted-foreground">
            Compatible table fields will be added automatically. Nothing is sent to Kition Cloud until you publish the form.
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <ModalFooter className="border-t px-6 py-4">
          <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" variant="primary"
            onClick={() => void createDraft()}
            disabled={!selectedTable || !name.trim() || status !== 'idle'}
            loading={status === 'saving'}
          >
            Create draft
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

function createCustomTemplateId() {
  const token = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `custom-form-${token.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}
