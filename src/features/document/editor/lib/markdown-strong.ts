import type { MarkdownConfig } from '@lezer/markdown'
import { matchPaddedStrong } from '@/lib/markdownStrong'

export const copiedStrongLabels: MarkdownConfig = {
  parseInline: [{
    name: 'CopiedStrongLabel',
    before: 'Emphasis',
    parse(context, next, position) {
      if (next !== 42 || context.char(position - 1) === 42) return -1
      const match = matchPaddedStrong(context.slice(position, context.end))
      if (!match) return -1
      const end = position + match.length
      return context.addElement(context.elt('StrongEmphasis', position, end, [
        context.elt('EmphasisMark', position, position + 2),
        ...context.parser.parseInline(match.text, position + 2),
        context.elt('EmphasisMark', end - 2, end),
      ]))
    },
  }],
}
