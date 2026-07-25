import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { DrawerField, DrawerSection } from '@/features/workflow/drawer/PropertiesDrawer'

/**
 * FilterPropertiesPanel is the right-hand drawer rendered when the user
 * selects a filter node. The plan calls for a three-segment builder
 * (field, operator, value) — for v1 we expose a single expression text
 * area plus a small example helper. Once we have a real field picker
 * wired to the trigger schema this becomes the conditions list.
 */
export interface FilterCondition {
  id: string
  field: string
  op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'startsWith' | 'endsWith' | 'in'
  value: string
}

export interface FilterPropertiesPanelProps {
  conditions: FilterCondition[]
  mode: 'all' | 'any'
  /** Field paths the user can pick — populated from the trigger schema
   *  (e.g. trigger_1.priority). */
  availableFields: string[]
  expressionPreview: string
  onChange: (next: { conditions: FilterCondition[]; mode: 'all' | 'any' }) => void
  /** Dry-run controls. When present, the panel renders a "Run with sample"
   *  button that calls onDryRun and surfaces the boolean result. dryRun
   *  is the latest result; null means "never tried yet"; loading shows the
   *  intermediate spinner. */
  onDryRun?: () => void | Promise<void>
  dryRun?: { matched: boolean; reason?: string } | null
  dryRunLoading?: boolean
}

const OPERATORS: FilterCondition['op'][] = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'startsWith', 'endsWith', 'in']

