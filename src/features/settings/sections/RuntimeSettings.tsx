import { useEffect, useState } from 'react'
import { getDesktopInfo, openRuntimePath, type DesktopInfo } from '@/services/desktop'
import { Button } from '@/components/ui'
import { SettingsPaneHeader, SettingsSection, SettingsRow } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { FolderOpen } from 'lucide-react'

export function RuntimeSettings() {
  const { t } = useTranslation('settings')
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    getDesktopInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info)
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false)
        }
      })

    return () => {
      mounted = false
    }
  }, [])

  const runtimeRows: Array<{ label: string; kind: 'data' | 'cache' | 'logs' | 'exports'; path: string }> = [
    { label: t('runtime.dataDir'), kind: 'data', path: desktopInfo?.data_dir || '' },
    { label: t('runtime.cacheDir'), kind: 'cache', path: desktopInfo?.cache_dir || '' },
    { label: t('runtime.logsDir'), kind: 'logs', path: desktopInfo?.logs_dir || '' },
    { label: t('runtime.exportsDir'), kind: 'exports', path: desktopInfo?.exports_dir || '' },
  ]

  async function handleOpen(kind: 'data' | 'cache' | 'logs' | 'exports') {
    await openRuntimePath(kind)
  }

  if (loading) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('runtime.paneTitle')} description={t('runtime.paneDescription')} />
        <div className="settings-pane-loading">{t('runtime.loading')}</div>
      </div>
    )
  }

  if (!desktopInfo) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('runtime.paneTitle')} description={t('runtime.paneDescription')} />
        <div className="settings-pane-empty">{t('runtime.empty')}</div>
      </div>
    )
  }

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('runtime.paneTitle')} description={t('runtime.paneDescription')} />
      <SettingsSection title={t('runtime.section')}>
        {runtimeRows.map((row) => (
          <SettingsRow
            key={row.kind}
            title={row.label}
            description={row.path || t('runtime.desktopOnly')}
          >
            <Button variant="outline" size="sm" onClick={() => void handleOpen(row.kind)}>
              <FolderOpen className="size-4" />
              {t('common.open')}
            </Button>
          </SettingsRow>
        ))}
      </SettingsSection>
    </div>
  )
}
