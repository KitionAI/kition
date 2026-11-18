import type { MarkedExtension } from 'marked'
import { matchPaddedStrong } from './paddedStrong'

export const copiedStrongLabels: MarkedExtension = {
  extensions: [{
    name: 'copiedStrongLabel',
    level: 'inline',
    start(source) { return source.indexOf('**') },
    tokenizer(source) {
      const match = matchPaddedStrong(source)
      if (!match) return undefined
      return { type: 'copiedStrongLabel', raw: source.slice(0, match.length), tokens: this.lexer.inlineTokens(match.text) }
    },
    renderer(token) { return `<strong>${this.parser.parseInline(token.tokens || [])}</strong>` },
  }],
}
