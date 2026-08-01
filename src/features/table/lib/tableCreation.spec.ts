import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDataDocument,
  createDataRecord,
  listViewFields,
  patchViewField,
  updateDataView,
  uploadDataAttachment,
  updateDataDocument,
  updateDataField,
} from '@/api/dataDocuments'
import { instantiateTemplatePackage } from '@/api/templates'
import { createWorkspaceDocument, deleteWorkspaceDocument, getDesktopBackendStatus } from '@/services/desktop'
import type { KitableTemplateDefinition } from '@/features/table/templates/kitableTemplates'
import { createTableWorkspaceEntry } from './tableCreation'

vi.mock('@/api/dataDocuments', () => ({
  createDataDocument: vi.fn(),
  createDataRecord: vi.fn(),
  listViewFields: vi.fn(),
  patchViewField: vi.fn(),
  updateDataView: vi.fn(),
  uploadDataAttachment: vi.fn(),
  updateDataDocument: vi.fn(),
  updateDataField: vi.fn(),
}))

vi.mock('@/api/templates', () => ({
  instantiateTemplatePackage: vi.fn(),
}))

vi.mock('@/services/desktop', () => ({
  createWorkspaceDocument: vi.fn(),
  deleteWorkspaceDocument: vi.fn(),
  getDesktopBackendStatus: vi.fn(),
}))

const template: KitableTemplateDefinition = {
  id: 'test-template',
  title: 'Project tracker',
  description: 'Test template',
  documentDescription: 'Seeded project tracker',
  usageCount: 1,
  coverImage: '/templates/table-covers/test-template.webp',
  icon: 'check-square',
  color: 'violet',
  snapshot: {
    version: 1,
    includeData: true,
    defaultResourceId: 'projects',
    resources: [{ id: 'projects', kind: 'table', title: 'Projects', description: 'Project records', tableTitle: 'Projects' }],
  },
  tables: [{
    title: 'Projects',
    description: 'Projects and status',
    fields: [
      { title: 'Project', type: 'text', primary: true },
      { title: 'Status', type: 'single_select', options: { choices: ['Active', 'Done'] } },
    ],
    views: [{ title: 'Grid', type: 'grid' }],
    records: [
      { Project: 'Website refresh', Status: 'Active' },
      { Project: 'Mobile launch', Status: 'Done' },
    ],
  }],
}

