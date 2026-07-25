import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScenarioBuildEvent } from '@/features/scenario/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock TableEditor so the spec can assert on the props ScenarioBuildPage
// passes (documentPath, markerContent, aiCellPatches) without dragging in
// the table editor's data-fetching pipeline. The mock renders a sentinel
// node with serialized props so individual tests can read what was sent.
type MockedTableEditorProps = {
  documentPath: string
  markerContent: string
  aiCellPatches?: ReadonlyArray<{
    recordId: number
    fieldId: number
    value: unknown
  }>
}
const tableEditorRenders: MockedTableEditorProps[] = []
vi.mock('@/features/table/components/TableEditor', () => ({
  TableEditor: (props: MockedTableEditorProps) => {
    tableEditorRenders.push({
      documentPath: props.documentPath,
      markerContent: props.markerContent,
      aiCellPatches: props.aiCellPatches
        ? props.aiCellPatches.map((patch) => ({ ...patch }))
        : undefined,
    })
    return createElement(
      'div',
      {
        'data-testid': 'mock-table-editor',
        'data-document-path': props.documentPath,
        'data-marker-content': props.markerContent,
        'data-patch-count': String(props.aiCellPatches?.length ?? 0),
      },
      'mock-table-editor',
    )
  },
}))

import { ScenarioBuildPage } from './ScenarioBuildPage'

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

const baseCreated: ScenarioBuildEvent = {
  kind: 'base.created',
  baseId: '123',
  baseName: 'Receipts',
}

const tableCreated: ScenarioBuildEvent = {
  kind: 'table.created',
  tableId: '7',
  tableName: 'Files',
}

const fieldsGenerated: ScenarioBuildEvent = {
  kind: 'fields.generated',
  stage: 'fields',
  count: 4,
}

const cellAIFilled = (
  recordId: number,
  fieldId: number,
  value: unknown,
): ScenarioBuildEvent => ({
  kind: 'cell.ai.filled',
  recordId,
  fieldId,
  value,
})

describe('ScenarioBuildPage', () => {
  beforeEach(async () => {
    tableEditorRenders.length = 0
    await unmount()
  })

  it('renders the progress card inside the drawer with events', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    // Progress card should be visible
    expect(container.textContent).toContain('Generate fields')
    expect(container.textContent).toContain('Generate AI fields')
    expect(container.textContent).toContain('Generate records')
    expect(container.textContent).toContain('Generate views')
  })

  it('uses baseName as the progress card title once available', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    // The progress card title row should contain baseName
    expect(container.textContent).toContain('Receipts')
  })

  it('drawer is open by default', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    expect(container.querySelector('[data-testid="right-drawer"]')).not.toBeNull()
  })

  it('clicking × hides the drawer and shows a "Show chat" button', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    expect(container.querySelector('[data-testid="right-drawer"]')).not.toBeNull()
    const closeBtn = container.querySelector(
      '[data-testid="right-drawer-close"]',
    ) as HTMLButtonElement
    await act(async () => {
      closeBtn.click()
    })
    expect(container.querySelector('[data-testid="right-drawer"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="scenario-build-show-chat"]'),
    ).not.toBeNull()
  })

  it('clicking "Show chat" re-opens the drawer', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    // Close first
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="right-drawer-close"]',
        ) as HTMLButtonElement
      ).click()
    })
    expect(container.querySelector('[data-testid="right-drawer"]')).toBeNull()

    // Re-open
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="scenario-build-show-chat"]',
        ) as HTMLButtonElement
      ).click()
    })
    expect(container.querySelector('[data-testid="right-drawer"]')).not.toBeNull()
  })

  it('renders the central placeholder when baseId is present but no table yet', async () => {
    // Without a `table.created` event we do NOT have a tableId; the
    // central area stays in the "waiting for table" placeholder so the
    // user has something to read while the orchestrator finishes table
    // creation.
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, fieldsGenerated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    const central = container.querySelector(
      '[data-testid="scenario-build-central"]',
    )
    expect(central).not.toBeNull()
    expect(central?.textContent).toContain('Receipts')
    // No table editor mounted yet.
    expect(
      container.querySelector('[data-testid="mock-table-editor"]'),
    ).toBeNull()
  })

  it('mounts TableEditor once both base.created and table.created have arrived', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, tableCreated, fieldsGenerated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    const editor = container.querySelector(
      '[data-testid="mock-table-editor"]',
    )
    expect(editor).not.toBeNull()
    // documentPath is a synthetic scenario:<baseId> sentinel so the table
    // editor's loader skips path-resolution lookups and goes straight to
    // getDataDocument via the marker payload.
    expect(editor?.getAttribute('data-document-path')).toBe('scenario:123')
    const marker = JSON.parse(
      editor?.getAttribute('data-marker-content') ?? '{}',
    )
    expect(marker).toEqual({ data_document_id: 123 })
  })

  it('does NOT mount TableEditor before baseId arrives', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [],
        status: 'submitting',
        baseName: null,
        baseId: null,
        error: null,
        onClose: () => {},
      }),
    )
    expect(
      container.querySelector('[data-testid="mock-table-editor"]'),
    ).toBeNull()
  })

  it('forwards every cell.ai.filled event to TableEditor as a patch', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [
          baseCreated,
          tableCreated,
          fieldsGenerated,
          cellAIFilled(11, 21, 'apple'),
          cellAIFilled(12, 21, 'banana'),
          cellAIFilled(11, 22, 42),
        ],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    const editor = container.querySelector(
      '[data-testid="mock-table-editor"]',
    ) as HTMLElement
    expect(editor.getAttribute('data-patch-count')).toBe('3')
    const lastRender = tableEditorRenders[tableEditorRenders.length - 1]
    expect(lastRender.aiCellPatches).toEqual([
      { recordId: 11, fieldId: 21, value: 'apple' },
      { recordId: 12, fieldId: 21, value: 'banana' },
      { recordId: 11, fieldId: 22, value: 42 },
    ])
  })

  it('passes an empty patch list when there are no cell.ai.filled events', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, tableCreated, fieldsGenerated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    const editor = container.querySelector(
      '[data-testid="mock-table-editor"]',
    ) as HTMLElement
    expect(editor.getAttribute('data-patch-count')).toBe('0')
  })

  it('renders the "done" central state when status=done', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, { kind: 'done' }],
        status: 'done',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose: () => {},
      }),
    )
    const central = container.querySelector(
      '[data-testid="scenario-build-central"]',
    )
    expect(central?.textContent ?? '').toMatch(/done|finish|open/i)
  })

  it('renders the error message when status=error', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [],
        status: 'error',
        baseName: null,
        baseId: null,
        error: 'inference failed',
        onClose: () => {},
      }),
    )
    expect(container.textContent).toContain('inference failed')
  })

  it('falls back to a generic title when baseName is null', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [],
        status: 'submitting',
        baseName: null,
        baseId: null,
        error: null,
        onClose: () => {},
      }),
    )
    // Progress card always shows; title should still render with the fallback.
    expect(container.querySelector('[data-testid="right-drawer-title"]')).not.toBeNull()
  })

  it('does NOT crash when events is empty', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [],
        status: 'submitting',
        baseName: null,
        baseId: null,
        error: null,
        onClose: () => {},
      }),
    )
    expect(container.querySelector('[data-testid="right-drawer"]')).not.toBeNull()
  })

  it('clicking the Close (back) control fires onClose', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        baseId: '123',
        error: null,
        onClose,
      }),
    )
    const closeBtn = container.querySelector(
      '[data-testid="scenario-build-leave"]',
    ) as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await act(async () => {
      closeBtn.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
