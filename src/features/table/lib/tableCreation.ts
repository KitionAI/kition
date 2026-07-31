import {
  createDataDocument,
  createDataRecord,
  listViewFields,
  patchViewField,
  updateDataDocument,
  updateDataField,
  updateDataView,
} from '@/api/dataDocuments'
import { instantiateTemplatePackage } from '@/api/templates'
import {
  materializeDashboardSeeds,
  readDataDashboards,
  writeDataDashboards,
} from '@/features/dashboard/lib/dashboardMetadata'
import type { KitableTemplateDefinition } from '@/features/table/templates/kitableTemplates'
import type { DataFieldSeed, DataViewSeed } from '@/types/dataDocument'
import {
  collectKitableTemplateAssetIds,
  loadKitableTemplateAssetManifest,
  resolveKitableTemplateRecordValue,
  uploadKitableTemplateAssets,
} from '@/features/table/lib/templateAssets'
import {
  createWorkspaceDocument,
  deleteWorkspaceDocument,
  getDesktopBackendStatus,
  type WorkspaceDocument,
} from '@/services/desktop'
import { getDocumentParentPath } from '@/features/document/lib/documentCreation'

export const DEFAULT_EMPTY_ROW_COUNT = 3

export const DEFAULT_NEW_TABLE_FIELDS: DataFieldSeed[] = [
  { title: 'Title', type: 'text', primary: true, required: false },
  { title: 'Status', type: 'single_select', options: { choices: ['Not started', 'In progress', 'Done'] } },
  { title: 'Notes', type: 'long_text' },
]

export const DEFAULT_NEW_TABLE_VIEWS: DataViewSeed[] = [
  { title: 'Grid view', type: 'grid' },
]

export async function seedDefaultEmptyRows(documentId: number, tableId: number) {
  try {
    await Promise.all(
      Array.from({ length: DEFAULT_EMPTY_ROW_COUNT }, () =>
        createDataRecord(documentId, tableId, {}),
      ),
    )
  } catch {
    // Records are a UX convenience — if seeding fails, the table is still usable.
  }
}

export async function createTableWorkspaceEntry({
  activeDocumentPath = '',
  folderOverride,
  rootPath,
  template,
}: {
  activeDocumentPath?: string
  folderOverride?: string
  rootPath: string
  template?: KitableTemplateDefinition
}): Promise<{
  document: WorkspaceDocument
  successMessage: string
  tableId: number | null
  tableTitle: string
}> {
  const folder = folderOverride ?? (getDocumentParentPath(activeDocumentPath) || '')
  const title = template?.title || 'Untitled table'
  const markerDocument = await createWorkspaceDocument({
    title,
    folder,
    platform: 'Table',
    format: 'data',
  })
  const markerPath = normalizeDataDocumentWorkspacePath(markerDocument.path, title, folder)

  const runtimeCapabilities = template
    ? (await getDesktopBackendStatus())?.capabilities || []
    : []
  const hasTemplateAIFields = Boolean(
    template?.tables.some((table) => table.fields.some((field) => field.aiConfig)),
  )
  const supportsTemplatePackages = Boolean(
    template
    && runtimeCapabilities.includes('template_packages')
    && (!template.dashboards?.length || runtimeCapabilities.includes('template_dashboards'))
    && (!template.assetManifestPath || runtimeCapabilities.includes('template_assets'))
    && (!hasTemplateAIFields || runtimeCapabilities.includes('template_ai_fields_v2'))
  )

  const instantiatedPackage = template && supportsTemplatePackages
    ? await instantiateTemplatePackage(template.id, {
        workspace_root: rootPath,
        path: markerPath,
        include_data: template.snapshot.includeData,
      })
    : null

  let dataDocument = instantiatedPackage?.document || await createDataDocument({
    title,
    workspace_root: rootPath,
    path: markerPath,
    description: template?.documentDescription || 'Kition native table',
    icon: template?.icon,
    color: template?.color,
    meta: template ? {
      template_id: template.id,
      template_snapshot_version: template.snapshot.version,
    } : undefined,
    tables: template
      ? template.tables.map(({ records: _records, fields, views, ...table }) => ({
          ...table,
          fields: fields.map(({ aiConfig: _aiConfig, ...field }) => field),
          views: views.map(({ hiddenFieldTitles: _hiddenFieldTitles, fieldLayouts: _fieldLayouts, ...view }) => view),
        }))
      : [{
          title: 'Table',
          fields: DEFAULT_NEW_TABLE_FIELDS,
          views: DEFAULT_NEW_TABLE_VIEWS,
        }],
  })

  const packageTableId = instantiatedPackage?.default_resource.table_id
    || instantiatedPackage?.resources.find((resource) => resource.kind === 'table' && resource.table_id)?.table_id
  const seededTable = packageTableId != null
    ? dataDocument.tables?.find((table) => Number(table.id) === Number(packageTableId)) || dataDocument.tables?.[0]
    : dataDocument.tables?.[0]
  if (template && !instantiatedPackage) {
    await configureKitableTemplateAIFields(dataDocument, template)
    await configureKitableTemplateViews(dataDocument, template)
    await seedKitableTemplateRecords(dataDocument, template)
  } else if (!template && seededTable?.id != null) {
    await seedDefaultEmptyRows(dataDocument.id, seededTable.id)
  }

  if (template?.dashboards?.length && readDataDashboards(dataDocument.meta).length === 0) {
    const dashboards = materializeDashboardSeeds(dataDocument, template.dashboards)
    dataDocument = await updateDataDocument(dataDocument.id, {
      meta: writeDataDashboards(dataDocument.meta, dashboards),
    })
  }

  if (markerDocument.path !== markerPath) {
    try {
      await deleteWorkspaceDocument(markerDocument.path)
    } catch {
      // Older desktop builds may already have skipped the temporary Markdown marker.
    }
  }

  return {
    document: {
      ...markerDocument,
      path: markerPath,
      name: markerPath.split('/').pop() || markerDocument.name,
      content: '',
      format: 'data',
      updated_at: new Date().toISOString(),
    },
    successMessage: 'Table created',
    tableId: seededTable?.id != null ? Number(seededTable.id) : null,
    tableTitle: String(seededTable?.title || 'Table'),
  }
}

