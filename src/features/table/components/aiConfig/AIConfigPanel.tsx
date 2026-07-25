import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import type { AnyAIConfig, AttachmentAIConfig, TextAIConfig } from '@/types/aiConfig'
import { ImageGenerationForm } from './ImageGenerationForm'
import { ImageCustomizationForm } from './ImageCustomizationForm'
import { TextGenerationForm } from './TextGenerationForm'
import { SummarizeForm } from './SummarizeForm'
import { ExtractForm } from './ExtractForm'
import { TranslateForm } from './TranslateForm'
import { ClassifyForm } from './ClassifyForm'
import { CustomizeForm } from './CustomizeForm'
import { ModelPicker } from './modelPicker'

const ATTACHMENT_ACTIONS = [
  { value: 'image_generation', labelKey: 'aiConfig.actions.imageGeneration' },
  { value: 'image_customization', labelKey: 'aiConfig.actions.imageCustomization' },
] as const

const TEXT_ACTIONS = [
  { value: 'text_generation', labelKey: 'aiConfig.actions.textGeneration' },
  { value: 'summarize', labelKey: 'aiConfig.actions.summarize' },
  { value: 'extract', labelKey: 'aiConfig.actions.extract' },
  { value: 'translate', labelKey: 'aiConfig.actions.translate' },
  { value: 'classify', labelKey: 'aiConfig.actions.classify' },
  { value: 'customize', labelKey: 'aiConfig.actions.customize' },
] as const

function isAttachmentField(field: DataField) {
  return field.type === 'attachment'
}
function isTextField(field: DataField) {
  return field.type === 'text' || field.type === 'long_text'
}

function defaultConfigFor(actionType: string, fields: DataField[], currentFieldId: number): AnyAIConfig | null {
  const firstOther = fields.find((field) => field.id !== currentFieldId)
  const firstOtherId = firstOther?.id ?? 1
  switch (actionType) {
    case 'image_generation':
      return { type: 'image_generation', enabled: true, auto_update: false, source_field_id: firstOtherId, n: 1, quality: 'medium', aspect_ratio: '1:1', resolution: '1K', image_use_case: 'inline_illustration' }
    case 'image_customization':
      return { type: 'image_customization', enabled: true, auto_update: false, prompt: '', n: 1, quality: 'medium', aspect_ratio: '1:1', resolution: '1K', image_use_case: 'inline_illustration' }
    case 'text_generation':
      return { type: 'text_generation', enabled: true, auto_update: false, prompt: '' }
    case 'summarize':
      return { type: 'summarize', enabled: true, auto_update: false, source_field_id: firstOtherId }
    case 'extract':
      return { type: 'extract', enabled: true, auto_update: false, source_field_id: firstOtherId }
    case 'translate':
      return { type: 'translate', enabled: true, auto_update: false, source_field_id: firstOtherId, target_language: 'en' }
    case 'classify':
      return { type: 'classify', enabled: true, auto_update: false, source_field_id: firstOtherId, categories: ['Category A', 'Category B'] }
    case 'customize':
      return { type: 'customize', enabled: true, auto_update: false, prompt: '' }
    default:
      return null
  }
}

