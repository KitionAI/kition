import { useTranslation } from 'react-i18next'

import { AgentLauncherIcon } from './AgentLauncherIcon'

export function AgentFloatingLauncher({
  visible,
  onOpen,
}: {
  visible: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('workspace')

  if (!visible) {
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
