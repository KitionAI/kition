import {
  ArrowUpDown,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  GalleryHorizontalEnd,
  GripVertical,
  Group,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Rows3,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { DataField, DataFieldType } from '@/types/dataDocument'
import { Button, Input, Select } from '@/components/ui'
import {
  fieldTypes,
  getFieldIcon,
  getSortDirectionLabelKeys,
  type DataInlineGroupItem,
  type DataInlineSortItem,
  type GridRowHeightKey,
  type SortDirection,
} from '@/features/table/lib/tableEditorShared'
import { cn } from '@/lib/utils'

import { ToolbarPopover } from './TableEditorOverlays'

function FieldConfigRowMenu({
  field,
  isPrimary,
  busy,
  visible,
  onEdit,
  onDuplicate,
  onToggleVisibility,
  onDelete,
}: {
  field: DataField
  isPrimary: boolean
  busy: boolean
  visible: boolean
  onEdit: (field: DataField) => void
  onDuplicate: (field: DataField) => void
  onToggleVisibility: (field: DataField, nextVisible: boolean) => void
  onDelete: (field: DataField) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const { t } = useTranslation('table')

  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuWidth = 192
      const menuHeight = 168
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      let left = rect.right - menuWidth
      if (left < 8) left = 8
      if (left + menuWidth > viewportWidth - 8) left = viewportWidth - menuWidth - 8
      let top = rect.bottom + 4
      if (top + menuHeight > viewportHeight - 8) {
        top = Math.max(8, rect.top - menuHeight - 4)
      }
      setPosition({ top, left })
    }
    updatePosition()
    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        !popupRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const node = popupRef.current
    if (!node) return
    function stopPropagation(event: Event) {
      event.stopPropagation()
    }
    node.addEventListener('mousedown', stopPropagation)
    return () => node.removeEventListener('mousedown', stopPropagation)
  }, [open, position])

  function runAndClose(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <div className="data-inline-field-config-row-menu">
      <button
        ref={triggerRef}
        type="button"
        className="data-inline-field-config-row-menu-trigger"
        aria-label={t('toolbar.moreActions')}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popupRef}
              className="data-inline-field-config-row-menu-popup"
              style={{ top: position.top, left: position.left }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="data-inline-record-menu-item"
                disabled={busy}
                onClick={() => runAndClose(() => onEdit(field))}
              >
                <Pencil className="size-4" />
                {t('toolbar.editField')}
              </button>
              <button
                type="button"
                className="data-inline-record-menu-item"
                disabled={busy}
                onClick={() => runAndClose(() => onDuplicate(field))}
              >
                <Copy className="size-4" />
                {t('toolbar.duplicateField')}
              </button>
              {!isPrimary ? (
                <button
                  type="button"
                  className="data-inline-record-menu-item"
                  disabled={busy}
                  onClick={() =>
                    runAndClose(() => onToggleVisibility(field, !visible))
                  }
                >
                  {visible ? (
                    <>
                      <EyeOff className="size-4" />
                      {t('toolbar.hideField')}
                    </>
                  ) : (
                    <>
                      <Eye className="size-4" />
                      {t('toolbar.showField')}
                    </>
                  )}
                </button>
              ) : null}
              {!isPrimary ? (
                <button
                  type="button"
                  className="data-inline-record-menu-item is-danger"
                  disabled={busy}
                  onClick={() => runAndClose(() => onDelete(field))}
                >
                  <Trash2 className="size-4" />
                  {t('toolbar.deleteField')}
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

export function TableEditorFieldConfigControl({
  fields,
  hiddenFieldNames,
  open,
  onOpenChange,
  onResetHiddenFields,
  onToggleFieldVisibility,
  busy,
  onEditField,
  onDuplicateField,
  onDeleteField,
  onOpenAddField,
}: {
  fields: DataField[]
  hiddenFieldNames: Set<string>
  open: boolean
  onOpenChange: (open: boolean) => void
  onResetHiddenFields: () => void
  onToggleFieldVisibility: (fieldName: string, checked: boolean) => void
  busy: boolean
  onEditField: (field: DataField) => void
  onDuplicateField: (field: DataField) => void
  onDeleteField: (field: DataField) => void
  onOpenAddField: () => void
}) {
  const [query, setQuery] = useState('')
  const { t } = useTranslation('table')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const filteredFields = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return fields
    return fields.filter((field) =>
      field.title.toLowerCase().includes(needle),
    )
  }, [fields, query])

  function handleRowClick(field: DataField) {
    onOpenChange(false)
    onEditField(field)
  }

  function handleToggleVisibility(field: DataField, nextVisible: boolean) {
    if (field.is_primary) return
    onToggleFieldVisibility(field.name, nextVisible)
  }

  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--field-config"
      active={hiddenFieldNames.size > 0}
      icon={<Settings2 className="size-4" />}
      label={
        hiddenFieldNames.size
          ? t('toolbar.customizeFieldHidden', { count: hiddenFieldNames.size })
          : t('toolbar.customizeField')
      }
    >
      <div className="data-inline-field-config-search">
        <Search className="size-4" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('toolbar.searchPlaceholder')}
          autoFocus
        />
        {hiddenFieldNames.size ? (
          <button
            type="button"
            className="data-inline-field-config-show-all"
            onClick={onResetHiddenFields}
          >
            {t('toolbar.showAll')}
          </button>
        ) : null}
      </div>
      <div className="data-inline-field-config-list">
        {filteredFields.length === 0 ? (
          <div className="data-inline-field-config-empty">{t('toolbar.noFields')}</div>
        ) : (
          filteredFields.map((field) => {
            const isPrimary = Boolean(field.is_primary)
            const visible = !hiddenFieldNames.has(field.name)
            return (
              <div
                key={field.id}
                className="data-inline-field-config-row"
                role="button"
                tabIndex={0}
                onClick={() => handleRowClick(field)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    handleRowClick(field)
                  }
                }}
              >
                <span className="data-inline-field-config-icon">
                  {getFieldIcon(field)}
                </span>
                <span
                  className="data-inline-field-config-title"
                  title={field.title}
                >
                  {field.title}
                </span>
                <span
                  className="data-inline-field-config-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  {isPrimary ? (
                    <span
                      className="data-inline-field-config-lock"
                      title={t('toolbar.primaryField')}
                    >
                      <Lock className="size-3.5" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="data-inline-field-config-eye"
                      aria-label={visible ? t('toolbar.hideField') : t('toolbar.showField')}
                      title={visible ? t('toolbar.hideField') : t('toolbar.showField')}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleToggleVisibility(field, !visible)
                      }}
                    >
                      {visible ? (
                        <Eye className="size-4" />
                      ) : (
                        <EyeOff className="size-4" />
                      )}
                    </button>
                  )}
                  <FieldConfigRowMenu
                    field={field}
                    isPrimary={isPrimary}
                    busy={busy}
                    visible={visible}
                    onEdit={(target) => {
                      onOpenChange(false)
                      onEditField(target)
                    }}
                    onDuplicate={onDuplicateField}
                    onToggleVisibility={handleToggleVisibility}
                    onDelete={onDeleteField}
                  />
                </span>
              </div>
            )
          })
        )}
      </div>
      <button
        type="button"
        className="data-inline-field-config-add"
        onClick={() => {
          onOpenChange(false)
          onOpenAddField()
        }}
      >
        <Plus className="size-4" />
        {t('toolbar.addField')}
      </button>
    </ToolbarPopover>
  )
}

