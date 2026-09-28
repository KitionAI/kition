/**
 * Selection translation as the document editor consumes it: the translator
 * bound to the Agent's selected model, the saved default language, and
 * the way to change it.
 */
import { useMemo } from 'react'

import type { AgentModelOption } from '@/features/agent/public'
import type { DocumentTranslationSupport } from '@/features/document/public'
import { useSelectionTranslator } from '@/features/workspace/hooks/useSelectionTranslator'
import { saveDesktopSettings } from '@/services/desktopSettings'
import type { DesktopSettingsState } from '@/types/desktopSettings'

type UseWorkspaceDocumentTranslationOptions = {
  model: AgentModelOption | null | undefined
  ensureHostedAccountReady: () => Promise<boolean>
  settings: DesktopSettingsState
  setSettings: (settings: DesktopSettingsState) => void
  onOpenModelSettings?: () => void
}

export function useWorkspaceDocumentTranslation({
  model,
  ensureHostedAccountReady,
  settings,
  setSettings,
  onOpenModelSettings,
}: UseWorkspaceDocumentTranslationOptions): DocumentTranslationSupport {
  const translateText = useSelectionTranslator({ model, ensureHostedAccountReady })
  return useMemo(() => ({
    translateText,
    preference: settings.general.translationTargetLanguage,
    onChangePreference: (target) => {
      void saveDesktopSettings({
        ...settings,
        general: { ...settings.general, translationTargetLanguage: target },
      }).then(setSettings)
    },
    onConfigureModel: onOpenModelSettings,
  }), [onOpenModelSettings, setSettings, settings, translateText])
}
