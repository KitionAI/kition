import type { DataField } from '@/types/dataDocument'

export function reorderTableFields(
  fields: DataField[],
  visibleFields: DataField[],
  sourceFieldId: number,
  dropIndex: number,
): DataField[] {
  const sourceIndex = visibleFields.findIndex((field) => field.id === sourceFieldId)
  if (sourceIndex < 0 || dropIndex < 0 || dropIndex > visibleFields.length) return fields

  const insertionIndex = Math.min(
    Math.max(dropIndex > sourceIndex ? dropIndex - 1 : dropIndex, 0),
    visibleFields.length - 1,
  )
  if (insertionIndex === sourceIndex) return fields

  const reorderedVisibleFields = [...visibleFields]
  const [movedField] = reorderedVisibleFields.splice(sourceIndex, 1)
  if (!movedField) return fields
  reorderedVisibleFields.splice(insertionIndex, 0, movedField)

  const visibleFieldIds = new Set(visibleFields.map((field) => field.id))
  let visibleIndex = 0
  const reorderedFields = fields.map((field) => (
    visibleFieldIds.has(field.id)
      ? reorderedVisibleFields[visibleIndex++]
      : field
  ))

  return reorderedFields.map((field, index) => ({
    ...field,
    order: fields[index]?.order ?? index,
  }))
}
