import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { BoardCommandRegistry } from '../lib/boardCommands'
import { createWhiteboardElementId } from '../lib/whiteboardElementId'
import type {
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
  WhiteboardTextEditingState,
  WhiteboardTool,
} from '../lib/whiteboardTypes'

export function useWhiteboardTextEditing(input: {
  cancelInteraction: () => void
  commands: BoardCommandRegistry
  defaultStyle: WhiteboardElementStyle
  elements: readonly WhiteboardElement[]
  onEditingTextFinished?: (result: {
    committed: boolean
    elementId: string
    value: string
  }) => void
  replaceSelection: (ids: string[]) => void
  setTool: Dispatch<SetStateAction<WhiteboardTool>>
}) {
  const [editingText, setEditingText] = useState<WhiteboardTextEditingState | null>(null)
  const editingTextRef = useRef<WhiteboardTextEditingState | null>(null)

  const dismissEditingText = useCallback(() => {
    const current = editingTextRef.current
    if (current) {
      input.onEditingTextFinished?.({
        committed: false,
        elementId: current.elementId,
        value: current.value,
      })
    }
    editingTextRef.current = null
    setEditingText(null)
  }, [input.onEditingTextFinished])

  const beginNewTextEdit = useCallback((point: WhiteboardPoint, parentId?: string) => {
    const next: WhiteboardTextEditingState = {
      elementId: createWhiteboardElementId('text'),
      elementKind: 'text',
      parentId,
      x: point.x,
      y: point.y,
      value: '',
      isNew: true,
    }
    editingTextRef.current = next
    setEditingText(next)
  }, [])

  const beginTextEdit = useCallback((element: WhiteboardElement) => {
    if ((element.kind !== 'text' && element.kind !== 'rectangle') || element.locked) return
    input.cancelInteraction()
    input.replaceSelection([element.id])
    const next: WhiteboardTextEditingState = {
      elementId: element.id,
      elementKind: element.kind,
      x: element.kind === 'rectangle' ? element.x + element.width / 2 : element.x,
      y: element.kind === 'rectangle' ? element.y + element.height / 2 : element.y,
      value: element.text || '',
      isNew: false,
    }
    editingTextRef.current = next
    setEditingText(next)
  }, [input.cancelInteraction, input.replaceSelection])

  const updateEditingText = useCallback((value: string) => {
    const current = editingTextRef.current
    const next = current ? { ...current, value } : current
    editingTextRef.current = next
    setEditingText(next)
  }, [])

  const commitEditingText = useCallback(() => {
    if (!editingText) return
    const value = editingText.value.trim()
    if (value) {
      const current = input.elements.find((element) => element.id === editingText.elementId)
      const element: WhiteboardElement = current?.kind === 'rectangle'
        ? { ...current, text: value }
        : {
            ...(current?.kind === 'text' ? current : {}),
            id: editingText.elementId,
            kind: 'text',
            x: editingText.x,
            y: editingText.y,
            text: value,
            fontSize: current?.kind === 'text' ? current.fontSize ?? 22 : 22,
            locked: current?.locked ?? false,
            parentId: current?.parentId ?? editingText.parentId,
            rotation: current?.rotation ?? 0,
            style: current?.kind === 'text' && current.style
              ? { ...current.style }
              : { ...input.defaultStyle },
          }
      input.commands.execute({
        type: editingText.isNew ? 'element.create' : 'element.update',
        elements: [element],
      })
      input.replaceSelection([element.id])
    }
    input.onEditingTextFinished?.({
      committed: Boolean(value),
      elementId: editingText.elementId,
      value,
    })
    editingTextRef.current = null
    setEditingText(null)
    input.setTool('select')
  }, [
    editingText,
    input.commands,
    input.defaultStyle,
    input.elements,
    input.onEditingTextFinished,
    input.replaceSelection,
    input.setTool,
  ])

  const cancelEditingText = useCallback(() => {
    const current = editingTextRef.current
    if (current) {
      input.onEditingTextFinished?.({
        committed: false,
        elementId: current.elementId,
        value: current.value,
      })
    }
    editingTextRef.current = null
    setEditingText(null)
    input.setTool('select')
  }, [input.onEditingTextFinished, input.setTool])

  return {
    beginNewTextEdit,
    beginTextEdit,
    cancelEditingText,
    commitEditingText,
    dismissEditingText,
    editingText,
    updateEditingText,
  }
}
