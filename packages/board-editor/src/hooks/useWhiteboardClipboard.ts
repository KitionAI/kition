import { useCallback, useEffect, useRef } from 'react'

import type { BoardCommandRegistry } from '../lib/boardCommands'
import {
  BOARD_CLIPBOARD_MIME,
  createBoardClipboardText,
  instantiateBoardClipboardRecords,
  parseBoardClipboardText,
} from '../lib/boardClipboard'
import type { BoardRecord } from '../lib/boardRecords'
import type { WhiteboardElement } from '../lib/whiteboardTypes'

let fallbackClipboardText = ''

export function useWhiteboardClipboard(input: {
  clearSelection: () => void
  commands: BoardCommandRegistry
  records: readonly BoardRecord[]
  replaceSelection: (ids: readonly string[]) => void
  selectedElements: readonly WhiteboardElement[]
}) {
  const lastPasteRef = useRef({ count: 0, text: '' })

  const copySelection = useCallback((clipboardData?: DataTransfer | null) => {
    const text = createBoardClipboardText(
      input.records,
      input.selectedElements.map((element) => element.id),
    )
    if (!text) return false
    fallbackClipboardText = text
    lastPasteRef.current = { count: 0, text: '' }
    if (clipboardData) {
      clipboardData.setData(BOARD_CLIPBOARD_MIME, text)
      clipboardData.setData('text/plain', text)
    } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => undefined)
    }
    return true
  }, [input.records, input.selectedElements])

  const cutSelection = useCallback((clipboardData?: DataTransfer | null) => {
    if (!copySelection(clipboardData)) return false
    const copiedRecords = parseBoardClipboardText(fallbackClipboardText)
    const copiedElements = copiedRecords?.filter((record) => record.record_type === 'element') || []
    if (copiedElements.length === 0 || copiedElements.some((element) => element.locked)) {
      return false
    }
    input.commands.execute({
      type: 'element.delete',
      elementIds: copiedElements.map((element) => element.id),
    })
    input.clearSelection()
    return true
  }, [copySelection, input.clearSelection, input.commands])

  const pasteClipboardText = useCallback((text: string) => {
    const records = parseBoardClipboardText(text)
    if (!records) return false
    const count = lastPasteRef.current.text === text
      ? lastPasteRef.current.count + 1
      : 1
    lastPasteRef.current = { count, text }
    const pasted = instantiateBoardClipboardRecords(records, {
      x: count * 24,
      y: count * 24,
    })
    if (pasted.elements.length === 0) return false
    input.commands.execute({
      type: 'element.paste',
      bindings: pasted.bindings,
      elements: pasted.elements,
    })
    input.replaceSelection(pasted.elements.map((element) => element.id))
    return true
  }, [input.commands, input.replaceSelection])

  const pasteFromClipboard = useCallback(async () => {
    let text = fallbackClipboardText
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        text = await navigator.clipboard.readText() || text
      } catch {
        // Keep the in-app fallback when system clipboard access is unavailable.
      }
    }
    return pasteClipboardText(text)
  }, [pasteClipboardText])

  useEffect(() => {
    function handleCopy(event: ClipboardEvent) {
      if (isTextInput(event.target)) return
      if (copySelection(event.clipboardData)) event.preventDefault()
    }

    function handleCut(event: ClipboardEvent) {
      if (isTextInput(event.target)) return
      if (cutSelection(event.clipboardData)) event.preventDefault()
    }

    function handlePaste(event: ClipboardEvent) {
      if (isTextInput(event.target)) return
      const text = event.clipboardData?.getData(BOARD_CLIPBOARD_MIME)
        || event.clipboardData?.getData('text/plain')
        || ''
      if (pasteClipboardText(text)) event.preventDefault()
    }

    window.addEventListener('copy', handleCopy)
    window.addEventListener('cut', handleCut)
    window.addEventListener('paste', handlePaste)
    return () => {
      window.removeEventListener('copy', handleCopy)
      window.removeEventListener('cut', handleCut)
      window.removeEventListener('paste', handlePaste)
    }
  }, [copySelection, cutSelection, pasteClipboardText])

  return {
    copySelection,
    cutSelection,
    pasteClipboardText,
    pasteFromClipboard,
  }
}

function isTextInput(target: EventTarget | null) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable)
}
