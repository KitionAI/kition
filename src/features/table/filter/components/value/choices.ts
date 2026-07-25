import type { DataField } from '@/types/dataDocument'

export type Choice = { id: string; name: string; color?: string }

export function readChoices(field: DataField): Choice[] {
  const opts = field.options as Record<string, unknown> | null | undefined
  const raw = opts?.choices
  if (!Array.isArray(raw)) return []
  return raw
    .map((c): Choice | null => {
      if (!c || typeof c !== 'object') return null
      const obj = c as Record<string, unknown>
      const name = typeof obj.name === 'string' ? obj.name : null
      if (!name) return null
      const id = typeof obj.id === 'string' ? obj.id : name
      const color = typeof obj.color === 'string' ? obj.color : undefined
      return { id, name, color }
    })
    .filter((x): x is Choice => x !== null)
}