export function TableEditorHiddenFieldsControl({
  fields,
  hiddenFieldNames,
  open,
  onOpenChange,
  onResetHiddenFields,
  onToggleFieldVisibility,
}: {
  fields: DataField[]
  hiddenFieldNames: Set<string>
  open: boolean
  onOpenChange: (open: boolean) => void
  onResetHiddenFields: () => void
  onToggleFieldVisibility: (fieldName: string, checked: boolean) => void
}) {
  const { t } = useTranslation('table')
  const hiddenCount = hiddenFieldNames.size
  const label = hiddenCount ? t('toolbar.hiddenCount', { count: hiddenCount }) : t('toolbar.hideFields')

  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--hidden"
      active={hiddenCount > 0}
      icon={<EyeOff className="size-4" />}
      label={label}
      testId="kitable-toolbar-hidden-fields"
      menuTestId="kitable-toolbar-hidden-fields-menu"
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.fieldVisibility')}</strong>
        {hiddenCount ? (
          <button type="button" onClick={onResetHiddenFields}>
            {t('toolbar.showAll')}
          </button>
        ) : null}
      </div>
      <div className="data-inline-check-list">
        {fields.map((field) => {
          const visible = !hiddenFieldNames.has(field.name)
          const locked = Boolean(field.is_primary)
          return (
            <label key={field.id}>
              <input
                type="checkbox"
                checked={visible}
                disabled={locked}
                onChange={(event) =>
                  onToggleFieldVisibility(field.name, event.target.checked)
                }
              />
              <span>{field.title}</span>
              {locked ? (
                <span className="data-inline-toolbar-hint">{t('toolbar.primary')}</span>
              ) : null}
            </label>
          )
        })}
      </div>
    </ToolbarPopover>
  )
}

