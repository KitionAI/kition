import { describe, expect, it } from 'vitest'
import type { KitsCommandView } from '@/api/kits'
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
    expect(bindableShortcut('X')).toBe(false)
    expect(bindableShortcut('[')).toBe(false)
    expect(bindableShortcut('Cmd+W')).toBe(false)
    expect(bindableShortcut(null)).toBe(false)
  })

  it('finds only enabled commands', () => {
    const commands = [
      { id: 'select.all', shortcut: 'Cmd+A', enabled: false },
      { id: 'select.deselect', shortcut: 'Cmd+D', enabled: true },
    ] as KitsCommandView[]
    expect(commandForShortcut(commands, key('KeyA', { metaKey: true }), true)).toBeUndefined()
    expect(commandForShortcut(commands, key('KeyD', { metaKey: true }), true)?.id).toBe('select.deselect')
  })
})
