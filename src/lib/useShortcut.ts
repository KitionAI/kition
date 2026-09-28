import { useEffect, useMemo, useRef } from 'react'

import { matchesShortcut, parseShortcut } from '@/lib/shortcuts'

type UseShortcutOptions = {
  /** Skip matching while false; the listener stays cheap. */
  enabled?: boolean
}

/**
 * Runs `handler` on a window keydown that matches `combo` (see
 * `parseShortcut`) and prevents the default so Electron and the browser
 * never see the key. The latest handler is always used.
 */
export function useShortcut(combo: string, handler: () => void, { enabled = true }: UseShortcutOptions = {}) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const parsed = useMemo(() => parseShortcut(combo), [combo])

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (!matchesShortcut(event, parsed)) return
      event.preventDefault()
      handlerRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, parsed])
}
