import { applyDesktopAppearance } from '@/services/desktopSettings'
import type { DesktopSettingsState } from '@/types/desktopSettings'

export function preserveLiveThemePreview(settings: DesktopSettingsState): DesktopSettingsState {
  if (typeof document === 'undefined') {
    return settings
  }

  // Prefer the canonical dataset (set by applyDesktopAppearance). If that's
  // unset or stale, fall back to the actually-applied .dark class so the
  // segmented Theme control stays in sync with whatever is rendered — even if
  // the dark class was toggled by an external script (system theme handler,
  // playwright, etc.).
  const datasetTheme = document.documentElement.dataset.desktopThemeMode
  if (datasetTheme === 'light' || datasetTheme === 'dark' || datasetTheme === 'auto') {
    return {
      ...settings,
      general: {
        ...settings.general,
        theme: datasetTheme as DesktopSettingsState['general']['theme'],
      },
    }
  }

  const hasDarkClass = document.documentElement.classList.contains('dark')
  const resolved: DesktopSettingsState['general']['theme'] = hasDarkClass ? 'dark' : 'light'
  if (settings.general.theme === resolved) {
    return settings
  }
  return {
    ...settings,
    general: {
      ...settings.general,
      theme: resolved,
    },
  }
}
