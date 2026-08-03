import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from './request'
import {
  cancelDataImportJob,
  executeDataImport,
  getDataImportJob,
  previewDataImportFile,
  previewWorkspaceDataImport,
  runtimeSupportsTableFileImport,
  runtimeSupportsXlsxImport,
} from './dataImports'

vi.mock('./request', () => ({
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  },
}))

describe('data import API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('previews an uploaded file as multipart data', async () => {
    vi.mocked(request.post).mockResolvedValue({ import_token: 'token' } as never)
    const file = new File(['Owner,Hours\nalice,2.5\n'], 'issues.csv', { type: 'text/csv' })

    await previewDataImportFile(file)

    const [path, formData, config] = vi.mocked(request.post).mock.calls[0]
    expect(path).toBe('/v1/data-imports/preview')
    expect(formData).toBeInstanceOf(FormData)
    expect((formData as FormData).get('file')).toBe(file)
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } })
  })

  it('previews a workspace-relative source path', async () => {
    vi.mocked(request.post).mockResolvedValue({ import_token: 'token' } as never)

    await previewWorkspaceDataImport({ workspace_path: 'Imports/issues.xlsx', sheet: 'Issues' })

    expect(request.post).toHaveBeenCalledWith('/v1/data-imports/preview', {
      source: { kind: 'workspace', workspace_path: 'Imports/issues.xlsx' },
      sheet: 'Issues',
    })
  })

  it('executes, polls, and cancels import jobs', async () => {
    vi.mocked(request.post).mockResolvedValue({ id: 'job-1' } as never)
    vi.mocked(request.get).mockResolvedValue({ id: 'job-1' } as never)
    vi.mocked(request.delete).mockResolvedValue({ id: 'job-1' } as never)

    await executeDataImport({
      import_token: 'token',
      target: { kind: 'existing_table', document_id: 1, table_id: 2 },
      write_mode: 'append',
      schema_mode: 'auto',
    })
    await getDataImportJob('job/1')
    await cancelDataImportJob('job/1')

    expect(request.post).toHaveBeenCalledWith('/v1/data-imports', expect.any(Object))
    expect(request.get).toHaveBeenCalledWith('/v1/data-imports/job%2F1')
    expect(request.delete).toHaveBeenCalledWith('/v1/data-imports/job%2F1')
  })

  it('gates base and XLSX capabilities independently', () => {
    expect(runtimeSupportsTableFileImport(['table_file_import_v1'])).toBe(true)
    expect(runtimeSupportsXlsxImport(['table_file_import_v1'])).toBe(false)
    expect(runtimeSupportsXlsxImport(['table_file_import_v1', 'table_file_import_xlsx_v1'])).toBe(true)
  })
})
