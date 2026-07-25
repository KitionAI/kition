import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelCapability } from '@/types'
import { loadMediaModelOptions, type MediaModelOption } from '@/services/mediaModels'

type ModelPickerProps = {
  value: string | undefined
  capability: ModelCapability
  onChange: (modelKey: string | undefined) => void
}

                                                                                       
                                                                  
                         
export function ModelPicker({ value, capability, onChange }: ModelPickerProps) {
  const { t } = useTranslation('table')
  const [options, setOptions] = useState<MediaModelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadMediaModelOptions(capability)
      .then((items) => {
        if (cancelled) return
        setOptions(items.filter((item) => item.source === 'desktop'))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('aiConfig.model.loadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [capability, t])

  const knownValue = value && options.some((option) => option.value === value)

  return (
    <select
      aria-label={t('aiConfig.runtimeModelOverride')}
      className="data-inline-ai-model-picker"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || undefined)}
      disabled={loading}
    >
      <option value="">
        {loading
          ? t('aiConfig.model.loading')
          : error
            ? t('aiConfig.model.defaultWithError', { error })
            : options.length
              ? t('aiConfig.model.default')
              : t('aiConfig.model.defaultNoDesktop')}
      </option>
      {value && !knownValue && !loading ? (
        <option value={value}>{t('aiConfig.model.unavailable', { model: value })}</option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
