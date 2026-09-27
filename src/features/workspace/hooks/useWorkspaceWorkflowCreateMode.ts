import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createWorkflow, type WorkflowDefinition } from '@/api/workflows'
import type { WorkspaceWorkflowCreateModeChoice } from '@/features/workspace/components/WorkspaceWorkflowCreateModeDialog'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { WorkspaceTreeMetadata } from '@/features/workspace/lib/workspacePersistence'
import {
  buildKitableWorkflowVirtualPath,
  parseKitableTableVirtualPath,
} from '@/features/workspace/lib/workspaceTree'
import type { WorkspaceTab, WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { buildKitableWorkspaceTabId, getKitableWorkspaceTabTitle } from '@/features/workspace/lib/workspace'
import { createWorkflowFromMode, openWorkflowRoute, type WorkflowRouteContext } from '@/features/workflow/public'

export type WorkflowCreateModeState = {
  context: WorkflowRouteContext | null
  tableOptions: WorkflowRouteContext[]
  kitablePath: string | null
}

export type WorkflowCreateModeBusyKind = 'template' | 'chat' | 'scratch' | null

type UseWorkspaceWorkflowCreateModeOptions = {
  kitableChildrenIndex: Pick<KitableChildrenIndex, 'docIdByKitablePath' | 'tablesByKitablePath' | 'refresh'>
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  updateTreeMetadata: (updater: (metadata: WorkspaceTreeMetadata) => WorkspaceTreeMetadata) => void
  setError: (message: string) => void
}

/** Tree node shape for a .kitable container, used when the sidebar asks to create a workflow under it. */
function kitableContainerNode(kitablePath: string): WorkspaceTreeNode {
  const name = kitablePath.split('/').pop() || kitablePath
  const parentPath = kitablePath.includes('/') ? kitablePath.slice(0, kitablePath.lastIndexOf('/')) : ''
  return {
    type: 'file',
    path: kitablePath,
    filePath: kitablePath,
    name,
    title: name.replace(/\.kitable$/i, ''),
    format: 'data',
    parentPath,
    children: [],
  }
}

/**
 * The "how do you want to create this workflow" dialog: which table it is
 * for, the choice between template, scratch, and AI chat, and the routing
 * that follows creation. Owns the dialog state so WorkspaceScreen only
 * renders it.
 */
export function useWorkspaceWorkflowCreateMode({
  kitableChildrenIndex,
  upsertWorkspaceTab,
  setActiveResourcePath,
  updateTreeMetadata,
  setError,
}: UseWorkspaceWorkflowCreateModeOptions) {
  const { t } = useTranslation('workspace')
  const [state, setState] = useState<WorkflowCreateModeState | null>(null)
  const [busyKind, setBusyKind] = useState<WorkflowCreateModeBusyKind>(null)
  const [busyTemplateId, setBusyTemplateId] = useState<string | undefined>(undefined)
  const [error, setDialogError] = useState<string | null>(null)

  const openForContext = useCallback((
    kitablePath: string | null,
    context: WorkflowRouteContext | null,
    tableOptions: WorkflowRouteContext[] = context ? [context] : [],
  ) => {
    setDialogError(null)
    setBusyKind(null)
    setBusyTemplateId(undefined)
    setState({ kitablePath, context, tableOptions })
  }, [])

  const openForTreeNode = useCallback((node: WorkspaceTreeNode) => {
    // Case 1: .kitable container row.
    const isKitableContainer = node.type === 'file' && !node.virtual && node.name.toLowerCase().endsWith('.kitable')
    if (isKitableContainer) {
      const kitablePath = node.path
      const docId = kitableChildrenIndex.docIdByKitablePath[kitablePath]
      if (!docId) {
        setError(t('errors.kitableNotFound'))
        return
      }
      const tables = kitableChildrenIndex.tablesByKitablePath[kitablePath] || []
      if (tables.length === 0) {
        setError(t('errors.kitableNoTables'))
        return
      }
      const tableOptions = tables.map((table) => ({
        documentId: String(docId),
        tableId: String(table.id),
        tableName: table.title || node.title || t('tabs.untitledTable'),
      }))
      openForContext(kitablePath, tableOptions[0], tableOptions)
      return
    }
    // Case 2: virtual `table://` leaf (legacy entry).
    const parsed = parseKitableTableVirtualPath(node.path)
    if (!parsed) return
    const docId = kitableChildrenIndex.docIdByKitablePath[parsed.kitablePath]
    if (!docId) {
      setError(t('errors.parentKitableNotFound'))
      return
    }
    const summary = (kitableChildrenIndex.tablesByKitablePath[parsed.kitablePath] || []).find(
      (table) => table.id === parsed.tableId,
    )
    openForContext(parsed.kitablePath, {
      documentId: String(docId),
      tableId: String(parsed.tableId),
      tableName: summary?.title || node.title || t('tabs.untitledTable'),
    })
  }, [kitableChildrenIndex, openForContext, setError, t])

  const openForKitable = useCallback((kitablePath: string) => {
    openForTreeNode(kitableContainerNode(kitablePath))
  }, [openForTreeNode])

  const close = useCallback(() => {
    setState(null)
    setDialogError(null)
    setBusyKind(null)
    setBusyTemplateId(undefined)
  }, [])

  const select = useCallback((choice: WorkspaceWorkflowCreateModeChoice) => {
    if (!state) return
    const selectedContext = choice.context || state.context
    if (choice.kind === 'chat') {
      // AI mode runs in the standalone /workflow route: close the dialog
      // synchronously and let the router show the chat-first surface.
      // state.context may be null (unbound creation); openWorkflowRoute
      // accepts null and persists it as the route context.
      close()
      openWorkflowRoute(selectedContext, { mode: 'ai' })
      return
    }
    // Template and scratch share the post-create routing: attach the new
    // workflow under the source .kitable tab when there is one, otherwise
    // open the standalone editor so the user can pick a table there.
    const finalizeCreatedWorkflow = (def: WorkflowDefinition) => {
      if (state.kitablePath) {
        const kitablePath = state.kitablePath
        updateTreeMetadata((current) => (
          current.collapsed.includes(kitablePath)
            ? current
            : { ...current, collapsed: [...current.collapsed, kitablePath] }
        ))
        upsertWorkspaceTab({
          id: buildKitableWorkspaceTabId(kitablePath),
          type: 'workflow',
          title: getKitableWorkspaceTabTitle(kitablePath),
          kitablePath,
          workflowId: def.id,
        })
        setActiveResourcePath(buildKitableWorkflowVirtualPath(kitablePath, def.id))
      } else {
        openWorkflowRoute(null, { mode: 'editor' })
      }
      void kitableChildrenIndex.refresh()
      close()
    }
    const fail = (err: unknown) => {
      setDialogError(err instanceof Error ? err.message : t('errors.createWorkflowFailed'))
      setBusyKind(null)
      setBusyTemplateId(undefined)
    }
    if (choice.kind === 'scratch') {
      // Seed trigger.type with record_created: the create endpoint rejects an
      // empty type, and the drawer's event dropdown defaults to it anyway.
      // documentId/tableId stay empty for delayed binding when no context is pinned.
      setDialogError(null)
      setBusyKind('scratch')
      setBusyTemplateId(undefined)
      void createWorkflow({
        name: 'Untitled workflow',
        description: '',
        enabled: false,
        trigger: {
          type: 'record_created',
          documentId: selectedContext?.documentId ?? '',
          tableId: selectedContext?.tableId ?? '',
        },
        action: {
          type: 'send_email',
          connectionId: '',
          to: 'you@example.com',
          subject: { parts: [{ kind: 'text', text: 'New record' }] },
          body: { parts: [{ kind: 'text', text: 'A new record was created.' }] },
        },
      }).then(finalizeCreatedWorkflow, fail)
      return
    }
    // Template branch: when state.context is null the helper skips the schema
    // fetch and produces a draft the user binds to a table afterwards.
    setDialogError(null)
    setBusyKind('template')
    setBusyTemplateId(choice.template.id)
    void createWorkflowFromMode(choice.template, selectedContext).then(({ workflow: def, unresolvedFieldNames }) => {
      // Same one-shot handoff the inline launcher uses: the post-creation
      // editor reads this key to show the "template fields couldn't be bound" banner.
      if (unresolvedFieldNames.length > 0) {
        try {
          window.sessionStorage.setItem(
            `kition:workflow:template-unresolved:${def.id}`,
            JSON.stringify(unresolvedFieldNames),
          )
        } catch {
          // sessionStorage may be unavailable in some Electron contexts; the banner is non-critical.
        }
      }
      finalizeCreatedWorkflow(def)
    }, fail)
  }, [close, kitableChildrenIndex, setActiveResourcePath, state, t, updateTreeMetadata, upsertWorkspaceTab])

  return {
    state,
    busyKind,
    busyTemplateId,
    error,
    openForContext,
    openForTreeNode,
    openForKitable,
    close,
    select,
  }
}
