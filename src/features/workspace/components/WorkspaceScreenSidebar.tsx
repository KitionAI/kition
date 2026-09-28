import { FolderOpen, Settings2, UserRound } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

import { CreditUsageBadge } from '@/components/CreditUsageBadge'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { getKitionAccountLinks } from '@/features/account/lib/accountLinks'
import { isKitionAccountAuthenticated } from '@/features/account/lib/accountState'
import { UpdateBanner } from '@/features/updates/UpdateBanner'
import { cn } from '@/lib/utils'
import type { useWorkspaceAgentChatEntryPoints } from '@/features/workspace/hooks/useWorkspaceAgentChatEntryPoints'
import type { useWorkspaceCreateMenu } from '@/features/workspace/hooks/useWorkspaceCreateMenu'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import type { useWorkspaceTreeRowActions } from '@/features/workspace/hooks/useWorkspaceTreeRowActions'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { openExternalURL, revealWorkspaceFolder } from '@/services/desktop'

import { WorkspaceSidebarPanel } from './WorkspaceSidebarPanel'

type SidebarPanelProps = ComponentProps<typeof WorkspaceSidebarPanel>

/** What the sidebar needs, as the bundles the workspace hooks already return. */
export type WorkspaceScreenSidebarInput = {
  tree: Pick<
    UseWorkspaceTreeStateResult,
    'createMenuOpen' | 'createMenuTriggerPath' | 'expandedPaths' | 'loading' | 'rootPath'
    | 'setWorkspaceItemIcon' | 'toggleFolder' | 'treeMetadata' | 'workspaceDisplayName'
  >
  treeNodes: WorkspaceTreeNode[]
  moveTargets: WorkspaceTreeNode[]
  activePath: string
  modifiedPaths: Set<string>
  createMenuActions: ReturnType<typeof useWorkspaceCreateMenu>
  treeActions: Pick<
    ReturnType<typeof useWorkspaceTreeActions>,
    'dropWorkspaceNode' | 'duplicateDocumentNode' | 'importBrowserFiles' | 'moveWorkspaceNodeToFolder' | 'refreshWorkspaceDocuments'
  >
  rowActions: Pick<ReturnType<typeof useWorkspaceTreeRowActions>, 'handleTreeNodeDelete' | 'handleTreeNodeRename'>
  chat: Pick<ReturnType<typeof useWorkspaceAgentChatEntryPoints>, 'addNodeToChat' | 'addNodeToNewChat'>
  chrome: { privateExpanded: boolean; onTogglePrivate: () => void; onToggleSidebar: () => void }
  /** Desktop-only affordances (reveal in OS, file import and paste) are offered only when true. */
  desktop: boolean
  browserTabEnabled: boolean
  onCreateWorkflowForTable: SidebarPanelProps['onCreateWorkflowForTable']
  onOpen: SidebarPanelProps['onOpen']
  onOpenSearch?: () => void
  /** Called after a manual refresh succeeds. */
  onRefreshed: () => void
}

