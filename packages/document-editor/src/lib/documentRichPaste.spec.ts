import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setDocumentHost } from '../host'

const imageImport = vi.hoisted(() => ({
  fromURL: vi.fn(), fromFile: vi.fn(),
  fromClipboard: vi.fn(), canReadClipboard: vi.fn(),
}))
// The app's image import, as the editor's host offers it.
setDocumentHost({ images: imageImport })
import { prepareDocumentRichPaste } from './documentRichPaste'

const source = 'https://example.com/protected.png'
function data(html: string, files: File[] = []) {
  return { getData: (type: string) => type === 'text/html' ? html : '', files, items: [] } as unknown as DataTransfer
}

beforeEach(() => {
  vi.resetAllMocks()
  imageImport.fromURL.mockResolvedValue({ importedPath: 'attachments/copied.png', relativePath: 'copied.png' })
})

describe('mixed HTML image import', () => {
  it('keeps headings and lists and replaces remote images with document-relative attachments', async () => {
    const finish = prepareDocumentRichPaste(data(`<h2>Header</h2><ol start="12"><li>u16</li><li>i16</li></ol><img src="${source}" alt="Diagram">`), 'Notes/spec.md')!
    const result = await finish()
    expect(result).toContain('## Header')
    expect(result).toMatch(/12\.\s+u16/)
    expect(result).toMatch(/13\.\s+i16/)
    expect(result).toContain('![Diagram](../attachments/copied.png)')
    expect(result).not.toContain(source)
    expect(imageImport.fromClipboard).not.toHaveBeenCalled()
  })

  it('does not use a whole-selection bitmap as an embedded image', async () => {
    const bitmap = new File(['bitmap'], 'image.png', { type: 'image/png' })
    await prepareDocumentRichPaste(data(`<p>Caption</p><img src="${source}">`, [bitmap]), '')!()
    expect(imageImport.fromFile).not.toHaveBeenCalled()
    expect(imageImport.fromURL).toHaveBeenCalled()
  })

  it('uses explicitly matching CID files before inaccessible remote sources', async () => {
    const file = new File(['bitmap'], 'diagram.png', { type: 'image/png' })
    imageImport.fromFile.mockResolvedValue({ importedPath: 'attachments/diagram.png', relativePath: 'diagram.png' })
    const result = await prepareDocumentRichPaste(data('<p>Caption</p><img src="cid:diagram.png">', [file]), '')!()
    expect(result).toContain('attachments/diagram.png')
    expect(imageImport.fromURL).not.toHaveBeenCalled()
  })

  it('keeps surrounding text with a local retry placeholder when an image cannot be saved', async () => {
    imageImport.fromURL.mockRejectedValue(new Error('403'))
    const result = await prepareDocumentRichPaste(data(`<p>Before</p><img src="${source}"><p>After</p>`), '')!()
    expect(result).toContain('Before')
    expect(result).toContain('After')
    expect(result).toContain('attachments/.pending-image-')
    expect(result).not.toContain(source)
  })

  it('deduplicates repeated images and snapshots the payload before the event expires', async () => {
    const clipboard = data(`<p>Text</p><img src="${source}"><img src="${source}">`)
    const finish = prepareDocumentRichPaste(clipboard, '')!
    clipboard.getData = () => ''
    const result = await finish()
    expect(imageImport.fromURL).toHaveBeenCalledTimes(1)
    expect(result.match(/attachments\/copied.png/g)).toHaveLength(2)
  })
})
