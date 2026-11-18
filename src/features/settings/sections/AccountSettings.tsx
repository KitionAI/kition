import { KitionAccountPanel } from '@/features/account/public'
import { SettingsPaneHeader } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'

export function AccountSettings() {
  const { t } = useTranslation('settings')
  return (
    <div className="settings-pane settings-account-pane">
      <SettingsPaneHeader title={t('sections.account.label')} />
      <KitionAccountPanel />
    </div>
  )
}