export function buildWorkspaceSidebarPanelProps(input: WorkspaceScreenSidebarInput): SidebarPanelProps {
  const { tree, treeActions, rowActions, chat, chrome, desktop } = input
  return {
    activePath: input.activePath,
    createMenuOpen: tree.createMenuOpen,
    createMenuTriggerPath: tree.createMenuTriggerPath,
    loading: tree.loading,
    modifiedPaths: input.modifiedPaths,
    ...input.createMenuActions,
    onDelete: rowActions.handleTreeNodeDelete,
    onDuplicate: (node) => void treeActions.duplicateDocumentNode(node),
    onMoveToFolder: (node, targetNode) => void treeActions.moveWorkspaceNodeToFolder(node, targetNode),
    onAddToChat: (node) => void chat.addNodeToChat(node),
    onAddToNewChat: (node) => void chat.addNodeToNewChat(node),
    onCreateWorkflowForTable: input.onCreateWorkflowForTable,
    onRevealInOS: desktop ? (node) => void revealWorkspaceFolder(node.path) : undefined,
    onOpen: input.onOpen,
    showBrowserTab: input.browserTabEnabled,
    onRefresh: () => {
      void treeActions.refreshWorkspaceDocuments(undefined, { silent: true, treeOnly: true })
        .then((ok) => { if (ok) input.onRefreshed() })
    },
    onRename: rowActions.handleTreeNodeRename,
    onSetIcon: tree.setWorkspaceItemIcon,
    onToggleFolder: tree.toggleFolder,
    onTogglePrivate: chrome.onTogglePrivate,
    onToggleSidebar: chrome.onToggleSidebar,
    onTreeDrop: (draggedPath, targetPath, position) => void treeActions.dropWorkspaceNode(draggedPath, targetPath, position),
    onImportFiles: desktop ? (files, folder) => void treeActions.importBrowserFiles(files, folder) : undefined,
    onPasteFiles: desktop ? (entries) => void treeActions.importBrowserFiles(entries) : undefined,
    privateExpanded: chrome.privateExpanded,
    rootPath: tree.rootPath,
    treeExpandedPaths: tree.expandedPaths,
    treeIcons: tree.treeMetadata.icons,
    moveTargets: input.moveTargets,
    workspaceDisplayName: tree.workspaceDisplayName,
    workspaceTreeNodes: input.treeNodes,
    onOpenSearch: input.onOpenSearch,
  }
}

export function WorkspaceScreenSidebar(input: WorkspaceScreenSidebarInput) {
  return <WorkspaceSidebarPanel {...buildWorkspaceSidebarPanelProps(input)} />
}

export function WorkspaceScreenSidebarFooter({
  activeItem,
  onOpenProfile,
  onOpenSettings,
  onOpenVaultLauncher,
}: {
  activeItem?: 'profile' | null
  onOpenProfile?: () => void
  onOpenSettings: () => void
  onOpenVaultLauncher?: () => void
}) {
  const { t } = useTranslation('workspace')
  const kitionAccount = useKitionAccount()
  const portalSession = isKitionAccountAuthenticated(kitionAccount.state.status)
    ? kitionAccount.state.session
    : null
  const accountLinks = getKitionAccountLinks(portalSession)
  const creditTotal = portalSession?.credit_total
  const creditBalance = portalSession?.credit_balance
  const showCredits = Number.isFinite(creditTotal) && Number.isFinite(creditBalance)

  return (
    <div className="workspace-sidebar-footer">
      <UpdateBanner />
      <div className="document-agent-nav">
        {onOpenVaultLauncher ? (
          <button
            type="button"
            className="document-agent-settings"
            onClick={onOpenVaultLauncher}
            aria-label={t('footer.switchWorkspace')}
            title={t('footer.switchWorkspaceTitle')}
            data-testid="workspace-launcher-nav-button"
          >
            <FolderOpen className="size-4" />
          </button>
        ) : null}
        {onOpenProfile ? (
          <button
            type="button"
            className={cn('document-agent-settings', activeItem === 'profile' && 'is-active')}
            onClick={onOpenProfile}
            aria-label={t('footer.profile')}
            title={t('footer.profile')}
            data-testid="profile-nav-button"
          >
            <UserRound className="size-4" />
          </button>
        ) : null}
        {showCredits ? (
          <CreditUsageBadge
            className="document-agent-credit"
            creditBalance={creditBalance}
            creditTotal={creditTotal}
            creditResetAt={portalSession?.credit_reset_at}
            topupUrl={accountLinks.topup}
            onViewCredits={onOpenProfile}
            onTopup={() => void openExternalURL(accountLinks.topup)}
            variant="compact"
            data-testid="portal-credit-summary"
          />
        ) : null}
        <button
          type="button"
          className="document-agent-settings"
          onClick={onOpenSettings}
          aria-label={t('footer.settings')}
          title={t('footer.settings')}
        >
          <Settings2 className="size-4" />
        </button>
      </div>
    </div>
  )
}
