import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudOff,
  CloudUpload,
  Copy,
  ExternalLink,
  FileInput,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react'

import { getDataDocument } from '@/api/dataDocuments'
import { Button } from '@/registry/ui/button'
import { Input } from '@/registry/ui/input'
import { Switch } from '@/registry/ui/switch'
import type { DataField, DataTable } from '@/types/dataDocument'

import {
  getFormSyncWorkflow,
  syncFormSyncWorkflow,
  updateFormSyncWorkflow,
  type FormSyncFieldType,
  type FormSyncWorkflow,
} from './api'
import { createBuilderField, findTargetTable, type FormSyncBuilderField } from './formBuilder'

const fieldTypes: Array<{ value: FormSyncFieldType; label: string }> = [
  { value: 'text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'datetime', label: 'Date and time' },
  { value: 'select', label: 'Select' },
]

export function FormSyncWorkflowPage({ workflowId }: { workflowId: string }) {
  const [workflow, setWorkflow] = useState<FormSyncWorkflow | null>(null)
  const [targetTable, setTargetTable] = useState<DataTable | null>(null)
  const [name, setName] = useState('')
  const [fields, setFields] = useState<FormSyncBuilderField[]>([])
  const [scheduleEnabled, setScheduleEnabled] = useState(true)
  const [intervalMinutes, setIntervalMinutes] = useState(5)
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'syncing'>('loading')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')

  const hydrate = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const nextWorkflow = await getFormSyncWorkflow(workflowId)
      const document = await getDataDocument(Number(nextWorkflow.target.document_id))
      const table = findTargetTable(document.tables, nextWorkflow.target.table_id) || null
      const mappings = new Map(nextWorkflow.target.field_mappings.map((mapping) => (
        [mapping.source_key, mapping.target_field_title]
      )))
      setWorkflow(nextWorkflow)
      setTargetTable(table)
      setName(nextWorkflow.name)
      setFields(nextWorkflow.fields.map((field) => ({
        ...field,
        targetFieldTitle: mappings.get(field.key) || '',
      })))
      setScheduleEnabled(nextWorkflow.schedule.enabled)
      setIntervalMinutes(nextWorkflow.schedule.interval_minutes)
      setStatus('idle')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load form')
      setStatus('idle')
    }
  }, [workflowId])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const targetFields = useMemo(
    () => (targetTable?.fields || []).filter((field) => !field.readonly),
    [targetTable?.fields],
  )

  function updateField(index: number, patch: Partial<FormSyncBuilderField>) {
    setFields((current) => current.map((field, fieldIndex) => (
      fieldIndex === index ? { ...field, ...patch } : field
    )))
  }

  function moveField(index: number, direction: -1 | 1) {
    setFields((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function persist(published = workflow?.published) {
    if (!workflow) return
    const validationError = validateFields(fields)
    if (validationError) {
      setError(validationError)
      return
    }
    setStatus('saving')
    setError('')
    setFeedback('')
    try {
      const nextWorkflow = await updateFormSyncWorkflow(workflow.id, {
        name: name.trim(),
        fields: fields.map(({ targetFieldTitle: _targetFieldTitle, ...field }) => ({
          ...field,
          ...(field.type === 'select'
            ? { options: (field.options || []).map((option) => option.trim()).filter(Boolean) }
            : { options: undefined }),
        })),
        target: {
          ...workflow.target,
          field_mappings: fields.map((field) => ({
            source_key: field.key,
            target_field_title: field.targetFieldTitle,
          })),
        },
        schedule: {
          enabled: scheduleEnabled,
          interval_minutes: Math.max(1, Math.min(1440, intervalMinutes || 5)),
        },
        published,
      })
      setWorkflow(nextWorkflow)
      setFeedback(published && !workflow.published ? 'Form published.' : published === false && workflow.published ? 'Form unpublished.' : 'Changes saved.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save form')
    } finally {
      setStatus('idle')
    }
  }

  async function syncNow() {
    if (!workflow?.published) return
    setStatus('syncing')
    setError('')
    setFeedback('')
    try {
      const result = await syncFormSyncWorkflow(workflow.id)
      setFeedback(`Sync complete: ${result.imported} imported, ${result.skipped} skipped.`)
      await hydrate()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to sync form')
      setStatus('idle')
    }
  }

  async function copyPublicURL() {
    if (!workflow?.public_url) return
    await navigator.clipboard.writeText(workflow.public_url)
    setFeedback('Public link copied.')
  }

  if (status === 'loading' && !workflow) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading form…</div>
  }

  if (!workflow) {
    return <div className="flex h-full items-center justify-center text-sm text-destructive">{error || 'Form not found'}</div>
  }

  return (
    <div className="h-full min-h-0 overflow-auto bg-muted/25" data-testid="form-sync-workflow-page">
      <div className="mx-auto grid max-w-[1440px] gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0 space-y-5">
          <header className="rounded-xl border bg-background p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <FileInput className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-lg font-semibold">Form builder</h1>
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${workflow.published ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                      {workflow.published ? 'Published' : 'Draft'}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Submissions create records in {targetTable?.title || 'the destination table'}.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {workflow.published ? (
                  <Button variant="outline" onClick={() => void persist(false)} disabled={status !== 'idle'}>
                    <CloudOff /> Unpublish
                  </Button>
                ) : (
                  <Button onClick={() => void persist(true)} disabled={status !== 'idle'}>
                    <CloudUpload /> Publish
                  </Button>
                )}
                <Button variant="outline" onClick={() => void persist()} disabled={status !== 'idle'}>
                  <Save /> Save changes
                </Button>
              </div>
            </div>
            {workflow.public_url ? (
              <div className="mt-4 flex min-w-0 items-center gap-2 rounded-lg border bg-muted/30 p-2">
                <code className="min-w-0 flex-1 truncate px-2 text-xs">{workflow.public_url}</code>
                <Button size="iconSm" variant="ghost" label="Copy public link" onClick={() => void copyPublicURL()}><Copy /></Button>
                <Button
                  size="iconSm"
                  variant="ghost"
                  label="Open public form"
                  onClick={() => window.open(workflow.public_url, '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink />
                </Button>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
                Configure the draft locally. A public URL will be created only when you publish.
              </div>
            )}
          </header>

          <section className="rounded-xl border bg-background shadow-sm">
            <div className="border-b p-5">
              <h2 className="font-semibold">Form details</h2>
              <p className="mt-1 text-sm text-muted-foreground">Set the public title and destination field mapping.</p>
            </div>
            <div className="grid gap-4 p-5">
              <label className="grid gap-2 text-sm font-medium">
                Form title
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <div className="grid gap-3">
                {fields.map((field, index) => (
                  <FormFieldEditor
                    key={field.key}
                    field={field}
                    index={index}
                    total={fields.length}
                    targetFields={targetFields}
                    onChange={(patch) => updateField(index, patch)}
                    onMove={(direction) => moveField(index, direction)}
                    onDelete={() => setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}
                  />
                ))}
                <Button
                  variant="outline"
                  className="w-full border-dashed"
                  onClick={() => setFields((current) => [
                    ...current,
                    createBuilderField(current, targetFields[0]?.title || ''),
                  ])}
                  disabled={targetFields.length === 0}
                >
                  <Plus /> Add field
                </Button>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-background p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">Automatic import</h2>
                <p className="mt-1 text-sm text-muted-foreground">Pull published submissions into the desktop table.</p>
              </div>
              <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} aria-label="Automatic import" />
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="grid gap-2 text-sm font-medium">
                Sync every
                <span className="flex items-center gap-2">
                  <Input
                    className="w-24"
                    type="number"
                    min={1}
                    max={1440}
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                    disabled={!scheduleEnabled}
                  />
                  <span className="font-normal text-muted-foreground">minutes</span>
                </span>
              </label>
              <Button variant="outline" onClick={() => void syncNow()} disabled={!workflow.published || status !== 'idle'}>
                <RefreshCw className={status === 'syncing' ? 'animate-spin' : ''} /> Sync now
              </Button>
            </div>
            <div className="mt-4 grid gap-1 text-xs text-muted-foreground">
              <span>{workflow.synced_submissions} submissions processed</span>
              <span>Last sync: {workflow.last_sync_at ? new Date(workflow.last_sync_at).toLocaleString() : 'Never'}</span>
              {workflow.last_error ? <span className="text-destructive">{workflow.last_error}</span> : null}
            </div>
          </section>

          {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
          {feedback ? <p className="flex items-center gap-2 rounded-lg border bg-background p-3 text-sm"><Check className="size-4 text-emerald-600" />{feedback}</p> : null}
        </section>

        <FormPreview name={name} fields={fields} published={workflow.published} />
      </div>
    </div>
  )
}

function FormFieldEditor({
  field,
  index,
  total,
  targetFields,
  onChange,
  onMove,
  onDelete,
}: {
  field: FormSyncBuilderField
  index: number
  total: number
  targetFields: DataField[]
  onChange: (patch: Partial<FormSyncBuilderField>) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}) {
  return (
    <div className="rounded-xl border bg-muted/15 p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(150px,1fr)_150px_minmax(150px,1fr)_auto]">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Label
          <Input value={field.label} onChange={(event) => onChange({ label: event.target.value })} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Type
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={field.type}
            onChange={(event) => {
              const type = event.target.value as FormSyncFieldType
              onChange({ type, ...(type === 'select' ? { options: field.options?.length ? field.options : ['Option 1'] } : { options: undefined }) })
            }}
          >
            {fieldTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Save to table field
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={field.targetFieldTitle}
            onChange={(event) => onChange({ targetFieldTitle: event.target.value })}
          >
            <option value="">Select field</option>
            {targetFields.map((target) => <option key={target.id} value={target.title}>{target.title}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-1">
          <Button size="iconSm" variant="ghost" label="Move field up" onClick={() => onMove(-1)} disabled={index === 0}><ArrowUp /></Button>
          <Button size="iconSm" variant="ghost" label="Move field down" onClick={() => onMove(1)} disabled={index === total - 1}><ArrowDown /></Button>
          <Button size="iconSm" variant="ghost" label="Delete field" onClick={onDelete} disabled={total === 1}><Trash2 /></Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={field.required} onCheckedChange={(required) => onChange({ required })} />
          Required
        </label>
        {field.type === 'select' ? (
          <label className="flex min-w-[260px] flex-1 items-center gap-2 text-sm">
            <span className="shrink-0 text-muted-foreground">Options</span>
            <Input
              value={(field.options || []).join(', ')}
              onChange={(event) => onChange({ options: event.target.value.split(',').map((option) => option.trim()) })}
              placeholder="Option 1, Option 2"
            />
          </label>
        ) : null}
      </div>
    </div>
  )
}

function FormPreview({ name, fields, published }: { name: string; fields: FormSyncBuilderField[]; published: boolean }) {
  return (
    <aside className="xl:sticky xl:top-5 xl:self-start">
      <div className="overflow-hidden rounded-xl border bg-background shadow-[var(--shadow-soft)]">
        <div className="flex items-center justify-between border-b bg-background px-4 py-3">
          <span className="text-sm font-medium">Live preview</span>
          <span className="text-xs text-muted-foreground">{published ? 'Public' : 'Local draft'}</span>
        </div>
        <div className="bg-muted/35 p-5">
          <div
            className="rounded-xl border bg-background p-6 shadow-[var(--shadow-soft)]"
            data-testid="form-sync-preview-card"
          >
            <h2 className="text-xl font-semibold text-foreground">{name.trim() || 'Untitled form'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Complete the form below and submit your details.</p>
            <div className="mt-6 grid gap-4">
              {fields.map((field) => (
                <label key={field.key} className="grid gap-1.5 text-sm font-medium text-foreground">
                  <span>{field.label || 'Untitled field'}{field.required ? ' *' : ''}</span>
                  {field.type === 'long_text' ? (
                    <textarea disabled className="min-h-24 rounded-lg border border-input bg-background p-2 text-foreground disabled:opacity-100" />
                  ) : field.type === 'select' ? (
                    <select disabled className="h-10 rounded-lg border border-input bg-background px-2 text-foreground disabled:opacity-100">
                      <option>Select an option</option>
                      {(field.options || []).filter(Boolean).map((option) => <option key={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input
                      disabled
                      type={previewInputType(field.type)}
                      placeholder={previewInputPlaceholder(field.type)}
                      className="h-10 rounded-lg border border-input bg-background px-2 text-foreground placeholder:text-muted-foreground disabled:opacity-100"
                    />
                  )}
                </label>
              ))}
              <button
                type="button"
                disabled
                className="mt-1 h-10 rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:cursor-default disabled:opacity-100"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}

function previewInputType(type: FormSyncFieldType) {
  if (type === 'email' || type === 'number') return type
  if (type === 'phone') return 'tel'
  return 'text'
}

function previewInputPlaceholder(type: FormSyncFieldType) {
  return type === 'datetime' ? 'YYYY-MM-DD HH:MM' : undefined
}

function validateFields(fields: FormSyncBuilderField[]) {
  if (fields.length === 0) return 'Add at least one form field.'
  for (const field of fields) {
    if (!field.label.trim()) return 'Every field needs a label.'
    if (!field.targetFieldTitle.trim()) return `Choose a destination table field for ${field.label}.`
    if (field.type === 'select' && !(field.options || []).some((option) => option.trim())) {
      return `${field.label} needs at least one option.`
    }
  }
  return ''
}
