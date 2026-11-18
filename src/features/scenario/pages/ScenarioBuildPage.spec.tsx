import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScenarioBuildEvent } from '@/features/scenario/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock KitFrame so the spec can assert on the file ScenarioBuildPage shows
// without loading the Table kit.
vi.mock('@/features/kits/public', () => ({
  KitFrame: (props: { path: string; kit: { kitId: string } }) =>
    createElement('div', { 'data-testid': 'mock-kit-frame', 'data-path': props.path, 'data-kit': props.kit.kitId }, 'mock-kit-frame'),
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
  path: 'Receipts.ktable',
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
  beforeEach(() => {
  })
  afterEach(unmount)

  it('renders the progress card inside the drawer with events', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated],
        status: 'streaming',
        baseName: 'Receipts',
        basePath: 'Receipts.ktable',
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
        basePath: 'Receipts.ktable',
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
        basePath: 'Receipts.ktable',
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
        basePath: 'Receipts.ktable',
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
        basePath: 'Receipts.ktable',
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

  it('renders the central placeholder when basePath is present but no table yet', async () => {
    // Without a `table.created` event we do NOT have a tableId; the
    // central area stays in the "waiting for table" placeholder so the
    // user has something to read while the orchestrator finishes table
    // creation.
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, fieldsGenerated],
        status: 'streaming',
        baseName: 'Receipts',
        basePath: 'Receipts.ktable',
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
      container.querySelector('[data-testid="mock-kit-frame"]'),
    ).toBeNull()
  })

  it('shows the new table file in the Table kit once both base.created and table.created have arrived', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, tableCreated, fieldsGenerated],
        status: 'streaming',
        baseName: 'Receipts',
        basePath: 'Receipts.ktable',
        error: null,
        onClose: () => {},
      }),
    )
    const frame = container.querySelector('[data-testid="mock-kit-frame"]')
    expect(frame?.getAttribute('data-path')).toBe('Receipts.ktable')
    expect(frame?.getAttribute('data-kit')).toBe('kit.table')
  })

  it('does not show the table before the file exists', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [],
        status: 'submitting',
        baseName: null,
        basePath: null,
        error: null,
        onClose: () => {},
      }),
    )
    expect(container.querySelector('[data-testid="mock-kit-frame"]')).toBeNull()
  })

  it('renders the "done" central state when status=done', async () => {
    await mount(
      createElement(ScenarioBuildPage, {
        events: [baseCreated, { kind: 'done' }],
        status: 'done',
        baseName: 'Receipts',
        basePath: 'Receipts.ktable',
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
        basePath: null,
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
        basePath: null,
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
        basePath: null,
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
        basePath: 'Receipts.ktable',
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