describe('createTableWorkspaceEntry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.mocked(createWorkspaceDocument).mockReset()
    vi.mocked(createDataDocument).mockReset()
    vi.mocked(createDataRecord).mockReset()
    vi.mocked(listViewFields).mockReset()
    vi.mocked(patchViewField).mockReset()
    vi.mocked(updateDataView).mockReset()
    vi.mocked(uploadDataAttachment).mockReset()
    vi.mocked(updateDataDocument).mockReset()
    vi.mocked(updateDataField).mockReset()
    vi.mocked(deleteWorkspaceDocument).mockReset()
    vi.mocked(getDesktopBackendStatus).mockReset()
    vi.mocked(instantiateTemplatePackage).mockReset()
    vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: [] } as never)
    vi.mocked(createWorkspaceDocument).mockResolvedValue({
      path: 'Project tracker.kitable',
      name: 'Project tracker.kitable',
      content: '',
      format: 'data',
    })
    vi.mocked(createDataDocument).mockResolvedValue({
      id: 7,
      user_id: 1,
      workspace_root: '/workspace',
      path: 'Project tracker.kitable',
      title: 'Project tracker',
      description: 'Seeded project tracker',
      icon: 'check-square',
      color: 'violet',
      tables: [{
        id: 11,
        user_id: 1,
        document_id: 7,
        name: 'projects',
        title: 'Projects',
        description: 'Projects and status',
        order: 0,
        fields: [
          { id: 21, user_id: 1, document_id: 7, table_id: 11, name: 'project', title: 'Project', type: 'text', required: false, unique: false, readonly: false, is_primary: true, order: 0, created_at: '', updated_at: '' },
          { id: 22, user_id: 1, document_id: 7, table_id: 11, name: 'status', title: 'Status', type: 'single_select', required: false, unique: false, readonly: false, is_primary: false, order: 1, created_at: '', updated_at: '' },
        ],
        views: [],
        created_at: '',
        updated_at: '',
      }],
      created_at: '',
      updated_at: '',
    })
    vi.mocked(createDataRecord).mockResolvedValue({} as never)
    vi.mocked(listViewFields).mockResolvedValue({ items: [] })
    vi.mocked(patchViewField).mockResolvedValue({} as never)
    vi.mocked(updateDataView).mockResolvedValue({} as never)
    vi.mocked(uploadDataAttachment).mockResolvedValue({
      name: 'uploaded.png',
      url: '/uploads/uploaded.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    })
    vi.mocked(updateDataDocument).mockImplementation(async (_documentId, payload) => ({
      ...(await createDataDocument({} as never)),
      meta: payload.meta,
    }))
    vi.mocked(updateDataField).mockResolvedValue({} as never)
  })

  it('creates template tables and maps sample values to generated field names', async () => {
    const result = await createTableWorkspaceEntry({
      folderOverride: '',
      rootPath: '/workspace',
      template,
    })

    expect(createDataDocument).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Project tracker',
      description: 'Seeded project tracker',
      meta: { template_id: 'test-template', template_snapshot_version: 1 },
      tables: [expect.objectContaining({ title: 'Projects' })],
    }))
    expect(createDataRecord).toHaveBeenNthCalledWith(1, 7, 11, {
      project: 'Website refresh',
      status: 'Active',
    })
    expect(createDataRecord).toHaveBeenNthCalledWith(2, 7, 11, {
      project: 'Mobile launch',
      status: 'Done',
    })
    expect(result).toMatchObject({
      documentId: 7,
      tableId: 11,
      tableIdsByTitle: { Projects: 11 },
      tableTitle: 'Projects',
    })
    expect(result.document.path).toBe('Project tracker.kitable')
  })

  it('uses runtime package cloning when the capability is available', async () => {
    vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: ['template_packages'] } as never)
    vi.mocked(instantiateTemplatePackage).mockResolvedValue({
      template_id: 'test-template',
      snapshot_version: 1,
      document: await createDataDocument({} as never),
      default_resource: {
        source_id: 'projects',
        target_id: '11',
        kind: 'table',
        title: 'Projects',
        table_id: 11,
      },
      resources: [],
    })

    const result = await createTableWorkspaceEntry({
      rootPath: '/workspace',
      template,
    })

    expect(instantiateTemplatePackage).toHaveBeenCalledWith('test-template', {
      workspace_root: '/workspace',
      path: 'Project tracker.kitable',
      include_data: true,
    })
    expect(createDataDocument).toHaveBeenCalledTimes(1)
    expect(createDataRecord).not.toHaveBeenCalled()
    expect(result.tableId).toBe(11)
  })

  it('creates local-only templates in the client even when runtime packages are available', async () => {
    vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: ['template_packages'] } as never)

    await createTableWorkspaceEntry({
      rootPath: '/workspace',
      template: { ...template, localOnly: true },
    })

    expect(instantiateTemplatePackage).not.toHaveBeenCalled()
    expect(createDataDocument).toHaveBeenCalled()
    expect(createDataRecord).toHaveBeenCalledTimes(2)
  })

  it('resolves template AI source fields after runtime IDs are assigned', async () => {
    const aiTemplate: KitableTemplateDefinition = {
      ...template,
      id: 'thumbnail-generator',
      title: 'Thumbnail Generator',
      snapshot: {
        ...template.snapshot,
        defaultResourceId: 'thumbnails',
        resources: [{ id: 'thumbnails', kind: 'table', title: 'Thumbnails', description: 'Generated images', tableTitle: 'Thumbnails' }],
      },
      tables: [{
        title: 'Thumbnails',
        description: 'Generated thumbnails',
        views: [{ title: 'Grid', type: 'grid' }],
        fields: [
          { title: 'Key Message', type: 'text', primary: true },
          { title: 'Face Photo', type: 'attachment' },
          {
            title: 'Thumbnail (16:9)',
            type: 'attachment',
            aiConfig: {
              type: 'image_customization',
              sourceFieldTitle: 'Face Photo',
              prompt: 'Create a thumbnail for {{Key Message}}',
              enabled: true,
              auto_update: false,
              n: 1,
              quality: 'high',
              aspect_ratio: '16:9',
              resolution: '2K',
              image_use_case: 'cover_illustration',
            },
          },
        ],
        records: [{ 'Key Message': 'Build faster' }],
      }],
    }
    vi.mocked(createDataDocument).mockResolvedValueOnce({
      id: 8,
      user_id: 1,
      workspace_root: '/workspace',
      path: 'Thumbnail Generator.kitable',
      title: 'Thumbnail Generator',
      tables: [{
        id: 12,
        user_id: 1,
        document_id: 8,
        name: 'thumbnails',
        title: 'Thumbnails',
        description: '',
        order: 0,
        fields: [
          { id: 31, user_id: 1, document_id: 8, table_id: 12, name: 'key_message', title: 'Key Message', type: 'text', required: false, unique: false, readonly: false, is_primary: true, order: 0, created_at: '', updated_at: '' },
          { id: 32, user_id: 1, document_id: 8, table_id: 12, name: 'face_photo', title: 'Face Photo', type: 'attachment', required: false, unique: false, readonly: false, is_primary: false, order: 1, created_at: '', updated_at: '' },
          { id: 33, user_id: 1, document_id: 8, table_id: 12, name: 'thumbnail_16_9', title: 'Thumbnail (16:9)', type: 'attachment', required: false, unique: false, readonly: false, is_primary: false, order: 2, created_at: '', updated_at: '' },
        ],
        views: [],
        created_at: '',
        updated_at: '',
      }],
      created_at: '',
      updated_at: '',
    } as never)
    vi.mocked(createWorkspaceDocument).mockResolvedValueOnce({
      path: 'Thumbnail Generator.kitable',
      name: 'Thumbnail Generator.kitable',
      content: '',
      format: 'data',
    })

    await createTableWorkspaceEntry({ rootPath: '/workspace', template: aiTemplate })

    const createPayload = vi.mocked(createDataDocument).mock.calls[0]?.[0]
    expect(createPayload?.tables?.[0]?.fields?.find((field) => field.title === 'Thumbnail (16:9)'))
      .not.toHaveProperty('aiConfig')
    expect(updateDataField).toHaveBeenCalledWith(8, 12, 33, {
      options: {
        ai_config: expect.objectContaining({
          type: 'image_customization',
          source_field_id: 32,
          aspect_ratio: '16:9',
          prompt: 'Create a thumbnail for {{key_message}}',
        }),
      },
    })
    expect(createDataRecord).toHaveBeenCalledWith(8, 12, { key_message: 'Build faster' })
  })

  it('uploads bundled assets and materializes per-view field layout', async () => {
    const assetTemplate: KitableTemplateDefinition = {
      ...template,
      assetManifestPath: '/templates/test/manifest.json',
      tables: [{
        title: 'Projects',
        description: 'Projects and status',
        fields: [
          { title: 'Project', name: 'project', type: 'text', primary: true },
          { title: 'Preview', name: 'preview', type: 'attachment' },
        ],
        views: [{
          title: 'Quick Start',
          type: 'grid',
          config: { row_height: 'extra_tall' },
          hiddenFieldTitles: ['Preview'],
          fieldLayouts: [
            { fieldTitle: 'Project', position: 0, width: 244, frozen: true },
            { fieldTitle: 'Preview', position: 1, width: 581, visible: false },
          ],
        }],
        records: [{
          Project: 'Website refresh',
          Preview: { assetIds: ['preview-1'] },
        }],
      }],
    }
    vi.mocked(createDataDocument).mockResolvedValueOnce({
      id: 9,
      user_id: 1,
      workspace_root: '/workspace',
      path: 'Project tracker.kitable',
      title: 'Project tracker',
      tables: [{
        id: 13,
        user_id: 1,
        document_id: 9,
        name: 'projects',
        title: 'Projects',
        description: '',
        order: 0,
        fields: [
          { id: 41, user_id: 1, document_id: 9, table_id: 13, name: 'project', title: 'Project', type: 'text', required: false, unique: false, readonly: false, is_primary: true, order: 0, created_at: '', updated_at: '' },
          { id: 42, user_id: 1, document_id: 9, table_id: 13, name: 'preview', title: 'Preview', type: 'attachment', required: false, unique: false, readonly: false, is_primary: false, order: 1, created_at: '', updated_at: '' },
        ],
        views: [{ id: 51, user_id: 1, document_id: 9, table_id: 13, title: 'Quick Start', type: 'grid', order: 0, locked: false, config: {}, created_at: '', updated_at: '' }],
        created_at: '',
        updated_at: '',
      }],
      created_at: '',
      updated_at: '',
    } as never)
    vi.mocked(listViewFields).mockResolvedValueOnce({
      items: [
        { view_id: 51, field_id: 41, visible: true, width: 120, position: 0, frozen: false },
        { view_id: 51, field_id: 42, visible: true, width: 120, position: 1, frozen: false },
      ],
    })
    const uploadedAttachment = {
      name: 'preview.png',
      url: '/uploads/preview.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    }
    vi.mocked(uploadDataAttachment).mockResolvedValueOnce(uploadedAttachment)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({
          templateId: 'test-template',
          source: 'Test fixture',
          assetCount: 1,
          totalSizeBytes: 3,
          assets: [{
            id: 'preview-1',
            record: 1,
            field: 'Preview',
            sourceName: 'preview.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            width: 1,
            height: 1,
            sha256: 'fixture',
            path: '/templates/test/preview.png',
          }],
        }), { status: 200 })
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await createTableWorkspaceEntry({ rootPath: '/workspace', template: assetTemplate })

    expect(updateDataView).toHaveBeenCalledWith(9, 13, 51, {
      config: {
        row_height: 'extra_tall',
        hidden_field_names: ['preview'],
      },
    })
    expect(patchViewField).toHaveBeenNthCalledWith(1, 9, 13, 51, 41, {
      position: 0,
      width: 244,
      frozen: true,
    })
    expect(patchViewField).toHaveBeenNthCalledWith(2, 9, 13, 51, 42, {
      position: 1,
      width: 581,
      visible: false,
    })
    expect(uploadDataAttachment).toHaveBeenCalledWith(9, 13, expect.any(File))
    const uploadedFile = vi.mocked(uploadDataAttachment).mock.calls[0]?.[2]
    expect(uploadedFile?.name).toBe('preview.png')
    expect(uploadedFile?.type).toBe('image/png')
    expect(uploadedFile?.size).toBe(3)
    expect(createDataRecord).toHaveBeenCalledWith(9, 13, {
      project: 'Website refresh',
      preview: [uploadedAttachment],
    })
  })

  it('materializes dashboard seeds after table IDs are assigned', async () => {
    const dashboardTemplate: KitableTemplateDefinition = {
      ...template,
      dashboards: [{
        id: 'project-dashboard',
        title: 'Project dashboard',
        order: 0,
        source_table_name: 'projects',
        layout: [{ widget_id: 'project-count', x: 0, y: 0, w: 3, h: 2 }],
        widgets: [{
          id: 'project-count',
          title: 'Projects',
          type: 'metric',
          query: { aggregation: 'count' },
        }],
      }],
    }

    await createTableWorkspaceEntry({ rootPath: '/workspace', template: dashboardTemplate })

    expect(instantiateTemplatePackage).not.toHaveBeenCalled()
    expect(updateDataDocument).toHaveBeenCalledWith(7, {
      meta: expect.objectContaining({
        dashboards: [expect.objectContaining({
          id: 'project-dashboard',
          source_table_id: 11,
        })],
      }),
    })
  })
})