export function FilterPropertiesPanel({
  conditions,
  mode,
  availableFields,
  expressionPreview,
  onChange,
  onDryRun,
  dryRun,
  dryRunLoading,
}: FilterPropertiesPanelProps) {
  const { t } = useTranslation('workflow')
  return (
    <>
      <DrawerSection title={t('panels.filter.matchSection')}>
        <div className="mb-3 flex gap-1.5" data-testid="filter-mode-chips">
          <ModeChip active={mode === 'all'} onClick={() => onChange({ conditions, mode: 'all' })} testId="filter-mode-all">
            {t('panels.filter.modeAll')}
          </ModeChip>
          <ModeChip active={mode === 'any'} onClick={() => onChange({ conditions, mode: 'any' })} testId="filter-mode-any">
            {t('panels.filter.modeAny')}
          </ModeChip>
        </div>
        <div className="rounded-lg border border-border bg-muted/40 p-2">
          {conditions.map((cond, index) => (
            <div key={cond.id} data-testid={`filter-expr-row-${index}`}>
              {index > 0 ? (
                <div className="my-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {mode === 'all' ? t('panels.filter.joinAnd') : t('panels.filter.joinOr')}
                </div>
              ) : null}
              <div className="flex items-center gap-1.5">
                <select
                  data-testid={`filter-expr-row-${index}-field`}
                  className="flex-[1.6] rounded-md border border-primary/30 bg-primary/15 px-2 py-1 text-[12px] font-medium text-primary"
                  value={cond.field}
                  onChange={(event) => {
                    const next = conditions.map((c, i) => i === index ? { ...c, field: event.target.value } : c)
                    onChange({ conditions: next, mode })
                  }}
                >
                  <option value="">{t('panels.filter.chooseField')}</option>
                  {availableFields.map((field) => (
                    <option key={field} value={field}>{field}</option>
                  ))}
                </select>
                <select
                  data-testid={`filter-expr-row-${index}-op`}
                  className="w-20 rounded-md border border-border bg-card px-2 py-1 text-center text-[12px]"
                  value={cond.op}
                  onChange={(event) => {
                    const next = conditions.map((c, i) => i === index ? { ...c, op: event.target.value as FilterCondition['op'] } : c)
                    onChange({ conditions: next, mode })
                  }}
                >
                  {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
                <input
                  data-testid={`filter-expr-row-${index}-value`}
                  className="flex-1 rounded-md border border-border bg-card px-2 py-1 text-[12px]"
                  value={cond.value}
                  onChange={(event) => {
                    const next = conditions.map((c, i) => i === index ? { ...c, value: event.target.value } : c)
                    onChange({ conditions: next, mode })
                  }}
                />
                <button
                  type="button"
                  aria-label={t('panels.filter.removeCondition')}
                  className="text-destructive hover:text-destructive"
                  data-testid={`filter-expr-row-${index}-remove`}
                  onClick={() => {
                    const next = conditions.filter((_, i) => i !== index)
                    onChange({ conditions: next, mode })
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            data-testid="filter-expr-add-condition"
            className="mt-2 w-full rounded-md border border-dashed border-border bg-transparent px-3 py-1.5 text-[12px] text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() => {
              const next: FilterCondition = {
                id: `cond_${Date.now().toString(36)}`,
                field: availableFields[0] || '',
                op: '==',
                value: '',
              }
              onChange({ conditions: [...conditions, next], mode })
            }}
          >
            {t('panels.filter.addCondition')}
          </button>
        </div>
      </DrawerSection>

      <DrawerSection title={t('panels.filter.noMatchSection')}>
        <p className="m-0 text-[12px] text-muted-foreground">
          {t('panels.filter.noMatchBodyPre')}<code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">{t('panels.filter.noMatchBodySkipped')}</code>{t('panels.filter.noMatchBodyPost')}
        </p>
      </DrawerSection>

      <DrawerSection title={t('panels.filter.previewSection')}>
        <DrawerField label={t('panels.filter.previewLabel')}>
          <pre
            data-testid="filter-expr-preview"
            className="m-0 whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px] text-foreground"
          >
            {expressionPreview || t('panels.filter.previewEmpty')}
          </pre>
        </DrawerField>
      </DrawerSection>

      {onDryRun ? (
        <DrawerSection title={t('panels.filter.drySection')}>
          <button
            type="button"
            data-testid="filter-dryrun-button"
            onClick={() => { void onDryRun() }}
            disabled={dryRunLoading}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-[12px] text-foreground hover:border-primary hover:text-primary disabled:opacity-50"
          >
            {dryRunLoading ? t('panels.filter.dryRunning') : t('panels.filter.dryRunButton')}
          </button>
          {dryRun ? (
            <div
              data-testid="filter-dryrun-result"
              data-matched={dryRun.matched ? 'true' : 'false'}
              className={`mt-2 rounded-md px-3 py-2 text-[12px] ${
                dryRun.matched
                  ? 'bg-success/15 text-success-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {dryRun.matched
                ? t('panels.filter.dryMatched')
                : t('panels.filter.dryNotMatched')}
              {dryRun.reason ? <div className="mt-1 text-[11px] text-muted-foreground">{dryRun.reason}</div> : null}
            </div>
          ) : null}
        </DrawerSection>
      ) : null}
    </>
  )
}

function ModeChip({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean
  onClick: () => void
  testId?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[11px] font-medium ${
        active
          ? 'border-primary/30 bg-primary/15 text-primary'
          : 'border-border bg-card text-muted-foreground hover:bg-muted/40'
      }`}
    >
      {children}
    </button>
  )
}

/** Compile the structured conditions into the canonical DSL string the
 *  server stores. Empty conditions list compiles to "" which the parser
 *  treats as "match all". */
export function compileFilterExpression(conditions: FilterCondition[], mode: 'all' | 'any'): string {
  const fragments = conditions
    .filter((c) => c.field && c.op)
    .map((c) => {
      const valueLit = formatValueLiteral(c.value, c.op)
      return `${c.field} ${c.op} ${valueLit}`
    })
  if (!fragments.length) return ''
  const join = mode === 'all' ? ' and ' : ' or '
  return fragments.join(join)
}

function formatValueLiteral(raw: string, op: FilterCondition['op']): string {
  const value = raw.trim()
  if (value === 'true' || value === 'false') return value
  if (op === 'in') {
    // Comma-separated list; quote each item.
    const items = value.split(',').map((item) => `"${item.trim()}"`).join(', ')
    return `[${items}]`
  }
  if (!isNaN(Number(value)) && value !== '') return value
  return `"${value.replace(/"/g, '\\"')}"`
}

/** Inverse of compileFilterExpression for v1 — best-effort parse so the
 *  user can edit existing filters without re-deriving them from scratch.
 *  Returns the parsed conditions or null if the expression doesn't fit
 *  the canonical shape (in which case the UI keeps the raw text editor). */
export function parseFilterExpression(expression: string): { conditions: FilterCondition[]; mode: 'all' | 'any' } | null {
  if (!expression.trim()) return { conditions: [], mode: 'all' }
  // Detect mode by separator. We only handle pure-and / pure-or for now;
  // mixed forms fall through to raw editing.
  const isAnd = / and /.test(expression)
  const isOr = / or /.test(expression)
  if (isAnd && isOr) return null
  const sep = isAnd ? ' and ' : isOr ? ' or ' : null
  const parts = sep ? expression.split(sep) : [expression]
  const conditions: FilterCondition[] = []
  for (const part of parts) {
    const match = part.trim().match(/^([\w.]+)\s+(==|!=|>=|<=|>|<|contains|startsWith|endsWith|in)\s+(.+)$/)
    if (!match) return null
    let value = match[3].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    conditions.push({
      id: `cond_${conditions.length}`,
      field: match[1],
      op: match[2] as FilterCondition['op'],
      value,
    })
  }
  return { conditions, mode: isOr ? 'any' : 'all' }
}
