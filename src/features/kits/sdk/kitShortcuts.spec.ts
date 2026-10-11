import { describe, expect, it } from 'vitest'
import type { KitCommand } from './kitSdk'
import { bindableShortcut, commandForShortcut, shortcutMatches } from './kitShortcuts'

const key = (code: string, extra: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: extra.key ?? code.replace(/^Key|^Digit/, '').toLowerCase(),
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
})

describe('kit shortcuts', () => {
  it('maps Cmd to Command on macOS and Control elsewhere', () => {
    expect(shortcutMatches('Cmd+Shift+Z', key('KeyZ', { metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(shortcutMatches('Cmd+Shift+Z', key('KeyZ', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(shortcutMatches('Cmd+Z', key('KeyZ', { metaKey: true, shiftKey: true }), true)).toBe(false)
  })

  it('matches punctuation by key position and Delete by either delete key', () => {
    expect(shortcutMatches('Cmd+]', key('BracketRight', { key: '}', metaKey: true }), true)).toBe(true)
    expect(shortcutMatches('Delete', key('Backspace', { key: 'Backspace' }), true)).toBe(true)
    expect(shortcutMatches('F12', key('F12', { key: 'F12' }), true)).toBe(true)
  })

  it('binds modified and special keys but leaves bare letters and Kition shortcuts alone', () => {
    expect(bindableShortcut('Cmd+A')).toBe(true)
    expect(bindableShortcut('Delete')).toBe(true)
    expect(bindableShortcut('PageDown')).toBe(true)
    expect(bindableShortcut('Home')).toBe(false)
    expect(bindableShortcut('X')).toBe(false)
    expect(bindableShortcut('[')).toBe(false)
    expect(bindableShortcut('Cmd+W')).toBe(false)
    expect(bindableShortcut(null)).toBe(false)
  })

  it('finds the command by shortcut; whether it can run is asked when the key is pressed', () => {
    const commands = [
      { id: 'select.all', shortcut: 'Cmd+A', enabled: false },
      { id: 'select.deselect', shortcut: 'Cmd+D', enabled: true },
    ] as KitCommand[]
    expect(commandForShortcut(commands, key('KeyA', { metaKey: true }), true)?.id).toBe('select.all')
    expect(commandForShortcut(commands, key('KeyD', { metaKey: true }), true)?.id).toBe('select.deselect')
    expect(commandForShortcut(commands, key('KeyQ', { metaKey: true }), true)).toBeUndefined()
  })

  it('prefers the exact key over the Delete and Backspace alias', () => {
    const commands = [
      { id: 'markers.clear', shortcut: 'Delete', enabled: true },
      { id: 'edit.clear', shortcut: 'Backspace', enabled: true },
    ] as KitCommand[]
    expect(commandForShortcut(commands, key('Backspace', { key: 'Backspace' }), true)?.id).toBe('edit.clear')
    expect(commandForShortcut(commands, key('Delete', { key: 'Delete' }), true)?.id).toBe('markers.clear')
    expect(commandForShortcut([commands[0]], key('Backspace', { key: 'Backspace' }), true)?.id).toBe('markers.clear')
  })
})
