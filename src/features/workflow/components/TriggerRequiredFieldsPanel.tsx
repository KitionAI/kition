import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { fieldTypeIcon, fieldTypeLabel } from '@/features/workflow/lib/fieldTypeIcon'

/**
 * TriggerRequiredFieldsPanel — the "And the selected field is not empty"
 * gate borrowed from Feishu (see WorkflowHomePage trigger drawer).
 *
 * Renders one checkbox per field on the bound trigger table; ticking a
 * field adds its ID to `value`, unticking removes it. The list is
 * AND-only (per the V1 design decision): every checked field must be
 * non-empty on the trigger record or the workflow is silently skipped.
 *
 * Semantics:
 * - Empty `value` (or omitted) disables the gate — every record fires.
 *   That's the empty state the panel renders when nothing is checked.
 * - Numeric `0` and boolean `false` count as NON-empty (the Go
 *   IsFieldValueEmpty truth table is the source of truth; this panel
 *   only manages the *list*, not the emptiness check).
 * - Field IDs that no longer exist on the schema are still rendered as
 *   greyed-out "(removed)" rows so the user can untick them without
 *   silently losing the gate. The server's ValidateAgainstSchema would
 *   reject them on Save → Enable anyway, but exposing the stale entry
 *   lets the user fix it from the same panel rather than hunting
 *   through validation errors.
 *
 * Hidden for trigger types where the gate doesn't apply (scheduled_time)
 * — that decision lives in the caller (WorkflowHomePage), which only
 * mounts this panel for record-bearing triggers.
 */
export interface TriggerRequiredFieldsPanelProps {
  /** Selected field IDs (the checked-on list). */
  value: string[]
  /** Bound table's schema. `null` when the user hasn't picked a table
   *  yet — the panel renders an instructional empty state in that case
   *  instead of an empty checkbox list. */
  schema: TableSchema | null
  /** Fires with the next selection. Caller is responsible for routing
   *  this into the PATCH /v1/workflows/:id payload (the backend uses
   *  pointer semantics so `[]` clears the gate and absent leaves it). */
  onChange: (next: string[]) => void
  /** Disables every interaction. Set during a save round-trip so the
   *  user can't queue overlapping patches. */
  disabled?: boolean
}

export function TriggerRequiredFieldsPanel({
  value,
  schema,
  onChange,
  disabled,
}: TriggerRequiredFieldsPanelProps) {
  const { t } = useTranslation('workflow')
  // De-dupe selected IDs so toggling stays idempotent even if the
  // upstream definition somehow accumulated duplicates (defensive — the
  // store's defensive copy makes this unlikely, but the panel is the
  // last line of defence before the user sees the UI).
  const selected = useMemo(() => new Set(value), [value])
  const schemaFieldIds = useMemo(
    () => new Set((schema?.fields || []).map((f) => f.id)),
    [schema],
  )
  // Selected IDs that no longer exist on the schema. Shown as separate
  // "(removed)" rows below the live fields so the user can untick them.
  const staleIds = useMemo(
    () => value.filter((id) => !schemaFieldIds.has(id)),
    [value, schemaFieldIds],
  )

  function toggle(fieldId: string, checked: boolean) {
    if (disabled) return
    if (checked) {
      if (selected.has(fieldId)) return
      onChange([...value, fieldId])
    } else {
      onChange(value.filter((id) => id !== fieldId))
    }
  }

  // No table bound yet — the table dropdown above this panel handles the
  // primary "draft" call to action, so we just nudge the user.
  if (!schema) {
    return (
      <div
        data-testid="workflow-home-trigger-required-fields"
        data-state="no-schema"
        className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground"
      >
        {t('panels.triggerRequiredFields.emptyNoSchema')}
      </div>
    )
  }

  const fields = schema.fields || []
  const liveSelectedCount = value.filter((id) => schemaFieldIds.has(id)).length

  return (
    <div data-testid="workflow-home-trigger-required-fields" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="m-0 text-[11px] font-medium leading-snug text-foreground">
          {t('panels.triggerRequiredFields.headerPre')}<strong>{t('panels.triggerRequiredFields.headerBold')}</strong>{t('panels.triggerRequiredFields.headerPost')}
        </p>
        <span
          data-testid="workflow-home-trigger-required-fields-count"
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            liveSelectedCount > 0
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {liveSelectedCount === 0
            ? t('panels.triggerRequiredFields.badgeOptional')
            : t('panels.triggerRequiredFields.badgeRequired', { count: liveSelectedCount })}
        </span>
      </div>
      <p className="m-0 text-[11px] leading-snug text-muted-foreground">
        {t('panels.triggerRequiredFields.caption')}
      </p>

      {fields.length === 0 ? (
        <div
          data-testid="workflow-home-trigger-required-fields-empty"
          className="rounded-md border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground"
        >
          {t('panels.triggerRequiredFields.noFields')}
        </div>
      ) : (
        <ul
          className="m-0 max-h-56 list-none overflow-y-auto rounded-md border border-border bg-card p-1"
          data-testid="workflow-home-trigger-required-fields-list"
        >
          {fields.map((field) => {
            const checked = selected.has(field.id)
            return (
              <li key={field.id}>
                <label
                  data-testid={`workflow-home-trigger-required-fields-row-${field.id}`}
                  data-checked={checked ? 'true' : 'false'}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-muted/40 ${
                    disabled ? 'cursor-not-allowed opacity-60' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-[hsl(var(--primary))] disabled:cursor-not-allowed"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => toggle(field.id, e.target.checked)}
                    data-testid={`workflow-home-trigger-required-fields-checkbox-${field.id}`}
                  />
                  <span
                    aria-hidden
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold text-muted-foreground"
                    title={fieldTypeLabel(field.type)}
                  >
                    {fieldTypeIcon(field.type)}
                  </span>
                  <span className="truncate text-foreground">{field.name}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {staleIds.length > 0 ? (
        <div
          data-testid="workflow-home-trigger-required-fields-stale"
          className="rounded-md border border-dashed border-warning/50 bg-warning/10 p-1"
        >
          <p className="m-0 px-2 pb-1 pt-1.5 text-[11px] font-medium text-warning-foreground">
            {t('panels.triggerRequiredFields.staleHeader', { count: staleIds.length })}
          </p>
          <ul className="m-0 list-none">
            {staleIds.map((id) => (
              <li key={id}>
                <div
                  data-testid={`workflow-home-trigger-required-fields-stale-row-${id}`}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-[12px]"
                >
                  <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold text-muted-foreground">
                    ?
                  </span>
                  <span className="truncate font-mono text-[11px] text-warning-foreground" title={id}>{id}</span>
                  <span className="text-[10px] uppercase tracking-wide text-warning-foreground">{t('panels.triggerRequiredFields.staleRemovedTag')}</span>
                  <button
                    type="button"
                    data-testid={`workflow-home-trigger-required-fields-stale-remove-${id}`}
                    className="ml-auto rounded border border-warning/50 bg-card px-2 py-0.5 text-[11px] font-medium text-warning-foreground hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => toggle(id, false)}
                    disabled={disabled}
                  >
                    {t('panels.triggerRequiredFields.staleRemoveButton')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
