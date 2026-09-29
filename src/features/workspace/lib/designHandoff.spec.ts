import { describe, expect, it, vi } from 'vitest'
import type { DataAttachment } from '@/types/dataDocument'
import { designMarkdownLink, sendDesignToTable, type DesignHandoffApi } from './designHandoff'

const ref = { documentId: 3, tableId: 9, recordId: 41, field: 'Designs' }
const uploaded: DataAttachment = { name: 'Poster.png', url: 'attachments/poster.png', mimeType: 'image/png' }

function api(current: unknown): DesignHandoffApi & { updateRecord: ReturnType<typeof vi.fn> } {
  return {
    uploadAttachment: vi.fn(async () => uploaded),
    readRecordValue: vi.fn(async () => current as never),
    updateRecord: vi.fn(async () => ({})),
  }
}

describe('design hand-off', () => {
  it('builds a Markdown image link that survives brackets in the title', () => {
    expect(designMarkdownLink('Launch [v2]', '../attachments/design/a.png')).toBe('![Launch \\[v2\\]](<../attachments/design/a.png>)')
  })

  it('uploads the image and appends it to the existing attachments', async () => {
    const existing: DataAttachment = { name: 'old.png', url: 'attachments/old.png' }
    const client = api([existing, 'stray'])
    const file = new File([new Uint8Array([1])], 'Poster.png', { type: 'image/png' })
    await expect(sendDesignToTable(client, ref, file)).resolves.toEqual(uploaded)
    expect(client.uploadAttachment).toHaveBeenCalledWith(3, 9, file)
    expect(client.updateRecord).toHaveBeenCalledWith(ref, { Designs: [existing, uploaded] })
  })

  it('starts a fresh attachment list when the field is empty or holds one attachment', async () => {
    const file = new File([new Uint8Array([1])], 'Poster.png', { type: 'image/png' })
    const empty = api(undefined)
    await sendDesignToTable(empty, ref, file)
    expect(empty.updateRecord).toHaveBeenCalledWith(ref, { Designs: [uploaded] })
    const single = api({ name: 'one.png', url: 'attachments/one.png' })
    await sendDesignToTable(single, ref, file)
    expect(single.updateRecord).toHaveBeenCalledWith(ref, { Designs: [{ name: 'one.png', url: 'attachments/one.png' }, uploaded] })
  })
})
