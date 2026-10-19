import { describe, expect, it, vi } from 'vitest'
import { newDocId, person, Replica, Rng, Tx } from '@kition/kdm'
import { DOCUMENT_BODY, DOCUMENT_KIT, documentSchema } from './documentSchema'
import { analyzeText, createDocumentReplica, documentBody, documentRootId, renderText, type LineStyle } from './documentText'

/** CJK text (U+5B63 U+5EA6), as a named constant: the repository keeps non-English text out of source files. */
const QUARTER = String.fromCodePoint(0x5b63, 0x5ea6)

const BOM = String.fromCodePoint(0xfeff)
const me = person('user:test')

describe('documentSchema', () => {
  it('is the kit.document schema with one text field', () => {
    expect(documentSchema.kit).toBe(DOCUMENT_KIT)
    expect(DOCUMENT_KIT).toBe('kit.document')
    expect(documentSchema.root).toBe('Document')
    expect(documentSchema.types.Document.fields[DOCUMENT_BODY].kind).toBe('text')
  })
})

describe('analyzeText', () => {
  it('keeps LF text as it is', () => {
    expect(analyzeText('# Plan\n\nBody\n')).toEqual({ text: '# Plan\n\nBody\n', style: { eol: '\n', bom: false, finalNewline: true } })
  })

  it('normalises CRLF and records it', () => {
    expect(analyzeText('a\r\nb\r\n')).toEqual({ text: 'a\nb\n', style: { eol: '\r\n', bom: false, finalNewline: true } })
  })

  it('strips one byte order mark and records it', () => {
    expect(analyzeText(`${BOM}a`)).toEqual({ text: 'a', style: { eol: '\n', bom: true, finalNewline: false } })
    expect(analyzeText(`${BOM}${BOM}a`).text).toBe(`${BOM}a`)
  })

  it('treats an empty file and a file without line endings as LF', () => {
    expect(analyzeText('')).toEqual({ text: '', style: { eol: '\n', bom: false, finalNewline: false } })
    expect(analyzeText(BOM)).toEqual({ text: '', style: { eol: '\n', bom: true, finalNewline: false } })
    expect(analyzeText(`${QUARTER}😀`)).toEqual({ text: `${QUARTER}😀`, style: { eol: '\n', bom: false, finalNewline: false } })
  })

  it('records mixed endings with the majority ending', () => {
    expect(analyzeText('a\r\nb\r\nc\nd')).toEqual({ text: 'a\nb\nc\nd', style: { eol: 'mixed', bom: false, finalNewline: false, mixedEol: '\r\n' } })
    expect(analyzeText('a\nb\nc\r\n')).toEqual({ text: 'a\nb\nc\n', style: { eol: 'mixed', bom: false, finalNewline: true, mixedEol: '\n' } })
  })

  it('normalises lone CR as a line ending of its own (mixed)', () => {
    expect(analyzeText('a\rb\r')).toEqual({ text: 'a\nb\n', style: { eol: 'mixed', bom: false, finalNewline: true, mixedEol: '\n' } })
    expect(analyzeText('a\r\n\rb').text).toBe('a\n\nb')
  })

  it('breaks a tie between LF and CRLF towards LF', () => {
    expect(analyzeText('a\nb\r\n').style.mixedEol).toBe('\n')
  })
})

describe('renderText', () => {
  it('restores CRLF and the byte order mark', () => {
    expect(renderText('a\nb\n', { eol: '\r\n', bom: true, finalNewline: true })).toBe(`${BOM}a\r\nb\r\n`)
  })

  it('exports a mixed document with its majority ending', () => {
    const { text, style } = analyzeText('a\r\nb\r\nc\nd')
    expect(renderText(text, style)).toBe('a\r\nb\r\nc\r\nd')
    expect(renderText('x\ny', { eol: 'mixed', bom: false, finalNewline: false })).toBe('x\ny')
  })

  it('normalises stray CR in the text before applying the style', () => {
    expect(renderText('a\r\nb\rc\n', { eol: '\r\n', bom: false, finalNewline: true })).toBe('a\r\nb\r\nc\r\n')
    expect(renderText('a\r\nb', { eol: '\n', bom: false, finalNewline: false })).toBe('a\nb')
  })

  it('leaves the final newline to the text', () => {
    const style: LineStyle = { eol: '\n', bom: false, finalNewline: true }
    expect(renderText('a', style)).toBe('a')
    expect(renderText('a\n', { ...style, finalNewline: false })).toBe('a\n')
  })
})

