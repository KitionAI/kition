import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceKitableSidebar } from './WorkspaceKitableSidebar'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

describe('WorkspaceKitableSidebar', () => {
  it('starts collapsed by default', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(WorkspaceKitableSidebar, {
        mode: 'table',
        activeTableId: 7,
        tables: [
          { id: 7, title: 'Prospects', order: 0, primaryFieldId: null },
        ],
        workflows: [],
        onCreateTable: vi.fn(),
        onCreateWorkflow: vi.fn(),
        onOpenTable: vi.fn(),
        onOpenWorkflow: vi.fn(),
      }))
    })

    expect(
      container.querySelector('[data-testid="workspace-kitable-sidebar"]')?.getAttribute('data-collapsed'),
    ).toBe('true')
    expect(container.querySelector('[data-testid="workspace-kitable-expand"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="workspace-kitable-search"]')).toBeNull()
  })

  it('shows table titles and routes table/workflow clicks', () => {
    const onOpenTable = vi.fn()
    const onOpenWorkflow = vi.fn()
    const onCreateTable = vi.fn()
    const onCreateWorkflow = vi.fn()
    const onRenameTable = vi.fn()

    act(() => {
      root = createRoot(container)
      root.render(createElement(WorkspaceKitableSidebar, {
        defaultCollapsed: false,
        mode: 'table',
        activeTableId: 7,
        tables: [
          { id: 7, title: 'Prospects', order: 0, primaryFieldId: null },
          { id: 8, title: 'Companies', order: 1, primaryFieldId: null },
        ],
        workflows: [
          { id: 'auto_leads', name: 'Lead routing', enabled: true },
          { id: 'auto_followup', name: 'Follow-up', enabled: false },
        ],
        onCreateTable,
        onCreateWorkflow,
        onOpenTable,
        onOpenWorkflow,
        onRenameTable,
      }))
    })

    const dataTable = container.querySelector('[data-testid="workspace-kitable-data-table"]') as HTMLButtonElement
    const workflow = container.querySelector('[data-testid="workspace-kitable-workflow"]') as HTMLButtonElement
    expect(dataTable.textContent).toContain('Prospects')
    expect(workflow.textContent).toContain('Workflow')
    expect(dataTable.classList.contains('is-active')).toBe(true)
    expect(dataTable.parentElement?.parentElement).toBe(workflow.parentElement)

    act(() => { dataTable.click() })
    expect(onOpenTable).toHaveBeenCalledWith(7)

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-kitable-data-table-menu"]')?.click()
    })
    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent?.includes('Rename data table'))
        ?.click()
    })
    const renameInput = container.querySelector<HTMLInputElement>('[data-testid="workspace-kitable-data-table-rename-input"]')
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(renameInput, 'Qualified prospects')
      renameInput?.dispatchEvent(new Event('input', { bubbles: true }))
      renameInput?.blur()
    })
    expect(onRenameTable).toHaveBeenCalledWith(7, 'Prospects', 'Qualified prospects')

    act(() => { workflow.click() })
    expect(onOpenWorkflow).toHaveBeenCalledWith('auto_leads')

    const followUp = container.querySelector(
      '[data-testid="workspace-kitable-workflow-auto_followup"]',
    ) as HTMLButtonElement
    expect(followUp.parentElement).toBe(workflow.parentElement)
    act(() => { followUp.click() })
    expect(onOpenWorkflow).toHaveBeenLastCalledWith('auto_followup')

    const companies = container.querySelector(
      '[data-testid="workspace-kitable-table-8"]',
    ) as HTMLButtonElement
    expect(companies.parentElement?.parentElement).toBe(workflow.parentElement)
    expect(companies.querySelector('svg')).toBeTruthy()
    act(() => { companies.click() })
    expect(onOpenTable).toHaveBeenCalledWith(8)

    const search = container.querySelector('[data-testid="workspace-kitable-search"]') as HTMLInputElement
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(search, 'follow')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('Follow-up')
    expect(container.textContent).not.toContain('Companies')

    const create = container.querySelector('[data-testid="workspace-kitable-create"]') as HTMLButtonElement
    act(() => { create.click() })
    const createTable = container.querySelector('.document-create-option') as HTMLButtonElement
    expect(createTable).toBeTruthy()
    act(() => { createTable.click() })
    expect(onCreateTable).toHaveBeenCalledTimes(1)

    const collapse = container.querySelector('[data-testid="workspace-kitable-collapse"]') as HTMLButtonElement
    act(() => { collapse.click() })
    expect(container.querySelector('[data-testid="workspace-kitable-expand"]')).toBeTruthy()
    const collapsedSelector = container.querySelector(
      '[data-testid="workspace-kitable-collapsed-selector"]',
    ) as HTMLButtonElement
    expect(collapsedSelector.textContent).toContain('Prospects')

    act(() => { collapsedSelector.click() })
    const collapsedMenu = container.querySelector(
      '[data-testid="workspace-kitable-collapsed-menu"]',
    ) as HTMLDivElement
    expect(collapsedMenu.textContent).toContain('Prospects')
    expect(collapsedMenu.textContent).toContain('Companies')
    expect(collapsedMenu.textContent).toContain('Workflow')
    expect(collapsedMenu.textContent).not.toContain('Lead routing')
    expect(collapsedMenu.textContent).toContain('Follow-up')

    const collapsedWorkflow = Array.from(
      collapsedMenu.querySelectorAll('.workspace-kitable-sidebar__collapsed-menu-item'),
    ).find((node) => node.textContent === 'Follow-up') as HTMLButtonElement
    act(() => { collapsedWorkflow.click() })
    expect(onOpenWorkflow).toHaveBeenLastCalledWith('auto_followup')

    act(() => { collapsedSelector.click() })
    const collapsedCompanies = Array.from(
      container.querySelectorAll('.workspace-kitable-sidebar__collapsed-menu-item'),
    ).find((node) => node.textContent === 'Companies') as HTMLButtonElement
    act(() => { collapsedCompanies.click() })
    expect(onOpenTable).toHaveBeenLastCalledWith(8)

    const expand = container.querySelector('[data-testid="workspace-kitable-expand"]') as HTMLButtonElement
    act(() => { expand.click() })
    expect(container.querySelector('[data-testid="workspace-kitable-search"]')).toBeTruthy()
  })

  it('maps the first workflow to Workflow and shows its enabled toggle when collapsed', async () => {
    const onOpenWorkflow = vi.fn()
    const onWorkflowChanged = vi.fn()
    window.addEventListener('kition:workflow:changed', onWorkflowChanged)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WorkspaceKitableSidebar, {
        defaultCollapsed: false,
        mode: 'workflow',
        activeWorkflowId: 'auto_leads',
        tables: [
          { id: 7, title: 'Prospects', order: 0, primaryFieldId: null },
        ],
        workflows: [
          { id: 'auto_leads', name: 'Lead routing', enabled: true },
          { id: 'auto_followup', name: 'Follow-up', enabled: false },
        ],
        onCreateTable: vi.fn(),
        onCreateWorkflow: vi.fn(),
        onOpenTable: vi.fn(),
        onOpenWorkflow,
      }))
    })

    const workflow = container.querySelector(
      '[data-testid="workspace-kitable-workflow"]',
    ) as HTMLButtonElement
    expect(workflow.classList.contains('is-active')).toBe(true)
    act(() => { workflow.click() })
    expect(onOpenWorkflow).toHaveBeenCalledWith('auto_leads')

    const collapse = container.querySelector(
      '[data-testid="workspace-kitable-collapse"]',
    ) as HTMLButtonElement
    act(() => { collapse.click() })
    expect(container.querySelector(
      '[data-testid="workspace-kitable-collapsed-selector"]',
    )?.textContent).toContain('Workflow')

    const toggle = container.querySelector(
      '[data-testid="workspace-kitable-workflow-toggle"]',
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { toggle.click() })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/workflows/auto_leads/enabled'),
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(onWorkflowChanged).toHaveBeenCalledTimes(1)
    window.removeEventListener('kition:workflow:changed', onWorkflowChanged)
  })
})
