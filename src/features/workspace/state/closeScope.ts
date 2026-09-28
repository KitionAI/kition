/**
 * Which items a tab-bar close command affects. Shared by the workspace tab
 * strip and the Agent chat tab bar so "close others / left / right / all"
 * behave the same everywhere.
 */
export type CloseScope = 'others' | 'left' | 'right' | 'all'

/**
 * Items to close for `scope` relative to the item with `targetId`, in list
 * order. An unknown target closes nothing, except for `all`.
 */
export function selectItemsToClose<T extends { id: string | number }>(
  items: readonly T[],
  targetId: T['id'] | null,
  scope: CloseScope,
): T[] {
  if (scope === 'all') return [...items]
  const index = items.findIndex((item) => item.id === targetId)
  if (index < 0) return []
  if (scope === 'others') return items.filter((_, position) => position !== index)
  if (scope === 'left') return items.slice(0, index)
  return items.slice(index + 1)
}
