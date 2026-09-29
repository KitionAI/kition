import type { KeyboardEvent } from 'react'
import { translation } from '../lib/designGeometry'
import type { AlignEdge } from '../lib/designLayout'
import type { DesignSession } from '../lib/designSession'
import type { DesignStore } from '../lib/designStore'
import type { DesignDocument } from '../lib/designTypes'

/** Alt with a letter aligns the selection; adding Mod distributes instead. */
const ALIGN_KEYS: Record<string, AlignEdge> = {
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'top',
  KeyS: 'bottom',
  KeyH: 'centerX',
  KeyV: 'centerY',
}

function isTextTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('input,textarea,select,[contenteditable="true"]')
  )
}

/** The editor's keyboard commands: history, selection, grouping, alignment, nudging. */
export function useDesignKeyboard({
  store,
  session,
  active,
  doc,
  selection,
  onSaveError,
}: {
  store: DesignStore
  session: DesignSession
  active: boolean
  doc: DesignDocument
  selection: string[]
  onSaveError: () => void
}) {
  return function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (!active || isTextTarget(event.target) || event.nativeEvent.isComposing)
      return
    const mod = event.metaKey || event.ctrlKey,
      key = event.key.toLowerCase()
    if (mod && key === 'z') {
      event.preventDefault()
      event.shiftKey ? store.redo() : store.undo()
      return
    }
    if (mod && key === 'y') {
      event.preventDefault()
      store.redo()
      return
    }
    if (mod && key === 's') {
      event.preventDefault()
      void session.flush().catch(() => onSaveError())
      return
    }
    if (mod && key === 'a') {
      event.preventDefault()
      store.select(doc.pages[0].children)
      return
    }
    if (mod && key === 'g') {
      event.preventDefault()
      store.execute({
        type: event.shiftKey ? 'ungroup' : 'group',
        ids: selection,
      })
      return
    }
    if (mod && key === 'd') {
      event.preventDefault()
      store.execute({ type: 'duplicate', ids: selection })
      return
    }
    if (event.altKey && selection.length && event.code in ALIGN_KEYS) {
      // Alt with a letter changes `event.key` on macOS, so match the code.
      event.preventDefault()
      const edge = ALIGN_KEYS[event.code]
      if (mod && edge === 'centerX')
        store.execute({ type: 'distribute', ids: selection, axis: 'x' })
      else if (mod && edge === 'centerY')
        store.execute({ type: 'distribute', ids: selection, axis: 'y' })
      else store.execute({ type: 'align', ids: selection, edge })
      return
    }
    if (key === 'escape') {
      store.cancel()
      store.select([])
      return
    }
    if (key === 'delete' || key === 'backspace') {
      event.preventDefault()
      store.execute({ type: 'remove', ids: selection })
      return
    }
    if (key.startsWith('arrow') && selection.length) {
      event.preventDefault()
      const amount = event.shiftKey ? 10 : 1
      store.execute(
        {
          type: 'transform',
          ids: selection,
          matrix: translation(
            key === 'arrowleft' ? -amount : key === 'arrowright' ? amount : 0,
            key === 'arrowup' ? -amount : key === 'arrowdown' ? amount : 0,
          ),
        },
        'nudge',
      )
    }
  }
}
