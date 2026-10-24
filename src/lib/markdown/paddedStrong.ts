/** Compatibility for copied labels with padding or punctuation before a closing **. */
export function matchPaddedStrong(source: string) {
  if (!source.startsWith('**') || source[2] === '*' || /\s/.test(source[2] || ' ')) return null
  for (let index = 2; index < source.length - 1; index++) {
    if (source[index] === '\n' || source[index] === '\r') return null
    if (source[index] === '\\') { index++; continue }
    // Leave inline code and nested delimiter runs to the standard parser.
    if (source[index] === '`') return null
    if (source.slice(index, index + 2) !== '**') continue
    if (source[index - 1] === '*' || source[index + 2] === '*') return null
    const text = source.slice(2, index)
    if (!text.trim()) return null
    const padded = /[\t \u00a0]$/.test(text)
    const punctuationLabel = /\p{P}$/u.test(text) && /[\p{L}\p{N}]/u.test(source[index + 2] || '')
    return padded || punctuationLabel ? { text, length: index + 2 } : null
  }
  return null
}
