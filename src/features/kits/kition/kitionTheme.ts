import type { KitTheme } from '../host/mountKit'

/**
 * The theme tokens of the Kit UI protocol (section 4). src/app/styles.css gives each of them on the
 * root from Kition's own variables, which `.dark` swaps (docs/product-ui-style.md, CSS Variable
 * Mapping); Tessera's stylesheet gives any it leaves out.
 */
const TOKENS = [
  '--kit-font-sans',
  '--kit-font-mono',
  '--kit-surface',
  '--kit-surface-muted',
  '--kit-canvas',
  '--kit-text',
  '--kit-text-muted',
  '--kit-border',
  '--kit-primary',
  '--kit-primary-text',
  '--kit-primary-soft',
  '--kit-danger',
  '--kit-radius-control',
  '--kit-radius-card',
  '--kit-shadow-card',
] as const

/** Kition's theme as the Kit UI protocol's theme: the scheme Kition shows, with the tokens its stylesheet gives that scheme (docs/design.md). */
export function kitionTheme(): KitTheme {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const tokens: Record<string, string> = {}
  for (const name of TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value) tokens[name] = value
  }
  return { colorScheme: root.classList.contains('dark') ? 'dark' : 'light', tokens }
}

/**
 * Calls `changed` with Kition's theme each time it differs from the last one a kit has (UI-H6:
 * the host sends `ui/theme` whenever the person changes it), starting with `sent`, the theme the
 * kit opened with: a change between the open and this call is sent at once. Answers the function
 * that stops watching.
 */
export function watchKitionTheme(sent: KitTheme, changed: (theme: KitTheme) => void): () => void {
  let last = JSON.stringify(sent)
  const check = () => {
    const theme = kitionTheme()
    const key = JSON.stringify(theme)
    if (key === last) return
    last = key
    changed(theme)
  }
  // Display settings switch the scheme on the root (its class and data-desktop-theme).
  const observer = new MutationObserver(check)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-desktop-theme'] })
  check()
  return () => observer.disconnect()
}