/** A random file of lines in one ending style, with CJK, emoji, empty lines, and an optional BOM. */
function randomFile(rng: Rng, eol: '\n' | '\r\n'): string {
  const pieces = ['a', 'Plan', ' ', '#', '|', QUARTER, '😀', '👩‍💻', '\t', BOM, 'é', '']
  const lines: string[] = []
  const count = rng.below(8)
  for (let line = 0; line < count; line += 1) {
    let text = ''
    for (let piece = rng.below(5); piece > 0; piece -= 1) text += pieces[rng.below(pieces.length)]
    lines.push(text)
  }
  const body = lines.join(eol) + (rng.below(2) === 0 ? eol : '')
  return (rng.below(3) === 0 ? BOM : '') + body
}

describe('analyzeText and renderText round trip', () => {
  it('returns every non-mixed input exactly (property)', () => {
    const rng = new Rng(7)
    for (let run = 0; run < 2000; run += 1) {
      const raw = randomFile(rng, rng.below(2) === 0 ? '\n' : '\r\n')
      const { text, style } = analyzeText(raw)
      expect(style.eol).not.toBe('mixed')
      expect(text.includes('\r')).toBe(false)
      expect(renderText(text, style)).toBe(raw)
    }
  })

  it('keeps the content of mixed inputs, line for line', () => {
    const rng = new Rng(8)
    for (let run = 0; run < 500; run += 1) {
      const raw = randomFile(rng, '\n') + '\r\n' + randomFile(rng, '\r\n')
      const { text, style } = analyzeText(raw)
      const out = renderText(text, style)
      expect(analyzeText(out).text).toBe(text)
      expect(analyzeText(out).style.eol).not.toBe('mixed')
    }
  })
})

describe('createDocumentReplica', () => {
  it('writes the normalised body at creation, with nothing to undo', () => {
    const { replica, rootId, style } = createDocumentReplica(`${BOM}# ${QUARTER} 😀\r\nBody\r\n`, 3n)
    expect(style).toEqual({ eol: '\r\n', bom: true, finalNewline: true })
    expect(documentBody(replica)).toBe(`# ${QUARTER} 😀\nBody\n`)
    expect(documentRootId(replica)).toBe(rootId)
    expect(replica.objectType(rootId)).toBe('Document')
    expect(replica.canUndo()).toBe(false)
    expect(replica.actor).toBe(3n)
  })

  it('takes a chosen document id and survives a snapshot round trip', () => {
    const docId = newDocId()
    const { replica } = createDocumentReplica('hello\n', 1n, docId)
    expect(replica.docId).toBe(docId)
    const loaded = Replica.load(documentSchema, replica.snapshot(), 2n)
    expect(documentBody(loaded)).toBe('hello\n')
  })

  it('creates an empty document from an empty file', () => {
    const { replica } = createDocumentReplica('', 1n)
    expect(documentBody(replica)).toBe('')
    expect(replica.canUndo()).toBe(false)
  })

  it('undoes later edits but never the imported body', () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    replica.transact(me, (tx) => tx.textInsert(rootId, DOCUMENT_BODY, 3, 'd'))
    expect(replica.undo()).toBe(true)
    expect(documentBody(replica)).toBe('abc')
    expect(replica.canUndo()).toBe(false)
  })

  it('writes a large body in pieces of whole lines, never splitting a surrogate pair', () => {
    const lines = Array.from({ length: 3_000 }, (_, index) => `Line ${index}: ${QUARTER} 😀 words`).join('\r\n')
    // A long run without line breaks, of emoji only, so that some pieces must end inside it.
    const raw = `${lines}\r\n${'😀👍'.repeat(6_000)}\r\n${lines}\r\n`
    const body = raw.replace(/\r\n/g, '\n')
    const spy = vi.spyOn(Tx.prototype, 'textInsert')
    const { replica } = createDocumentReplica(raw, 1n)
    const pieces = spy.mock.calls.map((call) => call[3])
    spy.mockRestore()
    expect(documentBody(replica) === body).toBe(true)
    expect(pieces.length).toBeGreaterThan(5)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(32 * 1024)
      expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(piece)).toBe(false)
    }
    // Only the pieces cut inside the long run end elsewhere than after a line break.
    expect(pieces.filter((piece) => !piece.endsWith('\n')).length).toBeLessThanOrEqual(6)
    expect(documentBody(Replica.load(documentSchema, replica.snapshot(), 2n)) === body).toBe(true)
    expect(replica.canUndo()).toBe(false)
  })

  it('reports a replica without a Document object', () => {
    const other = Replica.create(documentSchema, newDocId(), 1n)
    expect(() => documentRootId(other)).toThrow(/no Document/)
  })
})
