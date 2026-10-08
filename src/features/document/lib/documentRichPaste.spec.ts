import { beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({
  importWorkspaceImageFromBlobURL: vi.fn(), importWorkspaceImageFromFile: vi.fn(),
  importWorkspaceImageFromClipboard: vi.fn(), canImportWorkspaceImageFromClipboard: vi.fn(),
}))
vi.mock('@/services/desktop', () => desktop)
import { prepareDocumentRichPaste } from './documentRichPaste'

const source = 'https://example.com/protected.png'
function data(html: string, files: File[] = []) {
  return { getData: (type: string) => type === 'text/html' ? html : '', files, items: [] } as unknown as DataTransfer
}

beforeEach(() => {
  vi.resetAllMocks()
  desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({ importedPath: 'attachments/copied.png', relativePath: 'copied.png' })
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
    expect(desktop.importWorkspaceImageFromClipboard).not.toHaveBeenCalled()
  })

  it('does not use a whole-selection bitmap as an embedded image', async () => {
    const bitmap = new File(['bitmap'], 'image.png', { type: 'image/png' })
    await prepareDocumentRichPaste(data(`<p>Caption</p><img src="${source}">`, [bitmap]), '')!()
    expect(desktop.importWorkspaceImageFromFile).not.toHaveBeenCalled()
    expect(desktop.importWorkspaceImageFromBlobURL).toHaveBeenCalled()
  })

  it('uses explicitly matching CID files before inaccessible remote sources', async () => {
    const file = new File(['bitmap'], 'diagram.png', { type: 'image/png' })
    desktop.importWorkspaceImageFromFile.mockResolvedValue({ importedPath: 'attachments/diagram.png', relativePath: 'diagram.png' })
    const result = await prepareDocumentRichPaste(data('<p>Caption</p><img src="cid:diagram.png">', [file]), '')!()
    expect(result).toContain('attachments/diagram.png')
    expect(desktop.importWorkspaceImageFromBlobURL).not.toHaveBeenCalled()
  })

  it('keeps surrounding text with a local retry placeholder when an image cannot be saved', async () => {
    desktop.importWorkspaceImageFromBlobURL.mockRejectedValue(new Error('403'))
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
    expect(desktop.importWorkspaceImageFromBlobURL).toHaveBeenCalledTimes(1)
    expect(result.match(/attachments\/copied.png/g)).toHaveLength(2)
  })
})
