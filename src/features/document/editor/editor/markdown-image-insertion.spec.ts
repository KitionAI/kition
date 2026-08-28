import { describe, expect, it } from 'vitest'

import { resolveMarkdownImageInsertionContext } from './markdown-image-insertion'

describe('resolveMarkdownImageInsertionContext', () => {
  it('uses the cursor when it is on a top-level blank line', () => {
    expect(resolveMarkdownImageInsertionContext({
      documentPath: 'Docs/Pendant.md',
      markdown: '# Title\n\nBody',
      cursorOffset: 8,
    })).toMatchObject({
      documentPath: 'Docs/Pendant.md',
      cursorOffset: 8,
      preferredOffset: 8,
      preferredLine: 2,
      strategy: 'cursor-blank-line',
    })
  })

  it.each([
    {
      name: 'fenced code',
      markdown: 'Before\n\n```ts\nconst x = 1\n```\n\nAfter',
      cursorOffset: 20,
      preferredOffset: 30,
      preferredLine: 6,
    },
    {
      name: 'inline code',
      markdown: 'Paragraph with ``inline code`` here.\n\nAfter',
      cursorOffset: 24,
      preferredOffset: 37,
      preferredLine: 2,
    },
    {
      name: 'blockquote',
      markdown: 'Intro\n\n> quoted\n> content\n\nAfter',
      cursorOffset: 20,
      preferredOffset: 26,
      preferredLine: 5,
    },
    {
      name: 'loose list',
      markdown: 'Before\n\n- item\n\n  continuation\n\nAfter',
      cursorOffset: 13,
      preferredOffset: 7,
      preferredLine: 2,
    },
    {
      name: 'GFM table',
      markdown: 'Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter',
      cursorOffset: 30,
      preferredOffset: 37,
      preferredLine: 6,
    },
    {
      name: 'frontmatter',
      markdown: '---\ntitle: Example\n---\n\nBody',
      cursorOffset: 10,
      preferredOffset: 23,
      preferredLine: 4,
    },
  ])('selects the nearest top-level blank line outside $name', ({
    markdown,
    cursorOffset,
    preferredOffset,
    preferredLine,
  }) => {
    expect(resolveMarkdownImageInsertionContext({
      documentPath: 'Docs/Pendant.md',
      markdown,
      cursorOffset,
    })).toMatchObject({
      cursorOffset,
      preferredOffset,
      preferredLine,
      strategy: 'nearest-blank-line',
    })
  })

  it('falls back to the boundary after the containing top-level block', () => {
    expect(resolveMarkdownImageInsertionContext({
      documentPath: 'Docs/Pendant.md',
      markdown: '# Title\nBody',
      cursorOffset: 3,
    })).toMatchObject({
      cursorOffset: 3,
      preferredOffset: 7,
      preferredLine: 1,
      strategy: 'after-block',
    })
  })

  it('keeps CRLF frontmatter blank lines inside the frontmatter range', () => {
    const markdown = [
      '---',
      'title: Example',
      'owner: Team',
      'status: Draft',
      'category: Product',
      'audience: General',
      'region: Global',
      'reviewed: false',
      '',
      '---',
      'Body',
    ].join('\r\n')
    const cursorOffset = markdown.indexOf('\r\n\r\n') + 2

    expect(resolveMarkdownImageInsertionContext({
      documentPath: 'Docs/Pendant.md',
      markdown,
      cursorOffset,
    })).toMatchObject({
      cursorOffset,
      preferredOffset: markdown.lastIndexOf('---') + 3,
      preferredLine: 10,
      strategy: 'after-block',
    })
  })

  it('falls back to the document end when cursor context is unavailable', () => {
    expect(resolveMarkdownImageInsertionContext({
      documentPath: 'Docs/Pendant.md',
      markdown: 'Body',
    })).toEqual({
      documentPath: 'Docs/Pendant.md',
      cursorOffset: null,
      preferredOffset: 4,
      preferredLine: 1,
      strategy: 'document-end',
      anchorBefore: 'Body',
      anchorAfter: '',
    })
  })
})
