import { describe, expect, it, vi } from 'vitest'

import type { DataField, DataRecord } from '@/types/dataDocument'

import {
  buildCellForField,
  buildGridColumn,
  parseImageAspectRatio,
  readCellValue,
} from './useGridAdapter'
import { GridInnerIcon } from './managers'
import { CellType } from './renderers'
import type { IInnerCell } from './renderers'

function makeField(overrides: Partial<DataField>): DataField {
  return {
    id: overrides.id ?? 1,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    name: overrides.name ?? 'name',
    title: overrides.title ?? overrides.name ?? 'Name',
    type: overrides.type ?? 'text',
    required: false,
    unique: false,
    readonly: overrides.readonly ?? false,
    is_primary: false,
    order: 0,
    options: overrides.options ?? null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as DataField
}

function makeRecord(values: Record<string, unknown>): DataRecord {
  return {
    id: 1,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    row_key: 'row_1',
    order: 1,
    values: values as Record<string, never>,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as DataRecord
}

describe('useGridAdapter — phase 2 field types', () => {
  it('marks AI-enabled fields in the grid header', () => {
    const column = buildGridColumn(makeField({
      ai_config: {
        type: 'summarize',
        enabled: true,
        auto_update: false,
        source_field_id: 2,
      },
    }))

    expect(column.icon).toBe(GridInnerIcon.AI)
  })

  it('does not mark regular fields as AI columns', () => {
    expect(buildGridColumn(makeField({})).icon).toBeUndefined()
  })

  it('passes configured select tones to the grid renderer', () => {
    const cell = buildCellForField(
      makeField({
        type: 'single_select',
        options: {
          choices: ['Draft', 'Ready'],
          choice_tones: { Draft: 'purple', Ready: 'red' },
        },
      }),
      makeRecord({ name: 'Ready' }),
    )

    expect(cell.type).toBe(CellType.Select)
    if (cell.type === CellType.Select) {
      expect(cell.choiceMap?.Draft?.tone).toBe('purple')
      expect(cell.choiceMap?.Ready?.tone).toBe('red')
    }
  })

  it('rating field renders a Rating cell with bounded data', () => {
    const cell = buildCellForField(
      makeField({ type: 'rating', options: { max: 5, icon: 'heart' } }),
      makeRecord({ name: 3 })
    )
    expect(cell.type).toBe(CellType.Rating)
    if (cell.type === CellType.Rating) {
      expect(cell.data).toBe(3)
      expect(cell.max).toBe(5)
      expect(cell.icon).toBe('heart')
    }
  })

  it('rating clamps out-of-range raw values', () => {
    const cell = buildCellForField(
      makeField({ type: 'rating', options: { max: 5 } }),
      makeRecord({ name: 99 })
    )
    expect(cell.type).toBe(CellType.Rating)
    if (cell.type === CellType.Rating) {
      expect(cell.data).toBe(5)
    }
  })

  it('link_to_record renders a readonly Link cell with display labels', () => {
    const cell = buildCellForField(
      makeField({ type: 'link_to_record' }),
      makeRecord({
        name: [
          { row_key: 'r_1', display: 'Project Alpha' },
          { row_key: 'r_2', display: 'Project Beta' },
        ],
      })
    )
    expect(cell.type).toBe(CellType.Link)
    if (cell.type === CellType.Link) {
      expect(cell.data).toEqual(['Project Alpha', 'Project Beta'])
      expect(cell.readonly).toBe(true)
    }
  })

  it('document_link renders a clickable workspace path', () => {
    const onOpenDocument = vi.fn()
    const cell = buildCellForField(
      makeField({ type: 'document_link', readonly: true }),
      makeRecord({ name: 'Mail/Messages/project-update.md' }),
      undefined,
      onOpenDocument,
    )
    expect(cell.type).toBe(CellType.Link)
    if (cell.type === CellType.Link) {
      expect(cell.data).toEqual(['Mail/Messages/project-update.md'])
      cell.onClick?.('Mail/Messages/project-update.md')
      expect(onOpenDocument).toHaveBeenCalledWith('Mail/Messages/project-update.md')
    }
  })

  it('user / created_by / last_modified_by render as readonly User cells', () => {
    for (const type of ['user', 'created_by', 'last_modified_by'] as const) {
      const cell = buildCellForField(
        makeField({ type, id: 10 }),
        makeRecord({ name: [{ id: 'u1', name: 'Alice' }] })
      )
      expect(cell.type).toBe(CellType.User)
      if (cell.type === CellType.User) {
        expect(cell.data).toEqual([{ id: 'u1', name: 'Alice', avatarUrl: undefined }])
        expect(cell.readonly).toBe(true)
      }
    }
  })

  it('button renders a Button cell with options.label', () => {
    const cell = buildCellForField(
      makeField({ type: 'button', options: { label: 'Run pipeline' } }),
      makeRecord({})
    )
    expect(cell.type).toBe(CellType.Button)
    if (cell.type === CellType.Button) {
      expect(cell.data.fieldOptions.label).toBe('Run pipeline')
    }
  })

  it('auto_number / created_time / last_modified_time / lookup / rollup are readonly Text cells', () => {
    for (const type of ['auto_number', 'created_time', 'last_modified_time', 'lookup', 'rollup'] as const) {
      const cell = buildCellForField(makeField({ type }), makeRecord({ name: 'computed' }))
      expect(cell.type).toBe(CellType.Text)
      if (cell.type === CellType.Text) {
        expect(cell.readonly).toBe(true)
      }
    }
  })

  it('plain text field stays editable from grid', () => {
    const cell = buildCellForField(makeField({ type: 'text' }), makeRecord({ name: 'hi' }))
    expect(cell.type).toBe(CellType.Text)
    if (cell.type === CellType.Text) {
      expect(cell.readonly).toBe(false)
      expect(cell.contentAlign).toBe('center')
    }
  })

  it('resolves relative attachment URLs against the desktop backend origin', () => {
    const previousBridge = window.kitionDesktop
    window.kitionDesktop = {
      backendOrigin: 'http://127.0.0.1:18101',
    } as typeof window.kitionDesktop
    try {
      const cell = buildCellForField(
        makeField({ type: 'attachment' }),
        makeRecord({
          name: [{ name: 'preview.png', url: '/uploads/preview.png' }],
        }),
      )
      expect(cell.type).toBe(CellType.Image)
      if (cell.type === CellType.Image) {
        expect(cell.data).toEqual([{
          id: '1-0',
          url: 'http://127.0.0.1:18101/uploads/preview.png',
        }])
      }
    } finally {
      window.kitionDesktop = previousBridge
    }
  })

  it('carries the configured AI image aspect ratio into attachment cells', () => {
    const cell = buildCellForField(
      makeField({
        type: 'attachment',
        ai_config: {
          type: 'image_generation',
          enabled: true,
          auto_update: false,
          source_field_id: 2,
          n: 3,
          quality: 'medium',
          aspect_ratio: '4:3',
          resolution: '1K',
          image_use_case: 'product_showcase',
        },
      }),
      makeRecord({ name: [{ name: 'preview.png', url: '/preview.png' }] }),
    )

    expect(parseImageAspectRatio('4:3')).toBeCloseTo(4 / 3)
    expect(cell.type).toBe(CellType.Image)
    if (cell.type === CellType.Image) {
      expect(cell.imageAspectRatio).toBeCloseTo(4 / 3)
    }
  })

  it('formats date and datetime display values while retaining raw editor data', () => {
    const dateCell = buildCellForField(
      makeField({ type: 'date' }),
      makeRecord({ name: '2026-07-23' }),
    )
    const datetimeValue = '2026-07-23T04:14:47Z'
    const datetimeCell = buildCellForField(
      makeField({ type: 'datetime' }),
      makeRecord({ name: datetimeValue }),
    )

    expect(dateCell.type).toBe(CellType.Text)
    expect(datetimeCell.type).toBe(CellType.Text)
    if (dateCell.type === CellType.Text && datetimeCell.type === CellType.Text) {
      expect(dateCell.data).toBe('2026-07-23')
      expect(dateCell.displayData).not.toBe(dateCell.data)
      expect(dateCell.inputType).toBe('date')
      expect(dateCell.isEditingOnClick).toBe(true)
      expect(datetimeCell.data).toBe(datetimeValue)
      expect(datetimeCell.displayData).not.toBe(datetimeValue)
      expect(datetimeCell.displayData).toContain('2026')
      expect(datetimeCell.inputType).toBe('datetime-local')
      expect(datetimeCell.isEditingOnClick).toBe(true)
    }
  })

  it('formats system timestamp fields as readonly datetime cells', () => {
    for (const type of ['created_time', 'last_modified_time'] as const) {
      const cell = buildCellForField(
        makeField({ type }),
        makeRecord({ name: '2026-07-23T04:14:47Z' }),
      )

      expect(cell.type).toBe(CellType.Text)
      if (cell.type === CellType.Text) {
        expect(cell.displayData).not.toContain('T04:14:47Z')
        expect(cell.readonly).toBe(true)
      }
    }
  })
})

describe('readCellValue — Select cell shape tolerance', () => {
                                                                            
                                                            
                                                      
  const selectField = (type: 'single_select' | 'multi_select') =>
    makeField({ type, options: { choices: ['Not started', 'In progress', 'Done'] } })

  it('single_select with object data (post-edit shape) returns the chosen name string', () => {
    const cell = {
      type: CellType.Select,
      data: { id: 'Not started', title: 'Not started' },
    } as unknown as IInnerCell
    expect(readCellValue(selectField('single_select'), cell)).toBe('Not started')
  })

  it('single_select with single-element array still returns the first name', () => {
    const cell = {
      type: CellType.Select,
      data: [{ id: 'Done', title: 'Done' }],
    } as unknown as IInnerCell
    expect(readCellValue(selectField('single_select'), cell)).toBe('Done')
  })

  it('multi_select keeps array of names', () => {
    const cell = {
      type: CellType.Select,
      data: [{ id: 'a', title: 'a' }, 'b'],
    } as unknown as IInnerCell
    expect(readCellValue(selectField('multi_select'), cell)).toEqual(['a', 'b'])
  })

  it('single_select with null data returns null (cleared cell)', () => {
    const cell = { type: CellType.Select, data: null } as unknown as IInnerCell
    expect(readCellValue(selectField('single_select'), cell)).toBeNull()
  })
})
