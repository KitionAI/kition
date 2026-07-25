import { useTranslation } from 'react-i18next'
import type { TextAIConfig } from '@/types/aiConfig'

type TextGenConfig = Extract<TextAIConfig, { type: 'text_generation' }>

export function TextGenerationForm({
  value,
  onChange,
}: {
  value: TextGenConfig
  onChange: (next: TextGenConfig) => void
}) {
  const { t } = useTranslation('table')
  return (
    <div className="data-inline-ai-config-form">
      <label>
        <span>{t('aiConfig.promptSupports')} <code>{'{{column_name}}'}</code>{t('aiConfig.promptSupportsSuffix')}</span>
        <textarea
          aria-label={t('aiConfig.prompt')}
          rows={4}
          value={value.prompt}
          onChange={(event) => onChange({ ...value, prompt: event.target.value })}
        />
      </label>
      <label className="data-inline-ai-config-checkbox">
        <input
          type="checkbox"
          checked={value.auto_update}
          onChange={(event) => onChange({ ...value, auto_update: event.target.checked })}
        />
        <span>{t('aiConfig.autoRegenerateColumns')}</span>
      </label>
    </div>
  )
}
