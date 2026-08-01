import { ChevronDown, ChevronsLeft, ChevronsRight, Database, FileInput, LayoutDashboard, MoreHorizontal, Pencil, Plus, Search, Workflow } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { WorkspaceCreateMenu } from '@/features/workspace/components/WorkspaceCreateMenu'
import { WorkflowStatusToggle } from '@/features/workflow/components/WorkflowStatusToggle'
import { useWorkflowEnabled } from '@/features/workflow/hooks/useWorkflowEnabled'
import type {
  KitableDashboardSummary,
  KitableTableSummary,
  KitableWorkflowSummary,
} from '@/features/workspace/lib/workspaceTree'
import { cn } from '@/lib/utils'
import { useDismissableLayer } from '@/registry/hooks/use-on-click-outside'

type WorkspaceKitableSidebarProps = {
  defaultCollapsed?: boolean
  activeDashboardId?: string
  activeTableId?: number
  activeWorkflowId?: string
  mode: 'dashboard' | 'table' | 'workflow'
  dashboards: KitableDashboardSummary[]
  tables: KitableTableSummary[]
  workflows: KitableWorkflowSummary[]
  onCreateDashboard: () => void
  onCreateTable: () => void
  onCreateForm?: () => void
  onCreateWorkflow: () => void
  onOpenDashboard: (dashboardId: string) => void
  onOpenTable: (tableId: number) => void
  onOpenWorkflow: (workflowId?: string) => void
  onRenameTable?: (tableId: number, currentTitle: string, nextTitle: string) => void
}

