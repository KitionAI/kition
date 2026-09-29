import { describe, expect, it } from 'vitest'
import { designShortcutLabel, designTooltip } from './designShortcuts'

describe('design shortcut labels', () => {
  it('uses symbols on macOS and words elsewhere', () => {
    expect(designShortcutLabel('Mod+Z', 'MacIntel')).toBe('⌘Z')
    expect(designShortcutLabel('Mod+Shift+Z', 'MacIntel')).toBe('⌘⇧Z')
    expect(designShortcutLabel('Alt+A', 'MacIntel')).toBe('⌥A')
    expect(designShortcutLabel('Mod+Z', 'Win32')).toBe('Ctrl+Z')
    expect(designShortcutLabel('Alt+H', 'Linux x86_64')).toBe('Alt+H')
    expect(designShortcutLabel('Shift+ArrowRight', 'Win32')).toBe('Shift+ArrowRight')
  })

  it('formats tooltips with the shortcut in parentheses', () => {
    expect(designTooltip('Undo', 'Mod+Z', 'Win32')).toBe('Undo (Ctrl+Z)')
  })
})
