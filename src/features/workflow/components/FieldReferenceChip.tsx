import { fieldTypeIcon, fieldTypeLabel } from '../lib/fieldTypeIcon'

export interface FieldReferenceChipProps {
  nodeTitle: string
  fieldName: string
  fieldType: string
}

export function FieldReferenceChip({ nodeTitle, fieldName, fieldType }: FieldReferenceChipProps) {
  return (
    <span
      data-testid="field-ref-chip"
      title={`${fieldTypeLabel(fieldType)} field "${fieldName}"`}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 align-middle text-xs text-foreground"
    >
      <span className="text-muted-foreground">{nodeTitle}</span>
      <span aria-hidden className="text-muted-foreground/60">|</span>
      <span aria-hidden className="font-semibold text-primary">{fieldTypeIcon(fieldType)}</span>
      <span>{fieldName}</span>
    </span>
  )
}
