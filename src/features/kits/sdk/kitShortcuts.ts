import type { KitsCommandView } from '@/api/kits'

/** Shortcuts Kition itself owns; a kit command never takes them. */
const HOST_SHORTCUTS = new Set(['Cmd+N', 'Cmd+W', 'Cmd+O', 'Cmd+P', 'Cmd+Q', 'Cmd+,', 'Cmd+S', 'Cmd+Shift+S', 'Cmd+T'])

const CODES: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
}

type KeyLike = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)
}

/** Whether `event` is `shortcut`, written as kits write it: `Cmd+Shift+Z`, `Alt+Backspace`, `F12`. */
export function shortcutMatches(shortcut: string, event: KeyLike, mac = isMac()) {
  const parts = shortcut.split('+')
  const key = parts.length > 1 && parts[parts.length - 1] === '' ? '+' : parts.pop() ?? ''
  const mods = new Set(parts.filter(Boolean))
  const wantCommand = mods.has('Cmd')
  const command = mac ? event.metaKey : event.ctrlKey
  const control = mac ? event.ctrlKey : false
  if (wantCommand !== command || mods.has('Ctrl') !== control) return false
  if (mods.has('Shift') !== event.shiftKey || mods.has('Alt') !== event.altKey) return false
  if (/^[A-Za-z]$/.test(key)) return event.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}`
  if (CODES[key]) return event.code === CODES[key]
  if (key === 'Delete') return event.key === 'Delete' || event.key === 'Backspace'
  return event.key === key
}

/** Whether the frame binds `shortcut`: with a modifier, or Delete, Backspace, Enter, or a function key; never Kition's own. */
export function bindableShortcut(shortcut: string | null): shortcut is string {
  if (!shortcut || HOST_SHORTCUTS.has(shortcut)) return false
  return shortcut.includes('+') || /^(Delete|Backspace|F[0-9]{1,2})$/.test(shortcut)
}

/** The enabled command whose shortcut is `event`, if any. */
export function commandForShortcut(commands: readonly KitsCommandView[], event: KeyLike, mac = isMac()) {
  return commands.find((command) => command.enabled && bindableShortcut(command.shortcut) && shortcutMatches(command.shortcut, event, mac))
}