async function configureKitableTemplateAIFields(
  dataDocument: Awaited<ReturnType<typeof createDataDocument>>,
  template: KitableTemplateDefinition,
) {
  for (const [index, tableTemplate] of template.tables.entries()) {
    const createdTable = dataDocument.tables?.[index]
      || dataDocument.tables?.find((table) => table.title === tableTemplate.title)
    if (!createdTable?.id) continue

    const createdFieldByTitle = new Map(
      (createdTable.fields || []).map((field) => [field.title, field]),
    )
    for (const fieldTemplate of tableTemplate.fields) {
      if (!fieldTemplate.aiConfig) continue
      const createdField = createdFieldByTitle.get(fieldTemplate.title)
      const sourceFieldTitle = fieldTemplate.aiConfig.sourceFieldTitle
      const sourceField = sourceFieldTitle
        ? createdFieldByTitle.get(sourceFieldTitle)
        : undefined
      if (!createdField?.id || (sourceFieldTitle && !sourceField?.id)) {
        throw new Error(`Template AI field could not be configured: ${fieldTemplate.title}`)
      }
      const { sourceFieldTitle: _sourceFieldTitle, ...config } = fieldTemplate.aiConfig
      const resolvedConfig = {
        ...config,
        ...('prompt' in config
          ? { prompt: resolveKitableTemplatePrompt(config.prompt, createdFieldByTitle) }
          : {}),
        ...(sourceField?.id ? { source_field_id: sourceField.id } : {}),
      }
      await updateDataField(dataDocument.id, createdTable.id, createdField.id, {
        options: {
          ...(createdField.options || {}),
          ai_config: resolvedConfig,
        },
      })
    }
  }
}

function resolveKitableTemplatePrompt(
  prompt: string,
  createdFieldByTitle: Map<string, { name: string }>,
) {
  return prompt.replace(/{{\s*([^{}]+?)\s*}}/g, (placeholder, fieldTitle: string) => {
    const field = createdFieldByTitle.get(fieldTitle.trim())
    return field ? `{{${field.name}}}` : placeholder
  })
}

