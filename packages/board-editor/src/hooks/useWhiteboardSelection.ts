import { useCallback, useEffect, useMemo, useState } from 'react'

import type { WhiteboardElement } from '../lib/whiteboardTypes'

export function useWhiteboardSelection(
  elements: readonly WhiteboardElement[],
) {
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([])
  const elementIds = useMemo(
    () => new Set(elements.map((element) => element.id)),
    [elements],
  )

  useEffect(() => {
    setSelectedElementIds((current) => {
      const next = current.filter((id) => elementIds.has(id))
      return next.length === current.length ? current : next
    })
  }, [elementIds])

  const clearSelection = useCallback(() => setSelectedElementIds([]), [])
  const replaceSelection = useCallback((ids: readonly string[]) => {
    setSelectedElementIds([...new Set(ids)])
  }, [])
  const toggleSelection = useCallback((id: string) => {
    setSelectedElementIds((current) => (
      current.includes(id)
        ? current.filter((currentId) => currentId !== id)
        : [...current, id]
    ))
  }, [])

  const selectedElements = useMemo(() => {
    const selected = new Set(selectedElementIds)
    return elements.filter((element) => selected.has(element.id))
  }, [elements, selectedElementIds])

  return {
    clearSelection,
    replaceSelection,
    selectedElementId: selectedElementIds[0] ?? null,
    selectedElementIds,
    selectedElements,
    setSelectedElementIds,
    toggleSelection,
  }
}
