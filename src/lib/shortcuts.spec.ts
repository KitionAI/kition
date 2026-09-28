import { describe, expect, it } from 'vitest'

import { matchesShortcut, parseShortcut } from './shortcuts'

const press = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('parseShortcut', () => {
  it('reads modifiers case-insensitively and keeps the key lower-case', () => {
    expect(parseShortcut('mod+SHIFT+F')).toEqual({ mod: true, shift: true, alt: false, key: 'f' })
    expect(parseShortcut('Escape')).toEqual({ mod: false, shift: false, alt: false, key: 'escape' })
    expect(() => parseShortcut('Mod+Shift')).toThrow()
  })
})

describe('matchesShortcut', () => {
  it('accepts either Command or Control for Mod', () => {
    expect(matchesShortcut(press('k', { metaKey: true }), 'Mod+K')).toBe(true)
    expect(matchesShortcut(press('K', { ctrlKey: true }), 'Mod+K')).toBe(true)
    expect(matchesShortcut(press('k'), 'Mod+K')).toBe(false)
  })

  it('rejects extra or missing modifiers', () => {
    expect(matchesShortcut(press('w', { metaKey: true, shiftKey: true }), 'Mod+W')).toBe(false)
    expect(matchesShortcut(press('f', { metaKey: true }), 'Mod+Shift+F')).toBe(false)
    expect(matchesShortcut(press('F', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+F')).toBe(true)
    expect(matchesShortcut(press('o', { metaKey: true, shiftKey: true, altKey: true }), 'Mod+Shift+O')).toBe(false)
  })
})