async function configureKitableTemplateViews(
  dataDocument: Awaited<ReturnType<typeof createDataDocument>>,
  template: KitableTemplateDefinition,
) {
  for (const [index, tableTemplate] of template.tables.entries()) {
    const createdTable = dataDocument.tables?.[index]
      || dataDocument.tables?.find((table) => table.title === tableTemplate.title)
    if (!createdTable?.id) continue

    const createdFieldByTitle = new Map(
      (createdTable.fields || []).map((field) => [field.title, field]),
    )
    const createdViewByTitle = new Map(
      (createdTable.views || []).map((view) => [view.title, view]),
    )

    for (const viewTemplate of tableTemplate.views) {
      const createdView = createdViewByTitle.get(viewTemplate.title)
      if (!createdView?.id) continue

      const hiddenFieldNames = (viewTemplate.hiddenFieldTitles || []).map((fieldTitle) => {
        const field = createdFieldByTitle.get(fieldTitle)
        if (!field) throw new Error(`Template view field could not be configured: ${fieldTitle}`)
        return field.name
      })
      if (viewTemplate.config || hiddenFieldNames.length) {
        await updateDataView(dataDocument.id, createdTable.id, createdView.id, {
          config: {
            ...(createdView.config || {}),
            ...(viewTemplate.config || {}),
            ...(hiddenFieldNames.length ? { hidden_field_names: hiddenFieldNames } : {}),
          },
        })
      }

      if (!viewTemplate.fieldLayouts?.length) continue
      const viewFields = await listViewFields(dataDocument.id, createdTable.id, createdView.id)
      const viewFieldIds = new Set(viewFields.items.map((item) => item.field_id))
      for (const layout of viewTemplate.fieldLayouts) {
        const field = createdFieldByTitle.get(layout.fieldTitle)
        if (!field?.id || (viewFieldIds.size && !viewFieldIds.has(field.id))) {
          throw new Error(`Template view field could not be configured: ${layout.fieldTitle}`)
        }
        const { fieldTitle: _fieldTitle, ...payload } = layout
        await patchViewField(
          dataDocument.id,
          createdTable.id,
          createdView.id,
          field.id,
          payload,
        )
      }
    }
  }
}

async function seedKitableTemplateRecords(
  dataDocument: Awaited<ReturnType<typeof createDataDocument>>,
  template: KitableTemplateDefinition,
) {
  const assetManifest = template.assetManifestPath
    ? await loadKitableTemplateAssetManifest(template.assetManifestPath)
    : null
  for (const [index, tableTemplate] of template.tables.entries()) {
    const createdTable = dataDocument.tables?.[index]
      || dataDocument.tables?.find((table) => table.title === tableTemplate.title)
    if (!createdTable?.id) {
      throw new Error(`Template table was not created: ${tableTemplate.title}`)
    }
    const fieldNameByTitle = new Map(
      (createdTable.fields || []).map((field) => [field.title, field.name]),
    )
    const assetIds = collectKitableTemplateAssetIds(tableTemplate.records)
    if (assetIds.length && !assetManifest) {
      throw new Error(`Template asset manifest was not configured: ${template.id}`)
    }
    const attachmentByAssetId = assetManifest
      ? await uploadKitableTemplateAssets({
          documentId: dataDocument.id,
          tableId: createdTable.id,
          manifest: assetManifest,
          assetIds,
        })
      : new Map()
    await Promise.all(tableTemplate.records.map((record) => {
      const values = Object.fromEntries(
        Object.entries(record).flatMap(([fieldTitle, value]) => {
          const fieldName = fieldNameByTitle.get(fieldTitle)
          return fieldName
            ? [[fieldName, resolveKitableTemplateRecordValue(value, attachmentByAssetId)]]
            : []
        }),
      )
      return createDataRecord(dataDocument.id, createdTable.id, values)
    }))
  }
}

function normalizeDataDocumentWorkspacePath(path: string, title: string, fallbackFolder = '') {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim()
  if (/\.kitable$/i.test(normalizedPath)) {
    return normalizedPath
  }

  const parentPath = getDocumentParentPath(normalizedPath) || fallbackFolder
  const rawFilename = normalizedPath.split('/').pop() || title || 'Untitled table'
  const filename = /\.(md|markdown)$/i.test(rawFilename)
    ? rawFilename.replace(/\.(md|markdown)$/i, '.kitable')
    : `${rawFilename.replace(/\.kitable$/i, '')}.kitable`

  return parentPath ? `${parentPath}/${filename}` : filename
}