export function AIConfigPanel({
  field,
  fields,
  value,
  onChange,
  chrome = 'standalone',
}: {
  field: DataField
  fields: DataField[]
  value: AnyAIConfig | undefined
  onChange: (next: AnyAIConfig | undefined) => void
  chrome?: 'standalone' | 'embedded'
}) {
  const { t } = useTranslation('table')
  const isAttachment = isAttachmentField(field)
  const isText = isTextField(field)
  if (!isAttachment && !isText) return null

  const actions = isAttachment ? ATTACHMENT_ACTIONS : TEXT_ACTIONS
  const enabled = !!value?.enabled

  // For text actions, if the picked source field is an attachment we expect
  // image content — the AI field pipeline will pass images through as
  // input_image content parts in the runtime contract, which only
  // works when the runtime model can actually read images. So we filter the
  // model picker to vision-capable models and surface a hint so the user
  // doesn't pick a text-only model and quietly get empty extractions.
  const sourceFieldId = value && 'source_field_id' in value ? (value as { source_field_id?: number }).source_field_id : undefined
  const sourceField = typeof sourceFieldId === 'number' ? fields.find((item) => item.id === sourceFieldId) : undefined
  const isTextActionWithAttachmentSource = !!value
    && (value.type === 'summarize' || value.type === 'extract' || value.type === 'translate' || value.type === 'classify')
    && sourceField?.type === 'attachment'
  const modelCapability: 'image' | 'vision' | 'text' = value?.type === 'image_generation' || value?.type === 'image_customization'
    ? 'image'
    : isTextActionWithAttachmentSource
      ? 'vision'
      : 'text'

  const body = enabled && value ? (
    <div className="data-inline-ai-config-fields">
      <label>
        <span>{t('aiConfig.action')}</span>
        <select
          aria-label={t('aiConfig.action')}
          value={value.type}
          onChange={(event) => {
            const next = defaultConfigFor(event.target.value, fields, field.id)
            if (next) onChange(next)
          }}
        >
          {actions.map((action) => (
            <option key={action.value} value={action.value}>{t(action.labelKey)}</option>
          ))}
        </select>
      </label>

      {value.type === 'image_generation' && (
        <ImageGenerationForm
          fields={fields}
          currentFieldId={field.id}
          value={value}
          onChange={onChange as (v: AttachmentAIConfig) => void}
        />
      )}
      {value.type === 'image_customization' && (
        <ImageCustomizationForm
          fields={fields}
          currentFieldId={field.id}
          value={value}
          onChange={onChange as (v: AttachmentAIConfig) => void}
        />
      )}
      {value.type === 'text_generation' && (
        <TextGenerationForm value={value} onChange={onChange as (v: TextAIConfig) => void} />
      )}
      {value.type === 'summarize' && (
        <SummarizeForm
          fields={fields}
          currentFieldId={field.id}
          value={value}
          onChange={onChange as (v: TextAIConfig) => void}
        />
      )}
      {value.type === 'extract' && (
        <ExtractForm
          fields={fields}
          currentFieldId={field.id}
          value={value}
          onChange={onChange as (v: TextAIConfig) => void}
        />
      )}
      {value.type === 'translate' && (
        <TranslateForm
          fields={fields}
          currentFieldId={field.id}
          value={value}
          onChange={onChange as (v: TextAIConfig) => void}
        />
      )}
      {value.type === 'classify' && (
        <ClassifyForm
          fields={fields}
          currentFieldId={field.id}
          value={value}
          onChange={onChange as (v: TextAIConfig) => void}
        />
      )}
      {value.type === 'customize' && (
        <CustomizeForm value={value} onChange={onChange as (v: TextAIConfig) => void} />
      )}

      <label>
        <span>{t('aiConfig.runtimeModelOverride')}</span>
        <ModelPicker
          value={value.runtime_model}
          capability={modelCapability}
          onChange={(model) => onChange({ ...value, runtime_model: model })}
        />
      </label>
      {isTextActionWithAttachmentSource && (
        <p className="data-inline-ai-config-hint" role="note">
          {t('aiConfig.visionModelHint')}
        </p>
      )}
    </div>
  ) : null

  if (chrome === 'embedded') {
    if (!enabled) {
      return (
        <div className="data-inline-ai-config-fields">
          <label>
            <span>{t('aiConfig.action')}</span>
            <select
              aria-label={t('aiConfig.action')}
              value=""
              onChange={(event) => {
                const next = defaultConfigFor(event.target.value, fields, field.id)
                if (next) onChange(next)
              }}
            >
              <option value="" disabled>
                {t('aiConfig.chooseAction')}
              </option>
              {actions.map((action) => (
                <option key={action.value} value={action.value}>{t(action.labelKey)}</option>
              ))}
            </select>
          </label>
        </div>
      )
    }
    return body
  }

  return (
    <div className="data-inline-ai-config-panel">
      <header className="data-inline-ai-config-panel-head">
        <strong>{t('aiConfig.title')}</strong>
        <label className="data-inline-ai-config-checkbox">
          <input
            aria-label={t('aiConfig.enable')}
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              if (event.target.checked) {
                const next = defaultConfigFor(actions[0].value, fields, field.id)
                if (next) onChange(next)
              } else if (value) {
                onChange({ ...value, enabled: false })
              }
            }}
          />
          <span>{t('aiConfig.enable')}</span>
        </label>
      </header>
      {body}
    </div>
  )
}
