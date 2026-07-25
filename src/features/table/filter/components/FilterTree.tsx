import type { DataField } from '@/types/dataDocument'
import { createEmptyFilterGroup, type FilterGroup } from '../types'
import { FilterGroupRow } from './FilterGroupRow'

export function FilterTree({
  fields,
  value,
  onChange,
}: {
  fields: DataField[]
  value: FilterGroup | null
  onChange: (next: FilterGroup | null) => void
}) {
  const group = value ?? createEmptyFilterGroup('and')
  return (
    <FilterGroupRow
      fields={fields}
      group={group}
      depth={0}
      onUpdate={(next) => onChange(next.children.length === 0 ? null : next)}
      onRemove={() => onChange(null)}
      showRemove={false}
    />
  )
}
