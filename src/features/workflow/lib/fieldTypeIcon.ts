export type FieldType =
  | 'text' | 'longtext' | 'number' | 'date'
  | 'single_select' | 'attachment' | 'email' | 'phone'

const ICONS: Record<FieldType, string> = {
  text: 'T', longtext: '¶', number: '#', date: '📅',
  single_select: '◯', attachment: '📎', email: '@', phone: '☏',
}

const LABELS: Record<FieldType, string> = {
  text: 'Text', longtext: 'Long Text', number: 'Number', date: 'Date',
  single_select: 'Single Select', attachment: 'Attachment', email: 'Email', phone: 'Phone',
}

export function fieldTypeIcon(type: string): string {
  return ICONS[type as FieldType] ?? '?'
}

export function fieldTypeLabel(type: string): string {
  return LABELS[type as FieldType] ?? type
}
