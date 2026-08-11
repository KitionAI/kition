import { describe, expect, it } from 'vitest'

import { matchWikilinkTarget } from '@/features/document/editor/hooks/useVaultWikilinkResolver'

import { resolveMarkdownLinkTarget } from './markdownLinkNavigation'

const files = [
  { path: 'README.md' },
  { path: 'campaigns/2026-08-x-open-source/README.md' },
  { path: 'guides/overview.md' },
]

const resolvePath = (target: string, sourcePath?: string) => (
  matchWikilinkTarget(files, target, sourcePath)
)

describe('resolveMarkdownLinkTarget', () => {
  it('resolves a workspace-root Markdown path from the root document', () => {
    expect(resolveMarkdownLinkTarget(
      'campaigns/2026-08-x-open-source/README.md',
      'README.md',
      resolvePath,
    )).toEqual({ path: 'campaigns/2026-08-x-open-source/README.md' })
  })

  it('keeps an explicit relative path clickable before the workspace index loads', () => {
    expect(resolveMarkdownLinkTarget(
      'campaigns/2026-08-x-open-source/README.md',
      'README.md',
      () => null,
    )).toEqual({ path: 'campaigns/2026-08-x-open-source/README.md' })
  })

  it('resolves relative paths and preserves heading fragments', () => {
    expect(resolveMarkdownLinkTarget(
      '../guides/overview.md#Getting%20started',
      'campaigns/README.md',
      resolvePath,
    )).toEqual({ path: 'guides/overview.md', section: '#Getting started' })
  })

  it('resolves same-document heading links without a vault lookup', () => {
    expect(resolveMarkdownLinkTarget('#Current-materials', 'README.md', resolvePath)).toEqual({
      path: 'README.md',
      section: '#Current-materials',
    })
  })

  it('leaves external links to the external URL handler', () => {
    expect(resolveMarkdownLinkTarget('https://kition.ai', 'README.md', resolvePath)).toBeNull()
    expect(resolveMarkdownLinkTarget('mailto:support@kition.ai', 'README.md', resolvePath)).toBeNull()
  })
})
