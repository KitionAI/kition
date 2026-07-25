import { useEffect, useState, type ReactNode } from 'react'
import { Check, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n'

type SettingsPaneHeaderProps = {
  title: string
  description?: string
}

export function SettingsPaneHeader({ title, description }: SettingsPaneHeaderProps) {
  return (
    <header className="settings-pane-header">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </header>
  )
}

type SettingsSectionProps = {
  title?: string
  description?: string
  children?: ReactNode
  className?: string
}

export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('settings-section', className)}>
      {title ? (
        <div className="settings-section-head">
          <strong>{title}</strong>
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}
      <div className="settings-section-rows">{children}</div>
    </section>
  )
}

type SettingsRowProps = {
  title: string
  description?: string
  children?: ReactNode
  className?: string
}

export function SettingsRow({ title, description, children, className }: SettingsRowProps) {
  return (
    <div className={cn('settings-row', className)}>
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      {children ? <div className="settings-row-control">{children}</div> : null}
    </div>
  )
}

type SettingsSidebarHeaderProps = {
  search: string
  onSearchChange: (value: string) => void
}

export function SettingsSidebarHeader({ search, onSearchChange }: SettingsSidebarHeaderProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="settings-sidebar-header">
      <span className="settings-sidebar-title">{t('sidebar.title')}</span>
      <div className="settings-sidebar-search">
        <Search className="size-4" aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t('sidebar.searchPlaceholder')}
          aria-label={t('sidebar.searchPlaceholder')}
        />
      </div>
    </div>
  )
}

type SettingsActionBarProps = {
  dirty: boolean
  onSave: () => void
  onCancel: () => void
  saveLabel?: string
  destructive?: ReactNode
  saving?: boolean
     
                                              
                                                  
                                               
     
  lastSavedAt?: number | null
}

const SAVED_HINT_MS = 2200

export function SettingsActionBar({
  dirty, onSave, onCancel, saveLabel, destructive, saving, lastSavedAt,
}: SettingsActionBarProps) {
  const { t } = useTranslation('settings')
  const [showSaved, setShowSaved] = useState(false)

  useEffect(() => {
    if (!lastSavedAt) return
    setShowSaved(true)
    const id = window.setTimeout(() => setShowSaved(false), SAVED_HINT_MS)
    return () => window.clearTimeout(id)
  }, [lastSavedAt])

  if (!dirty && !destructive && !showSaved) {
    return null
  }
  if (!dirty) {
    return (
      <div className="settings-action-bar" role="region" aria-label={t('actions.regionLabel')}>
        <div className="settings-action-bar-left">
          {destructive}
          {showSaved ? (
            <span
              className="settings-action-bar-saved"
              data-testid="settings-action-bar-saved"
              aria-live="polite"
            >
              <Check className="size-3.5" aria-hidden="true" />
              {t('actions.savedJustNow')}
            </span>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div className="settings-action-bar" role="region" aria-label={t('actions.regionLabel')}>
      <div className="settings-action-bar-left">
        {destructive}
        <span className="settings-action-bar-status">{t('actions.unsavedChanges')}</span>
      </div>
      <div className="settings-action-bar-right">
        <Button variant="outline" onClick={onCancel} disabled={saving}>{t('actions.cancel')}</Button>
        <Button onClick={onSave} disabled={saving}>{saving ? t('actions.saving') : (saveLabel ?? t('actions.save'))}</Button>
      </div>
    </div>
  )
}