export function WorkspaceKitableSidebar({
  defaultCollapsed = true,
  activeDashboardId,
  activeTableId,
  activeWorkflowId,
  mode,
  dashboards,
  tables,
  workflows,
  onCreateDashboard,
  onCreateTable,
  onCreateForm,
  onCreateWorkflow,
  onOpenDashboard,
  onOpenTable,
  onOpenWorkflow,
  onRenameTable,
}: WorkspaceKitableSidebarProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [collapsedMenuOpen, setCollapsedMenuOpen] = useState(false)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const collapsedMenuRef = useRef<HTMLDivElement | null>(null)
  const createMenuRef = useRef<HTMLSpanElement | null>(null)
  useDismissableLayer(collapsedMenuRef, collapsedMenuOpen, () => setCollapsedMenuOpen(false))
  useDismissableLayer(createMenuRef, createMenuOpen, () => setCreateMenuOpen(false))

  const normalizedQuery = query.trim().toLowerCase()
  const sortedTables = useMemo(
    () => [...tables].sort((left, right) => left.order - right.order),
    [tables],
  )
  const sortedDashboards = useMemo(
    () => [...dashboards].sort((left, right) => left.order - right.order),
    [dashboards],
  )
  const sortedWorkflows = useMemo(
    () => [...workflows],
    [workflows],
  )
  const defaultTable = sortedTables[0]
  const defaultTableId = defaultTable?.id
  const defaultWorkflow = sortedWorkflows[0]
  const defaultWorkflowId = defaultWorkflow?.id
  const orderedAdditionalTables = sortedTables.slice(1).filter(
    (table) => !normalizedQuery || table.title.toLowerCase().includes(normalizedQuery),
  )
  const orderedDashboards = sortedDashboards.filter(
    (dashboard) => !normalizedQuery || dashboard.title.toLowerCase().includes(normalizedQuery),
  )
  const orderedAdditionalWorkflows = sortedWorkflows.slice(1).filter(
    (workflow) => !normalizedQuery || workflow.name.toLowerCase().includes(normalizedQuery),
  )
  const isDefaultTableActive = mode === 'table'
    && (activeTableId == null || activeTableId === defaultTableId)
  const isDefaultWorkflowActive = mode === 'workflow'
    && (activeWorkflowId == null || activeWorkflowId === defaultWorkflowId)
  const activeTableTitle = activeTableId != null
    ? tableDisplayTitle(sortedTables.find((table) => table.id === activeTableId))
    : undefined
  const activeDashboardTitle = activeDashboardId
    ? sortedDashboards.find((dashboard) => dashboard.id === activeDashboardId)?.title
    : undefined
  const activeWorkflowTitle = activeWorkflowId
    ? sortedWorkflows.find((workflow) => workflow.id === activeWorkflowId)?.name
    : undefined
  const activeWorkflow = activeWorkflowId
    ? sortedWorkflows.find((workflow) => workflow.id === activeWorkflowId)
    : undefined
  const workflowEnabled = useWorkflowEnabled(activeWorkflowId || null, activeWorkflow?.enabled)
  const collapsedLabel = mode === 'workflow'
    ? isDefaultWorkflowActive
      ? defaultWorkflow?.kind === 'form_sync' ? defaultWorkflow.name : 'Workflow'
      : activeWorkflowTitle || 'Workflow'
    : mode === 'dashboard'
      ? activeDashboardTitle || 'Dashboard'
      : isDefaultTableActive ? tableDisplayTitle(defaultTable) : activeTableTitle || 'Data table'

  if (collapsed) {
    return (
      <aside
        className="workspace-kitable-sidebar is-collapsed"
        data-testid="workspace-kitable-sidebar"
        data-collapsed="true"
        data-mode={mode}
      >
        <div className="workspace-kitable-sidebar__collapsed-controls">
          <button
            type="button"
            className="workspace-kitable-sidebar__expand"
            onClick={() => {
              setCollapsedMenuOpen(false)
              setCollapsed(false)
            }}
            aria-label="Expand kitable sidebar"
            title="Expand kitable sidebar"
            data-testid="workspace-kitable-expand"
          >
            <ChevronsRight className="size-4" />
          </button>
          <div ref={collapsedMenuRef} className="workspace-kitable-sidebar__collapsed-selector-wrap">
            <button
              type="button"
              className="workspace-kitable-sidebar__collapsed-selector"
              onClick={() => setCollapsedMenuOpen((open) => !open)}
              aria-label="Switch kitable section"
              aria-expanded={collapsedMenuOpen}
              data-testid="workspace-kitable-collapsed-selector"
            >
              <span>{collapsedLabel}</span>
              <ChevronDown className={cn('size-4', collapsedMenuOpen && 'rotate-180')} />
            </button>
            {collapsedMenuOpen ? (
              <div className="workspace-kitable-sidebar__collapsed-menu" data-testid="workspace-kitable-collapsed-menu">
                <button
                  type="button"
                  className={cn(
                    'workspace-kitable-sidebar__collapsed-menu-item',
                    isDefaultTableActive && 'is-active',
                  )}
                  onClick={() => {
                    setCollapsedMenuOpen(false)
                    if (defaultTableId != null) onOpenTable(defaultTableId)
                  }}
                >
                  <Database className="size-4" />
                  <span>{tableDisplayTitle(defaultTable)}</span>
                </button>
                {sortedTables.slice(1).map((table) => (
                  <button
                    key={table.id}
                    type="button"
                    className={cn(
                      'workspace-kitable-sidebar__collapsed-menu-item',
                      mode === 'table' && activeTableId === table.id && 'is-active',
                    )}
                    onClick={() => {
                      setCollapsedMenuOpen(false)
                      onOpenTable(table.id)
                    }}
                  >
                    <Database className="size-4" />
                    <span>{tableDisplayTitle(table)}</span>
                  </button>
                ))}
                {sortedDashboards.map((dashboard) => (
                  <button
                    key={dashboard.id}
                    type="button"
                    className={cn(
                      'workspace-kitable-sidebar__collapsed-menu-item',
                      mode === 'dashboard' && activeDashboardId === dashboard.id && 'is-active',
                    )}
                    onClick={() => {
                      setCollapsedMenuOpen(false)
                      onOpenDashboard(dashboard.id)
                    }}
                  >
                    <LayoutDashboard className="size-4" />
                    <span>{dashboard.title}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={cn(
                    'workspace-kitable-sidebar__collapsed-menu-item',
                    isDefaultWorkflowActive && 'is-active',
                  )}
                  onClick={() => {
                    setCollapsedMenuOpen(false)
                    onOpenWorkflow(defaultWorkflowId)
                  }}
                >
                  {defaultWorkflow?.kind === 'form_sync' ? <FileInput className="size-4" /> : <Workflow className="size-4" />}
                  <span>{defaultWorkflow?.kind === 'form_sync' ? defaultWorkflow.name : 'Workflow'}</span>
                </button>
                {sortedWorkflows.slice(1).map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    className={cn(
                      'workspace-kitable-sidebar__collapsed-menu-item',
                      mode === 'workflow' && activeWorkflowId === workflow.id && 'is-active',
                    )}
                    onClick={() => {
                      setCollapsedMenuOpen(false)
                      onOpenWorkflow(workflow.id)
                    }}
                  >
                    {workflow.kind === 'form_sync' ? <FileInput className="size-4" /> : <Workflow className="size-4" />}
                    <span>{workflow.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {mode === 'workflow' && activeWorkflowId && activeWorkflow && activeWorkflow.kind !== 'form_sync' ? (
            <WorkflowStatusToggle
              enabled={workflowEnabled.enabled}
              saving={workflowEnabled.status === 'saving'}
              testId="workspace-kitable-workflow-toggle"
              onToggle={(next) => void workflowEnabled.setEnabled(next)}
            />
          ) : null}
        </div>
      </aside>
    )
  }

  return (
    <aside className="workspace-kitable-sidebar" data-testid="workspace-kitable-sidebar">
      <div className="workspace-kitable-sidebar__header">
        <label className="workspace-kitable-sidebar__search">
          <Search className="size-4" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search tables, dashboards, and workflows"
            data-testid="workspace-kitable-search"
          />
        </label>
        <span ref={createMenuRef} className="workspace-kitable-sidebar__create-wrap">
          <button
            type="button"
            className="workspace-kitable-sidebar__header-button"
            onClick={() => setCreateMenuOpen((open) => !open)}
            aria-label="Create in kitable"
            title="Create in kitable"
            aria-expanded={createMenuOpen}
            data-testid="workspace-kitable-create"
          >
            <Plus className="size-4" />
          </button>
          <WorkspaceCreateMenu
            open={createMenuOpen}
            variant="kitable"
            onCreateFolder={() => undefined}
            onCreateDocument={() => undefined}
            onCreateDashboard={() => {
              setCreateMenuOpen(false)
              onCreateDashboard()
            }}
            onCreateTable={() => {
              setCreateMenuOpen(false)
              onCreateTable()
            }}
            onCreateForm={onCreateForm ? () => {
              setCreateMenuOpen(false)
              onCreateForm()
            } : undefined}
            onCreateWorkflow={() => {
              setCreateMenuOpen(false)
              onCreateWorkflow()
            }}
          />
        </span>
        <button
          type="button"
          className="workspace-kitable-sidebar__header-button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse kitable sidebar"
          title="Collapse kitable sidebar"
          data-testid="workspace-kitable-collapse"
        >
          <ChevronsLeft className="size-4" />
        </button>
      </div>
      <nav className="workspace-kitable-sidebar__nav" aria-label="Kitable">
        {defaultTable ? (
          <KitableTableNavItem
            table={defaultTable}
            active={isDefaultTableActive}
            testId="workspace-kitable-data-table"
            onOpen={() => onOpenTable(defaultTable.id)}
            onRename={onRenameTable}
          />
        ) : null}

        {orderedDashboards.map((dashboard) => (
          <button
            key={dashboard.id}
            type="button"
            className={cn(
              'workspace-kitable-sidebar__item',
              mode === 'dashboard' && activeDashboardId === dashboard.id && 'is-active',
            )}
            onClick={() => onOpenDashboard(dashboard.id)}
            title={dashboard.title}
            aria-current={mode === 'dashboard' && activeDashboardId === dashboard.id ? 'page' : undefined}
            data-testid={`workspace-kitable-dashboard-${dashboard.id}`}
          >
            <LayoutDashboard className="size-4" />
            <span>{dashboard.title}</span>
          </button>
        ))}

        <button
          type="button"
          className={cn(
            'workspace-kitable-sidebar__item',
            isDefaultWorkflowActive && 'is-active',
          )}
          onClick={() => onOpenWorkflow(defaultWorkflowId)}
          aria-current={isDefaultWorkflowActive ? 'page' : undefined}
          data-testid="workspace-kitable-workflow"
        >
          {defaultWorkflow?.kind === 'form_sync' ? <FileInput className="size-4" /> : <Workflow className="size-4" />}
          <span>{defaultWorkflow?.kind === 'form_sync' ? defaultWorkflow.name : 'Workflow'}</span>
        </button>

        {orderedAdditionalTables.map((table) => (
          <KitableTableNavItem
            key={table.id}
            table={table}
            active={mode === 'table' && activeTableId === table.id}
            testId={`workspace-kitable-table-${table.id}`}
            onOpen={() => onOpenTable(table.id)}
            onRename={onRenameTable}
          />
        ))}

        {orderedAdditionalWorkflows.map((workflow) => (
          <button
            key={workflow.id}
            type="button"
            className={cn(
              'workspace-kitable-sidebar__item',
              mode === 'workflow' && activeWorkflowId === workflow.id && 'is-active',
            )}
            onClick={() => onOpenWorkflow(workflow.id)}
            title={workflow.name}
            data-testid={`workspace-kitable-workflow-${workflow.id}`}
          >
            {workflow.kind === 'form_sync' ? <FileInput className="size-4" /> : <Workflow className="size-4" />}
            <span>{workflow.name}</span>
          </button>
        ))}
      </nav>
    </aside>
  )
}

function tableDisplayTitle(table?: KitableTableSummary) {
  if (!table) return 'Data table'
  if (table.name === 'email_messages' && table.title.trim().toLowerCase() === 'email messages') {
    return 'Data table'
  }
  return table.title.trim() || 'Data table'
}

function KitableTableNavItem({
  table,
  active,
  testId,
  onOpen,
  onRename,
}: {
  table: KitableTableSummary
  active: boolean
  testId: string
  onOpen: () => void
  onRename?: (tableId: number, currentTitle: string, nextTitle: string) => void
}) {
  const displayTitle = tableDisplayTitle(table)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(displayTitle)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  useDismissableLayer(menuRef, menuOpen, () => setMenuOpen(false))

  useEffect(() => {
    if (!renaming) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renaming])

  function commitRename() {
    const nextTitle = draftTitle.trim()
    setRenaming(false)
    if (nextTitle) onRename?.(table.id, table.title, nextTitle)
  }

  return (
    <div ref={menuRef} className="workspace-kitable-sidebar__item-wrap">
      {renaming ? (
        <div className={cn('workspace-kitable-sidebar__item workspace-kitable-sidebar__item-rename', active && 'is-active')}>
          <Database className="size-4" />
          <input
            ref={renameInputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
            aria-label="Data table name"
            data-testid={`${testId}-rename-input`}
          />
        </div>
      ) : (
        <button
          type="button"
          className={cn('workspace-kitable-sidebar__item', active && 'is-active')}
          onClick={onOpen}
          title={displayTitle}
          aria-current={active ? 'page' : undefined}
          data-testid={testId}
        >
          <Database className="size-4" />
          <span>{displayTitle}</span>
        </button>
      )}
      {onRename && !renaming ? (
        <button
          type="button"
          className="workspace-kitable-sidebar__item-menu-trigger"
          aria-label="Open table menu"
          title={`Table options for ${displayTitle}`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          data-testid={`${testId}-menu`}
        >
          <MoreHorizontal className="size-4" />
        </button>
      ) : null}
      {menuOpen && onRename ? (
        <div className="workspace-kitable-sidebar__item-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              setDraftTitle(displayTitle)
              setRenaming(true)
            }}
          >
            <Pencil className="size-4" />
            <span>Rename data table</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
