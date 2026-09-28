import { useEffect, useMemo, useState } from 'react'
import { EmailProvidersPane } from '@/features/emailProviders/public'
import { AiModelsPane } from '@/features/settings/AiModelsPane'
import { NetworkSettings } from '@/features/settings/NetworkSettings'
import { SettingsSidebarHeader } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { cn } from '@/lib/utils'
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react'
import { settingsSections, type SettingsSectionKey, type SettingsSectionDefinition, primarySettingsSections, advancedSettingsSections } from '@/features/settings/sections/sectionRegistry'
import { buildSettingsSearchIndex, filterSettingsSections } from '@/features/settings/sections/settingsSearch'
import { AboutSettings } from '@/features/settings/sections/AboutSettings'
import { AccountSettings } from '@/features/settings/sections/AccountSettings'
import { DeveloperSettings } from '@/features/settings/sections/DeveloperSettings'
import { DisplaySettings } from '@/features/settings/sections/DisplaySettings'
import { GeneralSettings } from '@/features/settings/sections/GeneralSettings'
import { RuntimeSettings } from '@/features/settings/sections/RuntimeSettings'

export type { SettingsSectionKey } from '@/features/settings/sections/sectionRegistry'

type DesktopSettingsPageProps = {
  initialSection?: SettingsSectionKey
  onClose?: () => void
}

export function DesktopSettingsPage({ initialSection, onClose }: DesktopSettingsPageProps = {}) {
  const { t, i18n } = useTranslation('settings')
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(() => initialSection || 'general')
  const [search, setSearch] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(() => (
    advancedSettingsSections.some((section) => section.key === initialSection)
  ))
  const searchIndex = useMemo(() => buildSettingsSearchIndex(t, i18n), [t, i18n, i18n.language])
  const query = search.trim().toLowerCase()
  const visible = filterSettingsSections(query, searchIndex, t('sections.advanced.label'))
  const showAdvancedGroup = visible.advanced.length > 0
  const showAdvancedChildren = showAdvancedGroup && (advancedOpen || Boolean(query) || (
    advancedSettingsSections.some((section) => section.key === activeSection)
  ))
  const hasVisibleSections = visible.main.length > 0 || visible.about !== undefined || visible.advanced.length > 0

  useEffect(() => {
    if (!settingsSections.some((section) => section.key === activeSection)) {
      setActiveSection('general')
    }
  }, [activeSection])

  useEffect(() => {
    if (!initialSection) {
      return
    }
    setActiveSection((current) => (current === initialSection ? current : initialSection))
  }, [initialSection])

  useEffect(() => {
    if (advancedSettingsSections.some((section) => section.key === activeSection)) {
      setAdvancedOpen(true)
    }
  }, [activeSection])

  function switchSection(section: SettingsSectionKey) {
    setActiveSection(section)
    if (typeof window !== 'undefined' && window.location.pathname === '/settings') {
      const nextURL = `${window.location.pathname}?section=${section}`
      window.history.replaceState(window.history.state, '', nextURL)
    }
  }

  function renderSectionButton(section: SettingsSectionDefinition, child = false) {
    const SectionIcon = section.icon
    const active = activeSection === section.key
    return (
      <button
        key={section.key}
        type="button"
        className={cn('settings-nav-button', child && 'is-child', active && 'is-active')}
        onClick={(event) => {
          event.stopPropagation()
          switchSection(section.key)
        }}
        aria-current={active ? 'page' : undefined}
      >
        <SectionIcon className="size-4" />
        <strong>{t(`sections.${section.key}.label`)}</strong>
      </button>
    )
  }

  useEffect(() => {
    if (!onClose) {
      return
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function handleRequestClose() {
    onClose?.()
  }

  return (
    <div className="settings-modal-stage" onClick={handleRequestClose}>
      <section
        className="settings-modal-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="settings-modal-close"
          onClick={handleRequestClose}
          aria-label={t('actions.close')}
          title={t('actions.close')}
        >
          <X className="size-4" />
        </button>
        <div className="settings-shell">
          <aside className="settings-sidebar-panel">
            <h1 id="settings-title" className="sr-only">{t('sidebar.title')}</h1>
            <SettingsSidebarHeader search={search} onSearchChange={setSearch} />
            <nav className="settings-nav-list" aria-label={t('sidebar.categoriesLabel')}>
              {!hasVisibleSections ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">{t('sidebar.noMatches')}</p>
              ) : (
                <>
                  {visible.main.map((section) => renderSectionButton(section))}
                  {showAdvancedGroup ? (
                    <div className="settings-nav-advanced">
                    <button
                        type="button"
                        className="settings-nav-button settings-nav-disclosure"
                        aria-expanded={showAdvancedChildren}
                        onClick={() => setAdvancedOpen((current) => !current)}
                    >
                        <SlidersHorizontal className="size-4" />
                        <strong>{t('sections.advanced.label')}</strong>
                        <ChevronDown className={cn('settings-nav-chevron size-4', showAdvancedChildren && 'rotate-180')} />
                    </button>
                      {showAdvancedChildren ? (
                        <div className="settings-nav-children">
                          {visible.advanced.map((section) => renderSectionButton(section, true))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {visible.about ? renderSectionButton(visible.about) : null}
                </>
              )}
            </nav>
          </aside>

          <div className="settings-modal-content">
            {activeSection === 'general' ? <GeneralSettings /> : null}
            {activeSection === 'account' ? <AccountSettings /> : null}
            {activeSection === 'models' ? <AiModelsPane /> : null}
            {activeSection === 'connections' ? <EmailProvidersPane /> : null}
            {activeSection === 'display' ? <DisplaySettings /> : null}
            {activeSection === 'network' ? <NetworkSettings /> : null}
            {activeSection === 'runtime' ? <RuntimeSettings /> : null}
            {activeSection === 'developer' ? <DeveloperSettings /> : null}
            {activeSection === 'about' ? <AboutSettings /> : null}
          </div>
        </div>
      </section>
    </div>
  )
}
