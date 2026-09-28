import type { ReactNode } from 'react'

import { WorkspaceKitableSidebar } from '@/features/workspace/components/WorkspaceKitableSidebar'
import { WorkspaceScreenEditor, type WorkspaceScreenEditorInput } from '@/features/workspace/components/WorkspaceScreenEditor'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { KitableSidebarMode } from '@/features/workspace/lib/activeKitable'
import type { WorkspaceTab, WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { buildKitableTableVirtualPath } from '@/features/workspace/lib/workspaceTree'
import { cn } from '@/lib/utils'

/** What the container sidebar can do inside the active .kitable; each takes the container path. */
export type WorkspaceKitableSidebarActions = {
  createDashboard: (kitablePath: string) => unknown
  createTable: (kitablePath: string) => unknown
  createForm: (kitablePath: string) => unknown
  createWorkflow: (kitablePath: string) => unknown
  openDashboard: (kitablePath: string, dashboardId: string) => unknown
  openTable: (kitablePath: string, tableId: number) => unknown
  openWorkflow: (kitablePath: string, workflowId?: string) => unknown
  renameTableLeaf: (node: WorkspaceTreeNode, nextTitle: string) => unknown
}

type WorkspaceEditorFrameProps = {
  /** The active tab's .kitable container, or '' when there is none. */
  kitablePath: string
  kitableMode: KitableSidebarMode
  activeTab: WorkspaceTab | null | undefined
  kitableChildrenIndex: KitableChildrenIndex
  kitableActions: WorkspaceKitableSidebarActions
  /** Full-screen workflow workbench; replaces the editor while open. */
  workbench: ReactNode
  editor: WorkspaceScreenEditorInput
}

/** The editor column: the .kitable container sidebar (when inside one) next to the active pane. */
export function WorkspaceEditorFrame({
  kitablePath,
  kitableMode,
  activeTab,
  kitableChildrenIndex,
  kitableActions: actions,
  workbench,
  editor,
}: WorkspaceEditorFrameProps) {
  return (
    <div className={cn('workspace-editor-frame', kitablePath && 'has-kitable-sidebar')}>
      {kitablePath ? (
        <WorkspaceKitableSidebar
          key={kitablePath}
          mode={kitableMode}
          activeDashboardId={activeTab?.type === 'dashboard' ? activeTab.dashboardId : undefined}
          activeTableId={activeTab?.type === 'table' ? activeTab.tableId : undefined}
          activeWorkflowId={activeTab?.type === 'workflow' ? activeTab.workflowId : undefined}
          dashboards={kitableChildrenIndex.dashboardsByKitablePath[kitablePath] || []}
          tables={kitableChildrenIndex.tablesByKitablePath[kitablePath] || []}
          workflows={kitableChildrenIndex.workflowsByKitablePath[kitablePath] || []}
          onCreateDashboard={() => void actions.createDashboard(kitablePath)}
          onCreateTable={() => void actions.createTable(kitablePath)}
          onCreateForm={() => void actions.createForm(kitablePath)}
          onCreateWorkflow={() => void actions.createWorkflow(kitablePath)}
          onOpenDashboard={(dashboardId) => void actions.openDashboard(kitablePath, dashboardId)}
          onOpenTable={(tableId) => void actions.openTable(kitablePath, tableId)}
          onOpenWorkflow={(workflowId) => void actions.openWorkflow(kitablePath, workflowId)}
          onRenameTable={(tableId, currentTitle, nextTitle) => void actions.renameTableLeaf({
            type: 'file',
            virtual: true,
            path: buildKitableTableVirtualPath(kitablePath, tableId),
            name: currentTitle,
            title: currentTitle,
            format: 'data',
            parentPath: kitablePath,
            children: [],
          }, nextTitle)}
        />
      ) : null}
      <div className="workspace-editor-frame__content">
        {workbench || <WorkspaceScreenEditor {...editor} />}
      </div>
    </div>
  )
}
