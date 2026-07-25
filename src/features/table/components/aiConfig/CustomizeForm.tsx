import { useTranslation } from 'react-i18next'
import type { TextAIConfig } from '@/types/aiConfig'

type CustomizeConfig = Extract<TextAIConfig, { type: 'customize' }>

export function CustomizeForm({
  value,
  onChange,
}: {
  value: CustomizeConfig
  onChange: (next: CustomizeConfig) => void
}) {
  const { t } = useTranslation('table')
  return (
    <div className="data-inline-ai-config-form">
      <label>
        <span>{t('aiConfig.promptSupports')} <code>{'{{column_name}}'}</code>{t('aiConfig.promptSupportsSuffix')}</span>
        <textarea
          aria-label={t('aiConfig.prompt')}
          rows={5}
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
