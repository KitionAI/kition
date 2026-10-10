import { useTranslation } from 'react-i18next'

import { useNativeSurfaceShowing } from '@/lib/nativeSurfaces'

import { AgentLauncherIcon } from './AgentLauncherIcon'

export function AgentFloatingLauncher({
  visible,
  onOpen,
}: {
  visible: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('workspace')
  // A native editor window would cover the launcher; its tab offers the Agent instead.
  const covered = useNativeSurfaceShowing()

  if (!visible || covered) {
    return null
  }

  return (
    <button
      type="button"
      className="agent-floating-launcher"
      onClick={onOpen}
      title={t('agentTabs.openChat')}
      aria-label={t('agentTabs.openChat')}
      data-testid="agent-floating-launcher"
    >
      <AgentLauncherIcon />
    </button>
  )
}
