import type { KitTheme } from '../host/mountKit'

/** Kition's design tokens as the Kit UI protocol's theme (docs/design.md). */
export function kitionTheme(): KitTheme {
  const sans = getComputedStyle(document.body).fontFamily
  return {
    colorScheme: 'light',
    tokens: {
      '--kit-font-sans': sans,
      '--kit-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      '--kit-surface': '#ffffff',
      '--kit-surface-muted': '#fafaf9',
      '--kit-canvas': '#f6f5f4',
      '--kit-text': '#1a1a1a',
      '--kit-text-muted': '#5d5b54',
      '--kit-border': '#e5e3df',
      '--kit-primary': '#5645d4',
      '--kit-primary-text': '#ffffff',
      '--kit-primary-soft': 'rgba(86, 69, 212, 0.1)',
      '--kit-danger': '#e03131',
      '--kit-radius-control': '8px',
      '--kit-radius-card': '12px',
      '--kit-shadow-card': '0 1px 2px rgba(15, 15, 15, 0.06), 0 4px 16px rgba(15, 15, 15, 0.06)',
    },
  }
}
