import { useEffect, useRef } from 'react'

import { applyDesktopAppearance, loadDesktopSettings, subscribeDesktopSettingsUpdated } from '@/services/desktopSettings'
import {
  dispatchOnQuit,
  dispatchSessionStarted,
  ensureNotificationPolicyLoaded,
} from '@/services/desktopNotifications'
import { setAutoCheckUpdates, setBetaChannel } from '@/services/desktopUpdates'
import { getDesktopInfo, isDesktopRuntime } from '@/services/desktop'
import type { DesktopSettingsState } from '@/types/desktopSettings'
import { setCurrentLocale } from '@/i18n'
import {
  configureProductAnalytics,
  trackProductEvent,
} from '@/features/analytics/lib/productAnalytics'

import { AppShell } from './Shell'

let appStartedTracked = false

function syncProductAnalytics(settings: DesktopSettingsState, platform: unknown) {
  configureProductAnalytics({
    enabled: settings.general.shareUsageData === true,
    appVersion: __APP_VERSION__,
    buildIdentity: __APP_BUILD_IDENTITY__,
    platform,
    endpoint: __APP_ANALYTICS_ENDPOINT__,
  })
  if (!appStartedTracked && trackProductEvent('app_started')) {
    appStartedTracked = true
  }
}

export function App() {
  const persistedThemeRef = useRef<DesktopSettingsState['general']['theme'] | null>(null)
  const analyticsPlatformRef = useRef<unknown>('web')

  useEffect(() => {
    let mounted = true

    Promise.all([
      loadDesktopSettings(),
      getDesktopInfo().catch(() => null),
    ]).then(([settings, desktopInfo]) => {
      if (mounted) {
        analyticsPlatformRef.current = desktopInfo?.platform || 'web'
        persistedThemeRef.current = settings.general.theme
        applyDesktopAppearance(settings.general.theme)
        setCurrentLocale(settings.general.language)
        void setBetaChannel(settings.general.updateBetaChannel === true)
        void setAutoCheckUpdates(settings.general.autoCheckUpdates !== false)
        syncProductAnalytics(settings, analyticsPlatformRef.current)
      }
    })

    const desktopRuntime = isDesktopRuntime()
    const handleBeforeUnload = () => dispatchOnQuit()
    if (desktopRuntime) {
      void ensureNotificationPolicyLoaded()
        .then(() => dispatchSessionStarted())
        .catch(() => undefined)
      window.addEventListener('beforeunload', handleBeforeUnload)
    }

    const unsubscribe = subscribeDesktopSettingsUpdated((settings) => {
      const nextTheme = settings.general.theme

      // Unrelated settings saves should not clobber an unsaved live theme preview.
      if (persistedThemeRef.current !== nextTheme) {
        persistedThemeRef.current = nextTheme
        applyDesktopAppearance(nextTheme)
      } else {
        persistedThemeRef.current = nextTheme
      }

      setCurrentLocale(settings.general.language)
      syncProductAnalytics(settings, analyticsPlatformRef.current)
    })

    return () => {
      mounted = false
      if (desktopRuntime) {
        window.removeEventListener('beforeunload', handleBeforeUnload)
      }
      unsubscribe()
    }
  }, [])

  return <AppShell />
}