export function TableEditorSortControl({
  fields,
  sortFieldName,
  sortDirection,
  open,
  onOpenChange,
  onSortFieldNameChange,
  onSortDirectionChange,
  onClearSort,
}: {
  fields: DataField[]
  sortFieldName: string
  sortDirection: 'asc' | 'desc'
  open: boolean
  onOpenChange: (open: boolean) => void
  onSortFieldNameChange: (value: string) => void
  onSortDirectionChange: (value: 'asc' | 'desc') => void
  onClearSort: () => void
}) {
  const { t } = useTranslation('table')
  const sortLabel = sortFieldName
    ? `${fields.find((field) => field.name === sortFieldName)?.title || sortFieldName} ${sortDirection.toUpperCase()}`
    : t('toolbar.sort')

  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--sort"
      active={Boolean(sortFieldName)}
      icon={<ArrowUpDown className="size-4" />}
      label={sortLabel}
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.sortRecords')}</strong>
        <button type="button" onClick={onClearSort}>
          {t('toolbar.clear')}
        </button>
      </div>
      <div className="data-inline-toolbar-form">
        <Select
          value={sortFieldName}
          onChange={(event) => onSortFieldNameChange(event.target.value)}
        >
          <option value="">{t('toolbar.chooseField')}</option>
          {fields.map((field) => (
            <option key={field.id} value={field.name}>
              {field.title}
            </option>
          ))}
        </Select>
        <div className="data-inline-segmented">
          <button
            type="button"
            className={cn(sortDirection === 'asc' && 'is-active')}
            onClick={() => onSortDirectionChange('asc')}
            disabled={!sortFieldName}
          >
            ASC
          </button>
          <button
            type="button"
            className={cn(sortDirection === 'desc' && 'is-active')}
            onClick={() => onSortDirectionChange('desc')}
            disabled={!sortFieldName}
          >
            DESC
          </button>
        </div>
      </div>
    </ToolbarPopover>
  )
}

export function TableEditorGroupControl({
  groupFieldName,
  groupableFields,
  fields,
  open,
  onOpenChange,
  onGroupFieldNameChange,
  onClearGroup,
}: {
  groupFieldName: string
  groupableFields: DataField[]
  fields: DataField[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onGroupFieldNameChange: (value: string) => void
  onClearGroup: () => void
}) {
  const { t } = useTranslation('table')
  const groupLabel = groupFieldName
    ? t('toolbar.groupedBy', { title: fields.find((field) => field.name === groupFieldName)?.title || groupFieldName })
    : t('toolbar.group')

  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--group"
      active={Boolean(groupFieldName)}
      icon={<Group className="size-4" />}
      label={groupLabel}
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.groupRecords')}</strong>
        <button type="button" onClick={onClearGroup}>
          {t('toolbar.clear')}
        </button>
      </div>
      <div className="data-inline-toolbar-form">
        <Select
          value={groupFieldName}
          onChange={(event) => onGroupFieldNameChange(event.target.value)}
        >
          <option value="">{t('toolbar.noGroup')}</option>
          {groupableFields.map((field) => (
            <option key={field.id} value={field.name}>
              {field.title}
            </option>
          ))}
        </Select>
        <p className="data-inline-toolbar-hint">
          {t('toolbar.groupHint')}
        </p>
      </div>
    </ToolbarPopover>
  )
}

export function TableEditorCoverControl({
  coverField,
  coverFieldName,
  coverFields,
  open,
  onOpenChange,
  onCoverFieldNameChange,
  onResetCoverField,
}: {
  coverField: DataField | null
  coverFieldName: string
  coverFields: DataField[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCoverFieldNameChange: (value: string) => void
  onResetCoverField: () => void
}) {
  const { t } = useTranslation('table')
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--cover"
      active={Boolean(coverField)}
      icon={<GalleryHorizontalEnd className="size-4" />}
      label={coverField ? t('toolbar.coverWithField', { title: coverField.title }) : t('toolbar.coverField')}
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.galleryCover')}</strong>
        <button type="button" onClick={onResetCoverField}>
          {t('toolbar.auto')}
        </button>
      </div>
      <div className="data-inline-toolbar-form">
        <Select
          value={coverFieldName}
          onChange={(event) => onCoverFieldNameChange(event.target.value)}
        >
          <option value="">{t('toolbar.autoCover')}</option>
          {coverFields.map((field) => (
            <option key={field.id} value={field.name}>
              {field.title}
            </option>
          ))}
        </Select>
        <p className="data-inline-toolbar-hint">
          {t('toolbar.coverHint')}
        </p>
      </div>
    </ToolbarPopover>
  )
}

