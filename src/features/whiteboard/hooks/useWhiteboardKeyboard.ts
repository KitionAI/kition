import { useEffect, useRef } from 'react'

import type { BoardElementReorderPlacement } from '../lib/boardCommands'
import type { WhiteboardTool } from '../lib/whiteboardTypes'

export function useWhiteboardKeyboard(options: {
  addMindMapChild: () => boolean
  addMindMapSibling: () => boolean
  deleteSelection: () => void
  duplicateSelection: () => boolean
  editSelection: () => boolean
  escape: () => void
  nudgeSelection: (delta: { x: number; y: number }) => boolean
  redo: () => void
  reorderSelection: (placement: BoardElementReorderPlacement) => boolean
  selectAll: () => void
  setTool: (tool: WhiteboardTool) => void
  tool: WhiteboardTool
  undo: () => void
}) {
  const {
    addMindMapChild,
    addMindMapSibling,
    deleteSelection,
    duplicateSelection,
    editSelection,
    escape,
    nudgeSelection,
    redo,
    reorderSelection,
    selectAll,
    setTool,
    tool,
    undo,
  } = options
  const toolRef = useRef(tool)
  const temporaryHandPreviousToolRef = useRef<WhiteboardTool | null>(null)

  useEffect(() => {
    toolRef.current = tool
  }, [tool])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      const key = event.key.toLowerCase()
      if (
        event.code === 'Space'
        && !event.repeat
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        event.preventDefault()
        if (!temporaryHandPreviousToolRef.current) {
          temporaryHandPreviousToolRef.current = toolRef.current
          setTool('hand')
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if ((event.metaKey || event.ctrlKey) && key === 'a') {
        event.preventDefault()
        selectAll()
        return
      }
      if ((event.metaKey || event.ctrlKey) && key === 'd') {
        if (duplicateSelection()) event.preventDefault()
        return
      }
      if (key === '[' || key === ']') {
        const placement = key === ']'
          ? event.metaKey || event.ctrlKey ? 'front' : 'forward'
          : event.metaKey || event.ctrlKey ? 'back' : 'backward'
        if (reorderSelection(placement)) event.preventDefault()
        return
      }
      if (key === 'backspace' || key === 'delete') {
        event.preventDefault()
        deleteSelection()
        return
      }
      if (
        key === 'tab'
        && !event.repeat
        && !event.shiftKey
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        if (addMindMapChild()) event.preventDefault()
        return
      }
      if (key === 'enter') {
        if (
          !event.repeat
          && !event.shiftKey
          && !event.metaKey
          && !event.ctrlKey
          && !event.altKey
          && addMindMapSibling()
        ) {
          event.preventDefault()
          return
        }
        if (editSelection()) event.preventDefault()
        return
      }
      if (key.startsWith('arrow')) {
        const distance = event.shiftKey ? 10 : 1
        const delta = {
          x: key === 'arrowleft' ? -distance : key === 'arrowright' ? distance : 0,
          y: key === 'arrowup' ? -distance : key === 'arrowdown' ? distance : 0,
        }
        if (nudgeSelection(delta)) event.preventDefault()
        return
      }
      if (key === 'escape') {
        event.preventDefault()
        escape()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const shortcut: Partial<Record<string, WhiteboardTool>> = {
        v: 'select',
        h: 'hand',
        e: 'eraser',
        n: 'note',
        r: 'rectangle',
        t: 'text',
        p: 'pen',
        l: 'highlight',
        c: 'connector',
      }
      const nextTool = shortcut[key]
      if (nextTool) setTool(nextTool)
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code !== 'Space') return
      const previousTool = temporaryHandPreviousToolRef.current
      if (!previousTool) return
      event.preventDefault()
      temporaryHandPreviousToolRef.current = null
      setTool(previousTool)
    }

    function handleBlur() {
      const previousTool = temporaryHandPreviousToolRef.current
      if (!previousTool) return
      temporaryHandPreviousToolRef.current = null
      setTool(previousTool)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [
    addMindMapChild,
    addMindMapSibling,
    deleteSelection,
    duplicateSelection,
    editSelection,
    escape,
    nudgeSelection,
    redo,
    reorderSelection,
    selectAll,
    setTool,
    undo,
  ])
}
