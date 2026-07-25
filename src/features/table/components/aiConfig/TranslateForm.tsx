import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import type { TextAIConfig } from '@/types/aiConfig'
import { SourceFieldPicker } from './sourceFieldPicker'

type TranslateConfig = Extract<TextAIConfig, { type: 'translate' }>

const LANGUAGES = [
  { code: 'zh', labelKey: 'aiConfig.languages.zh' },
  { code: 'en', labelKey: 'aiConfig.languages.en' },
  { code: 'ja', labelKey: 'aiConfig.languages.ja' },
  { code: 'ko', labelKey: 'aiConfig.languages.ko' },
  { code: 'es', labelKey: 'aiConfig.languages.es' },
  { code: 'fr', labelKey: 'aiConfig.languages.fr' },
  { code: 'de', labelKey: 'aiConfig.languages.de' },
]

export function TranslateForm({
  fields,
  currentFieldId,
  value,
  onChange,
}: {
  fields: DataField[]
  currentFieldId: number
  value: TranslateConfig
  onChange: (next: TranslateConfig) => void
}) {
  const { t } = useTranslation('table')
  return (
    <div className="data-inline-ai-config-form">
      <label>
        <span>{t('aiConfig.sourceField')}</span>
        <SourceFieldPicker
          fields={fields}
          currentFieldId={currentFieldId}
          value={value.source_field_id}
          onChange={(id) => onChange({ ...value, source_field_id: id })}
        />
      </label>
      <label>
        <span>{t('aiConfig.targetLanguage')}</span>
        <select
          aria-label={t('aiConfig.targetLanguage')}
          value={value.target_language}
          onChange={(event) => onChange({ ...value, target_language: event.target.value })}
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>{t(language.labelKey)}</option>
          ))}
        </select>
      </label>
      <label className="data-inline-ai-config-checkbox">
        <input
          type="checkbox"
          checked={value.auto_update}
          onChange={(event) => onChange({ ...value, auto_update: event.target.checked })}
        />
        <span>{t('aiConfig.autoRegenerateSource')}</span>
      </label>
    </div>
  )
}
