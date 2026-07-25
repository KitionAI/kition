import { FolderOpen, Settings2, UserRound } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

import { CreditUsageBadge } from '@/components/CreditUsageBadge'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { getKitionAccountLinks } from '@/features/account/lib/accountLinks'
import { isKitionAccountAuthenticated } from '@/features/account/lib/accountState'
import { cn } from '@/lib/utils'
import { openExternalURL } from '@/services/desktop'

import { WorkspaceSidebarPanel } from './WorkspaceSidebarPanel'

type WorkspaceScreenSidebarProps = {
  sidebarPanelProps: ComponentProps<typeof WorkspaceSidebarPanel>
}

export function WorkspaceScreenSidebar({
  sidebarPanelProps,
}: WorkspaceScreenSidebarProps) {
  return <WorkspaceSidebarPanel {...sidebarPanelProps} />
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
  )
}
