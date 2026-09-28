/**
 * Keyboard shortcut matching for app-level bindings. Combos are written
 * as `Mod+Shift+F`: `Mod` is Command on macOS and Control elsewhere, and
 * either is accepted so one binding serves both platforms. Modifiers not
 * named in the combo must not be held, so `Mod+W` never fires on
 * `Mod+Shift+W`.
 */
export type ParsedShortcut = {
  mod: boolean
  shift: boolean
  alt: boolean
  /** Lower-case `KeyboardEvent.key`. */
  key: string
}

const MODIFIER_TOKENS = new Set(['mod', 'shift', 'alt'])

export function parseShortcut(combo: string): ParsedShortcut {
  const parsed: ParsedShortcut = { mod: false, shift: false, alt: false, key: '' }
  for (const token of combo.split('+')) {
    const lower = token.trim().toLowerCase()
    if (!lower) continue
    if (MODIFIER_TOKENS.has(lower)) {
      parsed[lower as 'mod' | 'shift' | 'alt'] = true
    } else {
      parsed.key = lower
    }
  }
  if (!parsed.key) throw new Error(`Shortcut "${combo}" names no key`)
  return parsed
}

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

export function matchesShortcut(event: ShortcutEvent, combo: string | ParsedShortcut): boolean {
  const parsed = typeof combo === 'string' ? parseShortcut(combo) : combo
  const mod = event.metaKey || event.ctrlKey
  if (mod !== parsed.mod) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.altKey !== parsed.alt) return false
  return event.key.toLowerCase() === parsed.key
}
