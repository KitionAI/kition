import { ListPlus, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { createEmptyFilterCondition, createEmptyFilterGroup, type FilterGroup, type FilterNode } from '../types'
import { ConjunctionSelect } from './ConjunctionSelect'
import { FilterConditionRow } from './FilterConditionRow'

const MAX_DEPTH = 2

export function FilterGroupRow({
  fields,
  group,
  depth,
  onUpdate,
  onRemove,
  showRemove,
}: {
  fields: DataField[]
  group: FilterGroup
  depth: number
  onUpdate: (next: FilterGroup) => void
  onRemove: () => void
  showRemove: boolean
}) {
  const { t } = useTranslation('table')
  function updateChild(index: number, next: FilterNode | null) {
    const children = group.children.slice()
    if (next === null) children.splice(index, 1)
    else children[index] = next
    onUpdate({ ...group, children })
  }
  function addCondition() {
    onUpdate({ ...group, children: [...group.children, createEmptyFilterCondition()] })
  }
  function addGroup() {
    onUpdate({ ...group, children: [...group.children, createEmptyFilterGroup('and')] })
  }
  return (
    <div className={cn('data-inline-filter-group', depth > 0 && 'data-inline-filter-group--nested')}>
      <div className="data-inline-filter-group-head">
        <ConjunctionSelect value={group.conjunction} onChange={(c) => onUpdate({ ...group, conjunction: c })} />
        {showRemove ? (
          <button
            type="button"
            className="data-inline-filter-remove"
            onClick={onRemove}
            aria-label={t('filter.removeGroup')}
            title={t('filter.removeGroup')}
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="data-inline-filter-children">
        {group.children.map((child, idx) =>
          child.kind === 'condition' ? (
            <FilterConditionRow
              key={child.id}
              fields={fields}
              condition={child}
              onUpdate={(next) => updateChild(idx, next)}
              onRemove={() => updateChild(idx, null)}
            />
          ) : (
            <FilterGroupRow
              key={child.id}
              fields={fields}
              group={child}
              depth={depth + 1}
              onUpdate={(next) => updateChild(idx, next)}
              onRemove={() => updateChild(idx, null)}
              showRemove
            />
          ),
        )}
      </div>
      <div className="data-inline-filter-actions">
        <Button variant="outline" size="sm" onClick={addCondition}>
          <Plus className="size-3.5" />
          {t('filter.addCondition')}
        </Button>
        <Button variant="outline" size="sm" onClick={addGroup} disabled={depth >= MAX_DEPTH - 1}>
          <ListPlus className="size-3.5" />
          {t('filter.addConditionGroup')}
        </Button>
      </div>
    </div>
  )
}