export function TableEditorAddPropertyControl({
  busy,
  newFieldTitle,
  newFieldType,
  open,
  onOpenChange,
  onClose,
  onNewFieldTitleChange,
  onNewFieldTypeChange,
  onAddField,
}: {
  busy: boolean
  newFieldTitle: string
  newFieldType: DataFieldType
  open: boolean
  onOpenChange: (open: boolean) => void
  onClose: () => void
  onNewFieldTitleChange: (value: string) => void
  onNewFieldTypeChange: (value: DataFieldType) => void
  onAddField: () => void
}) {
  const { t } = useTranslation('table')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus({ preventScroll: true })
  }, [open])

  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--field"
      active={Boolean(newFieldTitle.trim())}
      icon={<Plus className="size-4" />}
      label={t('toolbar.addProperty')}
      align="right"
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.addProperty')}</strong>
        <button type="button" onClick={onClose}>
          {t('toolbar.close')}
        </button>
      </div>
      <div className="data-inline-toolbar-form">
        <Input
          ref={inputRef}
          value={newFieldTitle}
          onChange={(event) => onNewFieldTitleChange(event.target.value)}
          placeholder={t('toolbar.propertyName')}
        />
        <Select
          value={newFieldType}
          onChange={(event) =>
            onNewFieldTypeChange(event.target.value as DataFieldType)
          }
        >
          {fieldTypes.map((fieldType) => (
            <option key={fieldType.value} value={fieldType.value}>
              {t(fieldType.labelKey)}
            </option>
          ))}
        </Select>
        <Button
          variant="outline"
          onClick={onAddField}
          disabled={busy || !newFieldTitle.trim()}
        >
          <Plus className="size-4" />
          {t('toolbar.addProperty')}
        </Button>
      </div>
    </ToolbarPopover>
  )
}

const rowHeightOptions: { value: GridRowHeightKey; labelKey: string }[] = [
  { value: 'short', labelKey: 'toolbar.rowHeight.short' },
  { value: 'medium', labelKey: 'toolbar.rowHeight.medium' },
  { value: 'tall', labelKey: 'toolbar.rowHeight.tall' },
  { value: 'extra_tall', labelKey: 'toolbar.rowHeight.extraTall' },
]

export function TableEditorRowHeightControl({
  rowHeightKey,
  open,
  onOpenChange,
  onRowHeightKeyChange,
}: {
  rowHeightKey: GridRowHeightKey
  open: boolean
  onOpenChange: (open: boolean) => void
  onRowHeightKeyChange: (value: GridRowHeightKey) => void
}) {
  const { t } = useTranslation('table')
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--row-height"
      active={false}
      icon={<Rows3 className="size-4" />}
      label={t('toolbar.rowHeightLabel')}
      testId="kitable-toolbar-row-height"
      menuTestId="kitable-toolbar-row-height-menu"
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.rowHeightLabel')}</strong>
      </div>
      <div className="data-inline-check-list">
        {rowHeightOptions.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="row-height"
              checked={rowHeightKey === option.value}
              onChange={() => {
                onRowHeightKeyChange(option.value)
                onOpenChange(false)
              }}
            />
            <span>{t(option.labelKey)}</span>
          </label>
        ))}
      </div>
    </ToolbarPopover>
  )
}

