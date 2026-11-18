import { useEffect, useState } from 'react'
import {
  createDefaultDesktopSettings,
  loadDesktopSettings,
  subscribeDesktopSettingsUpdated,
} from '@/services/desktopSettings'
import type { DesktopSettingsState } from '@/types/desktopSettings'

export function useDesktopSettings() {
  const [settings, setSettings] = useState<DesktopSettingsState>(createDefaultDesktopSettings())

  useEffect(() => {
    let mounted = true

    loadDesktopSettings().then((value) => {
      if (mounted) {
        setSettings(value)
      }
    })

    const unsubscribe = subscribeDesktopSettingsUpdated((value) => {
      if (mounted) {
        setSettings(value)
      }
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return {
    settings,
    setSettings,
  }
}
