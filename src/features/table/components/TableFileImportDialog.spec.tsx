import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  cancelPreparedTableFileImport: vi.fn(),
  executePreparedTableFileImport: vi.fn(),
  prepareTableFileImport: vi.fn(),
}))

vi.mock('@/features/table/lib/tableFileImport', () => ({
  cancelPreparedTableFileImport: mocks.cancelPreparedTableFileImport,
  executePreparedTableFileImport: mocks.executePreparedTableFileImport,
  prepareTableFileImport: mocks.prepareTableFileImport,
}))

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TableFileImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepareTableFileImport.mockResolvedValue({
      backend: 'client',
      file: new File(['Owner,Hours\nalice,2.5\n'], 'issues.csv'),
      preview: {
        import_token: '',
        source: { kind: 'upload', upload_name: 'issues.csv' },
        filename: 'issues.csv',
        format: 'csv',
        row_count: 1,
        field_count: 2,
        fields: [
          { index: 0, title: 'Owner', type: 'text', nullable: false, sample_values: ['alice'] },
          { index: 1, title: 'Hours', type: 'number', nullable: false, sample_values: [2.5] },
        ],
        sample_rows: [['alice', 2.5]],
        warnings: [],
        sheets: [],
      },
      csvContent: 'Owner,Hours\nalice,2.5\n',
      csvAnalysis: {},
    })
    mocks.executePreparedTableFileImport.mockResolvedValue({
      backend: 'client',
      result: {
        document_id: 10,
        table_id: 20,
        rows_total: 1,
        rows_created: 1,
        rows_updated: 0,
        rows_skipped: 0,
        fields_created: 2,
        fields_updated: 0,
        warnings: [],
      },
    })
  })

  it('previews fields, allows type changes, and executes the import', async () => {
    const { TableFileImportDialog } = await import('./TableFileImportDialog')
    const file = new File(['Owner,Hours\nalice,2.5\n'], 'issues.csv')
    const onCompleted = vi.fn()
    const onOpenChange = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(TableFileImportDialog, {
        file,
        onCompleted,
        onOpenChange,
        open: true,
        target: { kind: 'existing_table', documentId: 10, table: { id: 20, fields: [] } as never },
      }))
      await flushAsyncWork()
    })

    expect(document.body.textContent).toContain('issues.csv')
    expect(document.body.textContent).toContain('Owner')
    expect(document.body.textContent).toContain('Hours')
    expect(document.body.textContent).toContain('Compatibility import')

    const typeSelects = Array.from(document.body.querySelectorAll('select')) as HTMLSelectElement[]
    await act(async () => {
      typeSelects[0].value = 'long_text'
      typeSelects[0].dispatchEvent(new Event('change', { bubbles: true }))
    })
    const importButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Import') as HTMLButtonElement
    await act(async () => {
      importButton.click()
      await flushAsyncWork()
    })

    expect(mocks.executePreparedTableFileImport).toHaveBeenCalledWith(expect.objectContaining({
      fieldTypes: ['long_text', 'number'],
      target: expect.objectContaining({ kind: 'existing_table', documentId: 10 }),
      writeMode: 'append',
    }))
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ rows_created: 1 }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await act(async () => root?.unmount())
    container.remove()
  })

  it('creates a new Kitable with an editable destination path', async () => {
    mocks.prepareTableFileImport.mockResolvedValue({
      backend: 'runtime',
      file: new File(['Owner\nalice\n'], 'issues.csv'),
      preview: {
        import_token: 'token',
        source: { kind: 'upload', upload_name: 'issues.csv' },
        filename: 'issues.csv',
        format: 'csv',
        row_count: 1,
        field_count: 1,
        fields: [{ index: 0, title: 'Owner', type: 'text', nullable: false, sample_values: ['alice'] }],
        sample_rows: [['alice']],
        warnings: [],
        sheets: [],
      },
    })
    const { TableFileImportDialog } = await import('./TableFileImportDialog')
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(TableFileImportDialog, {
        file: new File(['Owner\nalice\n'], 'issues.csv'),
        onCompleted: vi.fn(),
        onOpenChange: vi.fn(),
        open: true,
        target: { kind: 'new_document', folder: 'Imports' },
      }))
      await flushAsyncWork()
    })

    const pathInput = Array.from(document.body.querySelectorAll('input'))
      .find((input) => input.value.endsWith('.kitable')) as HTMLInputElement
    expect(pathInput.value).toBe('Imports/issues.kitable')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(pathInput, 'Imported/Jira.kitable')
      pathInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const importButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Import') as HTMLButtonElement
    await act(async () => {
      importButton.click()
      await flushAsyncWork()
    })

    expect(mocks.executePreparedTableFileImport).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'new_document', path: 'Imported/Jira.kitable', tableTitle: 'Jira' },
    }))

    await act(async () => root?.unmount())
    container.remove()
  })
})