export function TableEditorFreezeControl({
  fields,
  frozenColumnCount,
  open,
  onOpenChange,
  onFrozenColumnCountChange,
}: {
  fields: DataField[]
  frozenColumnCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onFrozenColumnCountChange: (count: number) => void
}) {
  const { t } = useTranslation('table')
  const maxFreeze = Math.max(0, Math.min(fields.length, 5))
  const active = frozenColumnCount > 0
  const label = active ? String(frozenColumnCount) : ''
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--freeze"
      active={active}
      icon={<Pin className="size-4" />}
      label={label}
      testId="kitable-toolbar-freeze"
      menuTestId="kitable-toolbar-freeze-menu"
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.freezeColumns')}</strong>
      </div>
      <div className="data-inline-check-list">
        {Array.from({ length: maxFreeze + 1 }, (_, idx) => (
          <label key={idx}>
            <input
              type="radio"
              name="freeze-count"
              checked={frozenColumnCount === idx}
              onChange={() => {
                onFrozenColumnCountChange(idx)
                onOpenChange(false)
              }}
            />
            <span>
              {idx === 0
                ? t('toolbar.freezeNone')
                : t('toolbar.freezeColumnsCount', { count: idx })}
            </span>
          </label>
        ))}
      </div>
    </ToolbarPopover>
  )
}

function generateSortItemId() {
  return `sort_${Math.random().toString(36).slice(2, 10)}`
}

function generateGroupItemId() {
  return `group_${Math.random().toString(36).slice(2, 10)}`
}

