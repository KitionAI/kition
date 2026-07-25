const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null

function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x3400 && code <= 0x9fff)   ||   // CJK Unified + Ext A
    (code >= 0xf900 && code <= 0xfaff)   ||   // CJK Compatibility Ideographs
    (code >= 0x20000 && code <= 0x2ffff) ||   // CJK Unified Ext B-F
    (code >= 0x3040 && code <= 0x30ff)   ||   // Hiragana / Katakana
    (code >= 0xac00 && code <= 0xd7af)        // Hangul
  )
}

function fallbackSegment(input: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (/[\w]/.test(ch) && !isCJK(ch)) {
      let j = i
      while (j < input.length && /[\w]/.test(input[j]) && !isCJK(input[j])) j++
      const tok = input.slice(i, j)
      if (tok.length > 1 || /\d/.test(tok)) out.push(tok)
      i = j
    } else if (isCJK(ch)) {
      let j = i
      while (j < input.length && isCJK(input[j])) j++
      const cjk = input.slice(i, j)
      if (cjk.length === 1) {
        out.push(cjk)
      } else {
        for (let k = 0; k + 1 < cjk.length; k++) out.push(cjk.slice(k, k + 2))
      }
      i = j
    } else {
      i++
    }
  }
  return out
}

export function segment(raw: string): string[] {
  const normalized = raw.normalize('NFKC').toLowerCase()
  if (!segmenter) return fallbackSegment(normalized)
  const out: string[] = []
  for (const { segment: seg, isWordLike } of segmenter.segment(normalized)) {
    if (!isWordLike) continue
    if (seg.length === 1 && /[a-z]/.test(seg)) continue
    out.push(seg)
  }
  return out
}

export { fallbackSegment as __fallbackSegmentForTests }
