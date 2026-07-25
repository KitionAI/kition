import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RecordActionPropertiesPanel } from './RecordActionPropertiesPanel'

let container: HTMLDivElement
let root: Root | null = null

const sourceSchema = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'fld_sku', name: 'SKU', type: 'text' },
    { id: 'fld_product', name: 'Product Name', type: 'text' },
  ],
}
const targetSchema = {
  id: 'catalog',
  name: 'Product Catalog',
  fields: [
    { id: 'cat_sku', name: 'SKU', type: 'text' },
    { id: 'cat_product', name: 'Product Name', type: 'text' },
  ],
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

async function mount(actionType: 'update_record' | 'lookup_record' | 'transform_record', overrides: Record<string, unknown> = {}) {
  const callbacks = {
    onUpdateRecordChange: vi.fn(),
    onLookupRecordChange: vi.fn(),
    onTransformRecordChange: vi.fn(),
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(RecordActionPropertiesPanel, {
      actionType,
      sourceSchema,
      sourceNodeId: 'trigger_1',
      tableOptions: [{ tableId: 'catalog', tableName: 'Product Catalog', documentTitle: 'Orders' }],
      schemaByTableId: { catalog: targetSchema },
      ...callbacks,
      ...overrides,
    }))
    await Promise.resolve()
  })
  return callbacks
}

describe('RecordActionPropertiesPanel', () => {
  it('lets an update action build a field assignment with the editable template control', async () => {
    const callbacks = await mount('update_record', { updateRecord: { target: 'trigger_record', fields: [] } })
    const addText = container.querySelector('[data-testid="body-add-text"]') as HTMLButtonElement
    expect(addText).toBeTruthy()
    await act(async () => {
      addText.click()
      await Promise.resolve()
    })
    expect(callbacks.onUpdateRecordChange).toHaveBeenCalledWith({
      target: 'trigger_record',
      fields: [{ fieldId: 'fld_sku', value: { parts: [{ kind: 'text', text: '' }] } }],
    })
  })

  it('adds a write-back mapping for a configured lookup table', async () => {
    const callbacks = await mount('lookup_record', {
      lookupRecord: { targetTableId: 'catalog', matchFieldId: 'cat_sku', matchValue: { parts: [] }, writeBack: [] },
    })
    const addMapping = container.querySelector('[data-testid="lookup-record-add-mapping"]') as HTMLButtonElement
    await act(async () => {
      addMapping.click()
      await Promise.resolve()
    })
    expect(callbacks.onLookupRecordChange).toHaveBeenCalledWith(expect.objectContaining({
      targetTableId: 'catalog',
      writeBack: [{ sourceFieldId: '', targetFieldId: '' }],
    }))
  })

  it('adds a deterministic transform operation with an editable source', async () => {
    const callbacks = await mount('transform_record', { transformRecord: { operations: [] } })
    const addOperation = container.querySelector('[data-testid="transform-record-add-operation"]') as HTMLButtonElement
    await act(async () => {
      addOperation.click()
      await Promise.resolve()
    })
    expect(callbacks.onTransformRecordChange).toHaveBeenCalledWith({
      operations: [{ source: { parts: [] }, operation: 'trim', targetFieldId: '' }],
    })
  })
})
