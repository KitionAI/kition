import { Filter } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { DataField } from '@/types/dataDocument'
import { ToolbarPopover } from '@/features/table/components/TableEditorOverlays'
import { countFilterConditions, filterTreeHasActiveCondition } from '../evaluate'
import type { FilterGroup } from '../types'
import { FilterTree } from './FilterTree'

function describeActive(
  value: FilterGroup | null,
  fields: DataField[],
  t: TFunction,
): { label: string; active: boolean } {
  const conditionCount = countFilterConditions(value)
  if (!filterTreeHasActiveCondition(value)) return { label: t('filter.filter'), active: false }
  // Collect distinct field titles touched by active conditions.
  const titles = new Set<string>()
  function walk(node: FilterGroup): void {
    for (const c of node.children) {
      if (c.kind === 'group') walk(c)
      else {
        const f = fields.find((x) => x.name === c.field_name)
        if (f) titles.add(f.title)
      }
    }
  }
  if (value) walk(value)
  if (titles.size === 1) {
    const [only] = Array.from(titles)
    return { label: t('filter.filterByField', { title: only }), active: true }
  }
  if (titles.size > 1) return { label: t('filter.filterByFields', { count: titles.size }), active: true }
  return { label: t('filter.filterCount', { count: conditionCount }), active: true }
}

export function FilterPopover({
  open,
  onOpenChange,
  fields,
  value,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fields: DataField[]
  value: FilterGroup | null
  onChange: (next: FilterGroup | null) => void
}) {
  const { t } = useTranslation('table')
  const { label, active } = describeActive(value, fields, t)
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--filter"
      menuClassName="data-inline-toolbar-menu--filter"
      active={active}
      icon={<Filter className="size-4" />}
      label={label}
      testId="kitable-toolbar-filter"
      menuTestId="kitable-toolbar-filter-menu"
    >
      <div className="data-inline-filter-popover">
        <FilterTree fields={fields} value={value} onChange={onChange} />
      </div>
    </ToolbarPopover>
  )
}
