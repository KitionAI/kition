import { useCallback } from 'react'

import { chatWithModel } from '@/api/models'
import {
  buildTranslationMessages,
  cleanTranslationResult,
  TranslationAccountNotReadyError,
  TranslationModelMissingError,
  type DocumentTranslateText,
} from '@/features/document/public'
import type { AgentModelOption } from '@/features/agent/public'

type UseSelectionTranslatorOptions = {
  /** The model currently selected in the Agent panel. */
  model: Pick<AgentModelOption, 'providerKind' | 'runtimeModel'> | null | undefined
  /** Connects or refreshes the hosted account; resolves false when it is not usable. */
  ensureHostedAccountReady?: () => Promise<boolean>
}

/**
 * Binds selection translation to the Agent's selected model: one
 * non-streaming completion per request, cancellable through the signal.
 */
export function useSelectionTranslator({ model, ensureHostedAccountReady }: UseSelectionTranslatorOptions): DocumentTranslateText {
  return useCallback(async (text, target, signal) => {
    const runtimeModel = model?.runtimeModel
    if (!runtimeModel) throw new TranslationModelMissingError()
    if (model.providerKind === 'kition_console' && ensureHostedAccountReady) {
      const ready = await ensureHostedAccountReady()
      if (!ready) throw new TranslationAccountNotReadyError()
    }
    const response = await chatWithModel({
      messages: buildTranslationMessages(text, target),
      runtime_model: runtimeModel,
      scene_type: 'translation',
    }, { signal })
    return cleanTranslationResult(String(response?.content ?? ''), text)
  }, [ensureHostedAccountReady, model])
}
