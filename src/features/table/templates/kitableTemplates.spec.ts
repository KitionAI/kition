import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { getBuiltinKitableTemplates } from './kitableTemplates'

const t = ((key: string) => key) as TFunction<'table'>

describe('getBuiltinKitableTemplates', () => {
  it('provides a categorized template catalog with seeded records', () => {
    const templates = getBuiltinKitableTemplates(t)

    expect(templates).toHaveLength(13)
    expect(templates.map((template) => template.id)).toEqual([
      'task-tracker',
      'thumbnail-generator',
      'email-inbox-sync',
      'leads-landing-page',
      'sdr-cold-call-manager',
      'product-launch-website',
      'batch-product-designer',
      'simple-client-crm',
      'lumiere-restaurant',
      'business-analytics-dashboard',
      'ecommerce-orders-returns',
      'recruitment-pipeline',
      'project-gantt',
    ])
    expect(templates
      .filter((template) => template.id !== 'email-inbox-sync')
      .every((template) => template.tables.every((table) => table.records.length > 0))).toBe(true)
    expect(templates.every((template) => template.categories?.length)).toBe(true)
    expect(templates.every((template) => template.snapshot.resources.some((resource) => resource.id === template.snapshot.defaultResourceId))).toBe(true)
  })

  it('ships a visible structure-only inbox template that starts with a full sync', () => {
    const template = getBuiltinKitableTemplates(t).find((item) => item.id === 'email-inbox-sync')

    expect(template).toMatchObject({
      localOnly: true,
      afterCreate: { type: 'email-sync', runAfterSave: 'full' },
      snapshot: {
        includeData: false,
        defaultResourceId: 'inbox',
      },
    })
    expect(template?.snapshot.resources.map((resource) => resource.kind)).toEqual(['table', 'automation'])
    expect(template?.tables[0]?.title).toBe('Inbox')
    expect(template?.tables[0]?.records).toEqual([])
    expect(template?.tables[0]?.fields.map((field) => field.title)).toEqual([
      'Subject',
      'From',
      'To',
      'Received At',
      'Mailbox',
      'Preview',
      'Has Attachments',
      'Status',
      'Message ID',
      'Document',
    ])
  })

  it('keeps every sample value aligned with a declared field title', () => {
    for (const template of getBuiltinKitableTemplates(t)) {
      for (const table of template.tables) {
        const fieldTitles = new Set(table.fields.map((field) => field.title))
        for (const record of table.records) {
          expect(Object.keys(record).every((key) => fieldTitles.has(key))).toBe(true)
        }
      }
    }
  })

  it('matches the Task Tracker reference data and dashboard snapshot', () => {
    const template = getBuiltinKitableTemplates(t).find((item) => item.id === 'task-tracker')
    const table = template?.tables[0]

    expect(template?.snapshot.version).toBe(2)
    expect(template?.snapshot.resources.map((resource) => resource.kind)).toEqual([
      'table',
      'dashboard',
    ])
    expect(template?.tables).toHaveLength(1)
    expect(table?.title).toBe('Task Management')
    expect(table?.fields.map((field) => field.title)).toEqual([
      'Task Description',
      'Task Summary',
      'Assignee',
      'Progress',
      'Start Date',
      'Expected Completion Date',
      'Actual Completion Date',
      'Important',
      'Latest Progress Update',
      'Notes',
    ])
    expect(table?.records).toHaveLength(20)
    expect(table?.records.filter((record) => record.Progress === 'Completed')).toHaveLength(7)
    expect(table?.records.filter((record) => record.Progress === 'In Progress')).toHaveLength(9)
    expect(table?.records.filter((record) => record.Progress === 'Not Started')).toHaveLength(4)
    expect(table?.records.filter((record) => record.Important === true)).toHaveLength(8)
    expect(table?.records[0]).toMatchObject({
      'Task Description': 'User Requirement Research',
      Assignee: 'Michael',
      Progress: 'In Progress',
    })
    expect(table?.records.at(-1)).toMatchObject({
      'Task Description': 'Funding Pitch Preparation',
      Assignee: 'Sophia',
      Progress: 'Completed',
    })
    expect(template?.dashboards?.[0]).toMatchObject({
      id: 'task-dashboard',
      title: 'Task Dashboard',
      source_table_name: 'Task Management',
    })
    expect(template?.dashboards?.[0]?.widgets).toHaveLength(8)
  })

  it('ships the original thumbnail generator data, views, and AI pipeline', () => {
    const template = getBuiltinKitableTemplates(t).find((item) => item.id === 'thumbnail-generator')
    const table = template?.tables[0]
    const landscapeTitle = table?.fields.find((field) => field.title === 'Thumbnail Title (16:9)')
    const landscape = table?.fields.find((field) => field.title === 'Thumbnail (16:9)')
    const vertical = table?.fields.find((field) => field.title === 'Thumbnail (9:16)')

    expect(template?.snapshot.version).toBe(5)
    expect(template?.snapshot.resources.map((resource) => resource.kind)).toEqual(['table'])
    expect(template?.assetManifestPath).toBe('/templates/youtube-tiktok-thumbnail-generator/manifest.json')
    expect(table?.title).toBe('Video Thumbnail Studio')
    expect(table?.fields.map((field) => field.title)).toEqual([
      'Key Message',
      'Face Photo',
      'Content Type',
      'Core Emotion',
      'Thumbnail Title (16:9)',
      'Thumbnail Title (9:16)',
      'Thumbnail Layout',
      'Hook Strength',
      'Thumbnail (16:9)',
      'Thumbnail (9:16)',
    ])
    expect(table?.fields.find((field) => field.title === 'Content Type')?.options?.choices).toEqual([
      'Gaming',
      'Entertainment & Challenges',
      'How-to & Education',
      'Tech & Reviews',
      'Lifestyle & Vlog',
      'News & Commentary',
      'Business & Finance',
      'Health & Fitness',
    ])
    expect(table?.fields.find((field) => field.title === 'Core Emotion')?.options?.choices).toHaveLength(11)
    expect(landscapeTitle?.aiConfig).toMatchObject({
      type: 'customize',
      auto_update: true,
    })
    expect(landscapeTitle?.aiConfig && 'prompt' in landscapeTitle.aiConfig
      ? landscapeTitle.aiConfig.prompt
      : '').toContain('{{Key Message}}')
    expect(landscape?.aiConfig).toMatchObject({
      type: 'image_customization',
      sourceFieldTitle: 'Face Photo',
      aspect_ratio: '16:9',
      resolution: '1K',
      quality: 'high',
      n: 2,
      enabled: true,
      auto_update: true,
    })
    expect(landscape?.aiConfig).not.toHaveProperty('size')
    expect(landscape?.aiConfig && 'prompt' in landscape.aiConfig
      ? landscape.aiConfig.prompt
      : '').toContain('{{Key Message}}')
    expect(landscape?.aiConfig && 'prompt' in landscape.aiConfig
      ? landscape.aiConfig.prompt
      : '').toContain('Identity is mandatory')
    expect(vertical?.aiConfig).toMatchObject({ aspect_ratio: '9:16', resolution: '1K', n: 2 })
    expect(table?.views.map((view) => view.title)).toEqual(['Quick Start', 'Advanced'])
    expect(table?.views[0]).toMatchObject({
      config: { row_height: 'extra_tall', frozen_column_count: 1 },
      hiddenFieldTitles: [
        'Thumbnail Title (16:9)',
        'Thumbnail Title (9:16)',
        'Thumbnail Layout',
        'Hook Strength',
      ],
    })
    expect(table?.views[0]?.fieldLayouts?.find((layout) => layout.fieldTitle === 'Thumbnail (16:9)'))
      .toMatchObject({ width: 520 })
    expect(table?.records).toHaveLength(5)
    expect(table?.records[0]).toMatchObject({
      'Key Message': 'I built a silent recording studio inside a closet',
      'Thumbnail Title (16:9)': 'A Studio in a Closet',
      'Thumbnail Layout': 'Left Face / Right Title',
      'Hook Strength': 'Low',
    })
    expect(table?.records.at(-1)).toMatchObject({
      'Key Message': 'I mapped every hidden stairway in my city',
      'Thumbnail Title (9:16)': 'Secret City Stairs',
    })
    const referencedAssetIds = table?.records.flatMap((record) =>
      Object.values(record).flatMap((value) =>
        value
          && typeof value === 'object'
          && !Array.isArray(value)
          && 'assetIds' in value
          && Array.isArray(value.assetIds)
          ? value.assetIds
          : [],
      ),
    ) || []
    expect(referencedAssetIds).toHaveLength(25)
    expect(new Set(referencedAssetIds).size).toBe(25)
  })

  it('ships the original batch product designer data, assets, and AI pipeline', () => {
    const template = getBuiltinKitableTemplates(t).find((item) => item.id === 'batch-product-designer')
    const table = template?.tables[0]
    const designs = table?.fields.find((field) => field.title === 'Designs')
    const orthographicViews = table?.fields.find((field) => field.title === 'Orthographic views')
    const linkedInCopy = table?.fields.find((field) => field.title === 'LinkedIn copy')

    expect(template?.snapshot.version).toBe(3)
    expect(template?.snapshot.resources.map((resource) => resource.kind)).toEqual(['table'])
    expect(template?.assetManifestPath).toBe('/templates/batch-product-designer/manifest.json')
    expect(table?.title).toBe('Product Concepts')
    expect(table?.fields.map((field) => field.title)).toEqual([
      'Concept',
      'Concept description',
      'Designs',
      'Orthographic views',
      'Feature image',
      'Lifestyle shot',
      'Style board',
      'LinkedIn copy',
      'Twitter copy',
    ])
    expect(designs?.aiConfig).toMatchObject({
      type: 'image_generation',
      sourceFieldTitle: 'Concept description',
      aspect_ratio: '4:3',
      resolution: '1K',
      n: 2,
      enabled: true,
      auto_update: true,
    })
    expect(orthographicViews?.aiConfig).toMatchObject({
      type: 'image_customization',
      sourceFieldTitle: 'Designs',
      aspect_ratio: '16:9',
      image_use_case: 'product_showcase',
    })
    expect(linkedInCopy?.aiConfig).toMatchObject({
      type: 'customize',
      auto_update: true,
    })
    expect(table?.views).toEqual([
      expect.objectContaining({
        title: 'Grid View',
        config: { row_height: 'extra_tall', frozen_column_count: 1 },
      }),
    ])
    expect(table?.views[0]?.fieldLayouts?.find((layout) => layout.fieldTitle === 'Designs'))
      .toMatchObject({ position: 2, width: 420 })
    expect(table?.records).toHaveLength(5)
    expect(table?.records[0]).toMatchObject({
      Concept: 'HaloFold Reading Light',
    })
    expect(table?.records.at(-1)).toMatchObject({
      Concept: 'BrewFold Tea Bottle',
    })
    const referencedAssetIds = table?.records.flatMap((record) =>
      Object.values(record).flatMap((value) =>
        value
          && typeof value === 'object'
          && !Array.isArray(value)
          && 'assetIds' in value
          && Array.isArray(value.assetIds)
          ? value.assetIds
          : [],
      ),
    ) || []
    expect(referencedAssetIds).toHaveLength(30)
    expect(new Set(referencedAssetIds).size).toBe(30)
  })
})
