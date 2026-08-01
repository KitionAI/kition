import { describe, expect, it, vi } from 'vitest'

import type { AnyAIConfig } from '@/types/aiConfig'
import type { DataField, DataRecord } from '@/types/dataDocument'

import { hydrateBundledAIFieldAttachments } from './aiAttachmentHydration'

const sourceField = {
  id: 11,
  name: 'receipt_image',
  title: 'Receipt Image',
  type: 'attachment',
} as DataField

const config = {
  type: 'extract',
  source_field_id: sourceField.id,
  schema: '{"merchant_name":"string"}',
  enabled: true,
  auto_update: true,
} as AnyAIConfig

describe('hydrateBundledAIFieldAttachments', () => {
  it('uploads bundled assets and persists runtime-accessible attachment URLs', async () => {
    const record = {
      id: 31,
      values: {
        receipt_image: [{
          name: 'receipt.png',
          mimeType: 'image/png',
          sizeBytes: 3,
          url: 'kition-bundled:/templates/receipt-ocr-database/records/record-03/receipt.png',
        }],
      },
    } as unknown as DataRecord
    const uploaded = {
      name: 'receipt.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      url: '/uploads/receipts/receipt.png',
    }
    const fetchAsset = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
      headers: new Headers({ 'content-type': 'image/png' }),
    })
    const uploadAttachment = vi.fn().mockResolvedValue(uploaded)
    const updatedRecord = {
      ...record,
      values: { receipt_image: [uploaded] },
    } as DataRecord
    const updateRecord = vi.fn().mockResolvedValue(updatedRecord)

    await expect(hydrateBundledAIFieldAttachments({
      documentId: 7,
      tableId: 9,
      record,
      config,
      fields: [sourceField],
      dependencies: { fetchAsset, uploadAttachment, updateRecord },
    })).resolves.toBe(updatedRecord)

    expect(fetchAsset).toHaveBeenCalledWith(
      '/templates/receipt-ocr-database/records/record-03/receipt.png',
      { signal: undefined },
    )
    expect(uploadAttachment).toHaveBeenCalledWith(7, 9, expect.any(File))
    expect(updateRecord).toHaveBeenCalledWith(7, 9, 31, {
      receipt_image: [uploaded],
    })
  })

  it('leaves existing runtime attachment URLs unchanged', async () => {
    const record = {
      id: 31,
      values: { receipt_image: [{ name: 'receipt.png', url: '/uploads/receipt.png' }] },
    } as unknown as DataRecord
    const dependencies = {
      fetchAsset: vi.fn(),
      uploadAttachment: vi.fn(),
      updateRecord: vi.fn(),
    }

    await expect(hydrateBundledAIFieldAttachments({
      documentId: 7,
      tableId: 9,
      record,
      config,
      fields: [sourceField],
      dependencies,
    })).resolves.toBe(record)

    expect(dependencies.fetchAsset).not.toHaveBeenCalled()
    expect(dependencies.uploadAttachment).not.toHaveBeenCalled()
    expect(dependencies.updateRecord).not.toHaveBeenCalled()
  })
})
