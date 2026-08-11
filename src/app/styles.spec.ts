import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/app/styles.css'), 'utf8')

function themeBlock(selector: ':root' | '.dark') {
  const block = styles.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n  \\}`))?.[1]
  expect(block, `${selector} theme block`).toBeTruthy()
  return block || ''
}

describe('brand theme tokens', () => {
  it.each([':root', '.dark'] as const)(
    'keeps Kition purple and white foreground in %s',
    (selector) => {
      const block = themeBlock(selector)

      expect(block).toContain('--primary: 247.133 62.445% 55.098%;')
      expect(block).toContain('--primary-foreground: 0 0% 100%;')
      expect(block).toContain('--brand: 247.133 62.445% 55.098%;')
      expect(block).toContain('--brand-foreground: 0 0% 100%;')
      expect(block).toContain('--brand-active: 248.031 54.978% 45.294%;')
    },
  )
})

describe('workspace scroll containment', () => {
  it('locks the document workspace to the desktop viewport', () => {
    expect(styles).toMatch(
      /html:has\(\.app-shell\.is-document-route\),[\s\S]*?#app:has\(\.app-shell\.is-document-route\)\s*\{[\s\S]*?overflow: hidden;[\s\S]*?overscroll-behavior: none;[\s\S]*?\}/,
    )
    expect(styles).toMatch(
      /\.app-shell\.is-document-route\s*\{[\s\S]*?height: 100vh;[\s\S]*?overflow: hidden;[\s\S]*?overscroll-behavior: none;[\s\S]*?\}/,
    )
  })

  it('keeps document momentum inside the active document scroller', () => {
    expect(styles).toMatch(
      /\.document-editor \.cm-scroller,[\s\S]*?\.document-editor-reading\s*\{[\s\S]*?scrollbar-gutter: stable;[\s\S]*?overscroll-behavior: none;[\s\S]*?\}/,
    )
  })

  it('keeps Agent scrolling isolated without changing the message width', () => {
    expect(styles).toMatch(
      /\.agent-chat-messages\s*\{[\s\S]*?scrollbar-gutter: stable;[\s\S]*?overscroll-behavior: contain;[\s\S]*?\}/,
    )
  })
})

describe('workspace tab contrast', () => {
  it('keeps the active browser tab title readable on the themed topbar', () => {
    expect(styles).toMatch(
      /\.document-topbar-tabs \.document-tab\.is-browser\.is-active\s*\{[\s\S]*?@apply text-foreground;/,
    )
  })
})

describe('document completion contrast', () => {
  it('uses themed surfaces and brand selection colors for autocomplete results', () => {
    expect(styles).toMatch(
      /\.document-editor \.cm-editor \.cm-tooltip\.cm-tooltip-autocomplete\s*\{[\s\S]*?bg-popover text-popover-foreground;/,
    )
    expect(styles).toMatch(
      /\.document-editor \.cm-tooltip-autocomplete > ul > li\[aria-selected\]\s*\{[\s\S]*?background: hsl\(var\(--primary\)\) !important;[\s\S]*?color: hsl\(var\(--primary-foreground\)\) !important;/,
    )
    expect(styles).toMatch(
      /\.document-editor \.cm-tooltip-autocomplete \.cm-completionDetail,[\s\S]*?color: hsl\(var\(--muted-foreground\)\);/,
    )
  })
})
