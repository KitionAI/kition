import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancelDataImportJob: vi.fn(),
  executeDataImport: vi.fn(),
  getDataImportJob: vi.fn(),
  getDesktopBackendStatus: vi.fn(),
  importCsvIntoDataTable: vi.fn(),
  previewDataImportFile: vi.fn(),
}))

vi.mock('@/api/dataImports', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/dataImports')>(),
  cancelDataImportJob: mocks.cancelDataImportJob,
  executeDataImport: mocks.executeDataImport,
  getDataImportJob: mocks.getDataImportJob,
  previewDataImportFile: mocks.previewDataImportFile,
}))

vi.mock('@/services/desktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/desktop')>(),
  getDesktopBackendStatus: mocks.getDesktopBackendStatus,
}))

vi.mock('@/features/table/lib/importCsvIntoDataTable', () => ({
  importCsvIntoDataTable: mocks.importCsvIntoDataTable,
}))

describe('table file import orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDesktopBackendStatus.mockResolvedValue({ capabilities: [] })
  })

  it('previews CSV locally when the runtime capability is unavailable', async () => {
    const { prepareTableFileImport } = await import('./tableFileImport')
    const prepared = await prepareTableFileImport(new File([
      'Owner,Hours\nalice,2.5\nbob,1\n',
    ], 'issues.csv', { type: 'text/csv' }))

    expect(prepared.backend).toBe('client')
    expect(prepared.preview).toMatchObject({ row_count: 2, field_count: 2 })
    expect(prepared.preview.fields.map((field) => field.type)).toEqual(['text', 'number'])
  })

  it('requires the XLSX runtime capability for workbook files', async () => {
    const { prepareTableFileImport } = await import('./tableFileImport')

    await expect(prepareTableFileImport(new File(['binary'], 'issues.xlsx')))
      .rejects.toThrow('does not support XLSX import')
  })

  it('rejects legacy XLS files with a conversion instruction', async () => {
    const { prepareTableFileImport } = await import('./tableFileImport')

    await expect(prepareTableFileImport(new File(['binary'], 'issues.xls')))
      .rejects.toThrow('Save the workbook as XLSX')
  })

  it('uses runtime preview and asynchronous execution when supported', async () => {
    const { executePreparedTableFileImport, prepareTableFileImport } = await import('./tableFileImport')
    mocks.getDesktopBackendStatus.mockResolvedValue({
      capabilities: ['table_file_import_v1', 'table_file_import_xlsx_v1'],
    })
    mocks.previewDataImportFile.mockResolvedValue({
      import_token: 'token',
      source: { kind: 'upload', upload_name: 'issues.xlsx' },
      format: 'xlsx',
      row_count: 2,
      field_count: 1,
      fields: [{ index: 0, title: 'Owner', type: 'text', nullable: false, sample_values: ['alice'] }],
      sample_rows: [['alice']],
      warnings: [],
      sheets: [{ name: 'Issues', index: 0, hidden: false, row_count: 2, field_count: 1 }],
    })
    mocks.executeDataImport.mockResolvedValue({
      id: 'job-1',
      status: 'completed',
      stage: 'completed',
      processed_rows: 2,
      total_rows: 2,
      result: {
        rows_total: 2,
        rows_created: 2,
        rows_updated: 0,
        rows_skipped: 0,
        fields_created: 1,
        fields_updated: 0,
        warnings: [],
      },
      created_at: '',
      updated_at: '',
    })

    const prepared = await prepareTableFileImport(new File(['binary'], 'issues.xlsx'))
    const completed = await executePreparedTableFileImport({
      fieldTypes: ['text'],
      prepared,
      target: { kind: 'existing_table', documentId: 10, table: { id: 20, fields: [] } as never },
      writeMode: 'append',
    })

    expect(mocks.previewDataImportFile).toHaveBeenCalled()
    expect(mocks.executeDataImport).toHaveBeenCalledWith(expect.objectContaining({
      import_token: 'token',
      target: { kind: 'existing_table', document_id: 10, table_id: 20 },
    }))
    expect(completed.result.rows_created).toBe(2)
  })

  it('executes a runtime import into a new Kitable document', async () => {
    const { executePreparedTableFileImport } = await import('./tableFileImport')
    mocks.executeDataImport.mockResolvedValue({
      id: 'job-new',
      status: 'completed',
      stage: 'completed',
      processed_rows: 2,
      total_rows: 2,
      result: {
        document_id: 30,
        table_id: 40,
        path: 'Imports/issues.kitable',
        rows_total: 2,
        rows_created: 2,
        rows_updated: 0,
        rows_skipped: 0,
        fields_created: 1,
        fields_updated: 0,
        warnings: [],
      },
      created_at: '',
      updated_at: '',
    })

    await executePreparedTableFileImport({
      fieldTypes: ['text'],
      prepared: {
        backend: 'runtime',
        file: new File(['Owner\nalice\n'], 'issues.csv'),
        preview: {
          import_token: 'token-new',
          source: { kind: 'upload', upload_name: 'issues.csv' },
          format: 'csv',
          row_count: 1,
          field_count: 1,
          fields: [{ index: 0, title: 'Owner', type: 'text', nullable: false, sample_values: ['alice'] }],
          sample_rows: [['alice']],
          warnings: [],
          sheets: [],
        },
      },
      target: { kind: 'new_document', path: 'Imports/issues.kitable', tableTitle: 'Issues' },
      writeMode: 'append',
    })

    expect(mocks.executeDataImport).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'new_document', path: 'Imports/issues.kitable', table_title: 'Issues' },
      write_mode: 'append',
    }))
  })
})