function reorderArray<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function TableEditorMultiSortControl({
  fields,
  sortItems,
  open,
  onOpenChange,
  onSortItemsChange,
}: {
  fields: DataField[]
  sortItems: DataInlineSortItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSortItemsChange: (items: DataInlineSortItem[]) => void
}) {
  const { t } = useTranslation('table')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const fieldByName = new Map(fields.map((field) => [field.name, field]))
  const summary = sortItems.length === 0 ? t('toolbar.sort') : t('toolbar.sortCount', { count: sortItems.length })

  function addRule() {
    const usedNames = new Set(sortItems.map((item) => item.field_name))
    const next = fields.find((field) => !usedNames.has(field.name)) || fields[0]
    if (!next) return
    onSortItemsChange([
      ...sortItems,
      { id: generateSortItemId(), field_name: next.name, direction: 'asc' },
    ])
  }
  function removeRule(index: number) {
    onSortItemsChange(sortItems.filter((_, idx) => idx !== index))
  }
  function updateRule(index: number, patch: Partial<DataInlineSortItem>) {
    onSortItemsChange(
      sortItems.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
    )
  }
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--sort"
      active={sortItems.length > 0}
      icon={<ArrowUpDown className="size-4" />}
      label={summary}
      testId="kitable-toolbar-sort"
      menuTestId="kitable-toolbar-sort-menu"
      menuClassName="data-inline-toolbar-menu--rules"
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.sortRecords')}</strong>
        {sortItems.length > 0 ? (
          <button type="button" onClick={() => onSortItemsChange([])}>
            {t('toolbar.clearAll')}
          </button>
        ) : null}
      </div>
      <div className="data-inline-sort-list">
        {sortItems.map((item, index) => {
          const currentField = fieldByName.get(item.field_name)
          const directionLabelKeys = getSortDirectionLabelKeys(currentField?.type ?? 'text')
          return (
            <div
              key={item.id}
              className={cn('data-inline-sort-row', dragIndex === index && 'is-dragging')}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => {
                event.preventDefault()
                if (dragIndex !== null && dragIndex !== index) {
                  onSortItemsChange(reorderArray(sortItems, dragIndex, index))
                  setDragIndex(index)
                }
              }}
              onDragEnd={() => setDragIndex(null)}
            >
              <span className="data-inline-sort-handle" aria-hidden>
                <GripVertical className="size-3" />
              </span>
              <label className="data-inline-sort-field">
                <span className="data-inline-sort-field-icon" aria-hidden>
                  {currentField ? getFieldIcon(currentField) : null}
                </span>
                <span className="data-inline-sort-field-label">
                  {currentField?.title ?? item.field_name}
                </span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <select
                  value={item.field_name}
                  onChange={(event) => updateRule(index, { field_name: event.target.value })}
                  aria-label={t('toolbar.sortField')}
                >
                  {fields.map((field) => (
                    <option key={field.id} value={field.name}>
                      {field.title}
                    </option>
                  ))}
                </select>
              </label>
              <Select
                className="data-inline-sort-direction"
                value={item.direction}
                onChange={(event) =>
                  updateRule(index, { direction: event.target.value as SortDirection })
                }
                aria-label={t('toolbar.sortDirection')}
              >
                <option value="asc">{t(directionLabelKeys.asc)}</option>
                <option value="desc">{t(directionLabelKeys.desc)}</option>
              </Select>
              <button
                type="button"
                className="data-inline-sort-remove"
                onClick={() => removeRule(index)}
                aria-label={t('toolbar.removeSort')}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="data-inline-sort-add-link"
        onClick={addRule}
        disabled={sortItems.length >= fields.length || fields.length === 0}
      >
        <Plus className="size-3.5" />
        {t('toolbar.addAnotherSort')}
      </button>
    </ToolbarPopover>
  )
}

export function TableEditorMultiGroupControl({
  groupableFields,
  groupItems,
  open,
  onOpenChange,
  onGroupItemsChange,
}: {
  groupableFields: DataField[]
  groupItems: DataInlineGroupItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onGroupItemsChange: (items: DataInlineGroupItem[]) => void
}) {
  const { t } = useTranslation('table')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const fieldByName = new Map(groupableFields.map((field) => [field.name, field]))
  const summary =
    groupItems.length === 0
      ? t('toolbar.groupBy')
      : t('toolbar.groupByCount', { count: groupItems.length })

  function addRule() {
    const usedNames = new Set(groupItems.map((item) => item.field_name))
    const next = groupableFields.find((field) => !usedNames.has(field.name)) || groupableFields[0]
    if (!next) return
    onGroupItemsChange([
      ...groupItems,
      { id: generateGroupItemId(), field_name: next.name, direction: 'asc' },
    ])
  }
  function removeRule(index: number) {
    onGroupItemsChange(groupItems.filter((_, idx) => idx !== index))
  }
  function updateRule(index: number, patch: Partial<DataInlineGroupItem>) {
    onGroupItemsChange(
      groupItems.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
    )
  }
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={onOpenChange}
      buttonClassName="data-inline-toolbar-group--group"
      active={groupItems.length > 0}
      icon={<Group className="size-4" />}
      label={summary}
      testId="kitable-toolbar-group"
      menuTestId="kitable-toolbar-group-menu"
      menuClassName="data-inline-toolbar-menu--rules"
    >
      <div className="data-inline-toolbar-menu-head">
        <strong>{t('toolbar.groupRecords')}</strong>
        {groupItems.length > 0 ? (
          <button type="button" onClick={() => onGroupItemsChange([])}>
            {t('toolbar.clearAll')}
          </button>
        ) : null}
      </div>
      <div className="data-inline-sort-list">
        {groupItems.map((item, index) => {
          const currentField = fieldByName.get(item.field_name)
          const directionLabelKeys = getSortDirectionLabelKeys(currentField?.type ?? 'text')
          return (
            <div
              key={item.id}
              className={cn('data-inline-sort-row', dragIndex === index && 'is-dragging')}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => {
                event.preventDefault()
                if (dragIndex !== null && dragIndex !== index) {
                  onGroupItemsChange(reorderArray(groupItems, dragIndex, index))
                  setDragIndex(index)
                }
              }}
              onDragEnd={() => setDragIndex(null)}
            >
              <span className="data-inline-sort-handle" aria-hidden>
                <GripVertical className="size-3" />
              </span>
              <label className="data-inline-sort-field">
                <span className="data-inline-sort-field-icon" aria-hidden>
                  {currentField ? getFieldIcon(currentField) : null}
                </span>
                <span className="data-inline-sort-field-label">
                  {currentField?.title ?? item.field_name}
                </span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <select
                  value={item.field_name}
                  onChange={(event) => updateRule(index, { field_name: event.target.value })}
                  aria-label={t('toolbar.groupField')}
                >
                  {groupableFields.map((field) => (
                    <option key={field.id} value={field.name}>
                      {field.title}
                    </option>
                  ))}
                </select>
              </label>
              <Select
                className="data-inline-sort-direction"
                value={item.direction}
                onChange={(event) =>
                  updateRule(index, { direction: event.target.value as SortDirection })
                }
                aria-label={t('toolbar.groupDirection')}
              >
                <option value="asc">{t(directionLabelKeys.asc)}</option>
                <option value="desc">{t(directionLabelKeys.desc)}</option>
              </Select>
              <button
                type="button"
                className="data-inline-sort-remove"
                onClick={() => removeRule(index)}
                aria-label={t('toolbar.removeGroup')}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="data-inline-sort-add-link"
        onClick={addRule}
        disabled={groupItems.length >= groupableFields.length || groupableFields.length === 0}
      >
        <Plus className="size-3.5" />
        {t('toolbar.addAnotherGroup')}
      </button>
    </ToolbarPopover>
  )
}
