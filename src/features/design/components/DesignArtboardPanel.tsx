import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignDocument } from '../lib/designTypes'
import type { DesignStore } from '../lib/designStore'
import { designVariantList } from '../lib/designVariants'
import { DesignColorField, DesignNumberField } from './DesignFields'

const SIZE_PRESETS = [
  { key: 'poster', width: 1080, height: 1440 },
  { key: 'square', width: 1080, height: 1080 },
  { key: 'story', width: 1080, height: 1920 },
  { key: 'landscape', width: 1920, height: 1080 },
] as const

/** Artboard size, background, and size variants, shown when nothing is selected. */
export function DesignArtboardPanel({
  document: doc,
  store,
  variantId,
}: {
  document: DesignDocument
  store: DesignStore
  variantId: string | null
}) {
  const { t } = useTranslation('design')
  const page = doc.pages[0]
  return (
      <div className="design-properties">
        <p className="design-panel-heading">{t('artboard')}</p>
        <label className="design-field">
          <span>{t('variant')}</span>
          <select
            aria-label={t('variant')}
            value={variantId ?? ''}
            onChange={(event) => store.setVariant(event.target.value || null)}
          >
            {designVariantList(doc).map((entry) => (
              <option key={entry.id ?? 'primary'} value={entry.id ?? ''}>
                {entry.id ? entry.name : t('primaryVariant')} · {entry.width} ×{' '}
                {entry.height}
              </option>
            ))}
          </select>
        </label>
        <div className="design-field-grid">
          <label className="design-field">
            <span>{t('addVariant')}</span>
            <select
              aria-label={t('addVariant')}
              value=""
              onChange={(event) => {
                const preset = SIZE_PRESETS.find(
                  (entry) => entry.key === event.target.value,
                )
                if (preset)
                  store.addVariant({
                    name: t(`sizes.${preset.key}`).split(' ·')[0],
                    width: preset.width,
                    height: preset.height,
                  })
              }}
            >
              <option value="">{t('chooseSize')}</option>
              {SIZE_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {t(`sizes.${preset.key}`)}
                </option>
              ))}
            </select>
          </label>
          {variantId ? (
            <Button
              variant="ghost"
              size="sm"
              className="design-variant-remove"
              onClick={() => store.removeVariant(variantId)}
            >
              {t('removeVariant')}
            </Button>
          ) : null}
        </div>
        <label className="design-field">
          <span>{t('size')}</span>
          <select
            aria-label={t('size')}
            value={
              SIZE_PRESETS.some(
                (preset) =>
                  preset.width === page.width && preset.height === page.height,
              )
                ? `${page.width}x${page.height}`
                : ''
            }
            onChange={(event) => {
              const [width, height] = event.target.value.split('x').map(Number)
              if (width && height)
                store.execute({ type: 'page', patch: { width, height } })
            }}
          >
            <option value="">{t('custom')}</option>
            {SIZE_PRESETS.map((preset) => (
              <option key={preset.key} value={`${preset.width}x${preset.height}`}>
                {t(`sizes.${preset.key}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="design-field-grid">
          <DesignNumberField
            label={t('width')}
            value={page.width}
            min={1}
            onChange={(width) =>
              store.execute({ type: 'page', patch: { width } })
            }
          />
          <DesignNumberField
            label={t('height')}
            value={page.height}
            min={1}
            onChange={(height) =>
              store.execute({ type: 'page', patch: { height } })
            }
          />
        </div>
        <DesignColorField
          label={t('background')}
          value={page.background}
          onChange={(background) =>
            store.execute({ type: 'page', patch: { background } })
          }
        />
        <label className="design-check">
          <input
            type="checkbox"
            checked={page.background === 'transparent'}
            onChange={(event) =>
              store.execute({
                type: 'page',
                patch: {
                  background: event.target.checked ? 'transparent' : '#ffffff',
                },
              })
            }
          />
          {t('transparent')}
        </label>
        <p className="design-help">{t('artboardHint')}</p>
      </div>
  )
}
