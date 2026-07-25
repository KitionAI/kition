import { useTranslation } from 'react-i18next'

import { FieldReferenceChip } from './FieldReferenceChip'
import type { BodyPart, BodyTemplate, FieldSchema, TableSchema } from './BodyTemplateEditor.types'

export interface BodyTemplateEditorProps {
  template: BodyTemplate
  triggerNodeTitle: string
  triggerNodeId?: string
  schema: TableSchema
  readOnly?: boolean
  onChange?: (template: BodyTemplate) => void
}

export function BodyTemplateEditor({ template, triggerNodeTitle, triggerNodeId = 'trigger_1', schema, readOnly = true, onChange }: BodyTemplateEditorProps) {
  const { t } = useTranslation('workflow')
  const byId = new Map<string, FieldSchema>(schema.fields.map((f) => [f.id, f]))
  const parts = template.parts || []

  const updatePart = (index: number, next: BodyPart) => {
    onChange?.({ parts: parts.map((part, i) => (i === index ? next : part)) })
  }

  const removePart = (index: number) => {
    onChange?.({ parts: parts.filter((_, i) => i !== index) })
  }

  const appendPart = (part: BodyPart) => {
    onChange?.({ parts: [...parts, part] })
  }

  if (!readOnly) {
    const fieldRefCount = parts.filter((part) => part.kind === 'field_ref').length
    return (
      <div data-testid="body-template-editor" data-readonly="false" className="overflow-hidden rounded-md border border-border bg-muted/40">
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-card px-2 py-1.5">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
            onClick={() => appendPart({ kind: 'text', text: '' })}
            data-testid="body-add-text"
          >
            {t('panels.bodyEditor.addText')}
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
            onClick={() => appendPart({ kind: 'newline' })}
            data-testid="body-add-newline"
          >
            {t('panels.bodyEditor.addNewline')}
          </button>
          <select
            aria-label={t('panels.bodyEditor.insertField')}
            data-testid="body-insert-field"
            className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground"
            defaultValue=""
            onChange={(event) => {
              const fieldId = event.target.value
              if (!fieldId) return
              appendPart({ kind: 'field_ref', fieldRef: { nodeId: triggerNodeId, fieldId } })
              event.target.value = ''
            }}
          >
            <option value="">{t('panels.bodyEditor.insertField')}</option>
            {schema.fields.map((field) => (
              <option key={field.id} value={field.id}>{field.name}</option>
            ))}
          </select>
        </div>
        <div className="min-h-36 p-3 text-sm leading-relaxed text-foreground" data-testid="body-template-editable-parts">
          {parts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {t('panels.bodyEditor.emptyHint')}
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            {parts.map((part, i) => {
              if (part.kind === 'text') {
                return (
                  <div key={i} className="flex items-start gap-2">
                    <textarea
                      data-testid="body-text-part"
                      className="min-h-10 flex-1 resize-y rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                      value={part.text}
                      placeholder={t('panels.bodyEditor.typeBodyText')}
                      onChange={(event) => updatePart(i, { kind: 'text', text: event.target.value })}
                    />
                    <RemoveButton onClick={() => removePart(i)} />
                  </div>
                )
              }
              if (part.kind === 'newline') {
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground">{t('panels.bodyEditor.newLineChip')}</span>
                    <RemoveButton onClick={() => removePart(i)} />
                  </div>
                )
              }
              const field = byId.get(part.fieldRef.fieldId)
              return (
                <div key={i} className="flex items-center gap-2">
                  {field ? (
                    <FieldReferenceChip nodeTitle={triggerNodeTitle} fieldName={field.name} fieldType={field.type} />
                  ) : (
                    <span data-testid="field-ref-missing" className="rounded border border-dashed border-destructive px-2 py-1 text-xs text-destructive">
                      {t('panels.bodyEditor.missingField', { id: part.fieldRef.fieldId })}
                    </span>
                  )}
                  <RemoveButton onClick={() => removePart(i)} />
                </div>
              )
            })}
          </div>
        </div>
        <div className="flex items-center border-t border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
          {t('panels.bodyEditor.fieldsUsed', { count: fieldRefCount })}
          <span className="ml-auto text-primary">{t('panels.bodyEditor.previewSampleData')}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="body-template-editor"
      data-readonly={readOnly ? 'true' : 'false'}
      className="min-h-[80px] whitespace-pre-wrap rounded-lg border border-border bg-card px-2.5 py-2.5 text-[13px] leading-relaxed text-foreground"
    >
      {parts.map((part, i) => renderPart(part, i, byId, triggerNodeTitle, t))}
    </div>
  )
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('workflow')
  return (
    <button
      type="button"
      className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive"
      onClick={onClick}
      data-testid="body-remove-part"
      aria-label={t('panels.bodyEditor.removeBodyPartAria')}
    >
      {t('panels.bodyEditor.remove')}
    </button>
  )
}

function renderPart(part: BodyPart, i: number, fields: Map<string, FieldSchema>, nodeTitle: string, t: (key: string, opts?: Record<string, unknown>) => string) {
  switch (part.kind) {
    case 'text': return <span key={i}>{part.text}</span>
    case 'newline': return <br key={i} />
    case 'field_ref': {
      const f = fields.get(part.fieldRef.fieldId)
      if (!f) {
        return (
          <span key={i} data-testid="field-ref-missing" className="rounded-md border border-dashed border-destructive px-1.5 py-0.5 text-destructive">
            {t('panels.bodyEditor.missingFieldPreview', { id: part.fieldRef.fieldId })}
          </span>
        )
      }
      return <FieldReferenceChip key={i} nodeTitle={nodeTitle} fieldName={f.name} fieldType={f.type} />
    }
  }
}
