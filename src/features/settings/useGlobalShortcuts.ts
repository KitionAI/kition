import { useEffect, useRef, useState } from 'react'
import {
  formatShortcutFromEvent,
  loadDesktopSettings,
  subscribeDesktopSettingsUpdated,
} from '@/services/desktopSettings'
import type { DesktopShortcut } from '@/types/desktopSettings'

/**
 * Wires `defaultShortcuts` declared in services/desktopSettings to actual
 * renderer-side actions. Without this hook the combos are configurable in
 * the Settings UI but never fire — Cmd+, etc. were dead.
 *
 * Pass `{ [shortcut.id]: () => void }`. Combos come from the user's saved
 * settings, so renaming Cmd+, in the UI takes effect without code edits.
 * Disabled shortcuts are skipped.
 */
export function useGlobalShortcuts(handlers: Record<string, () => void>) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const [shortcuts, setShortcuts] = useState<DesktopShortcut[]>([])

  useEffect(() => {
    let cancelled = false
    loadDesktopSettings()
      .then((settings) => {
        if (!cancelled) setShortcuts(settings.shortcuts)
      })
      .catch(() => undefined)
    const unsubscribe = subscribeDesktopSettingsUpdated((settings) => {
      setShortcuts(settings.shortcuts)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (shortcuts.length === 0) return
    const enabled = shortcuts.filter((s) => s.enabled && s.combo)
    function onKeyDown(event: KeyboardEvent) {
      const combo = formatShortcutFromEvent(event)
      if (!combo) return
      const match = enabled.find((s) => s.combo === combo)
      if (!match) return
      const handler = handlersRef.current[match.id]
      if (!handler) return
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcuts])
}
