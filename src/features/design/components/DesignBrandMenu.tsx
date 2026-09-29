import { ChevronDown, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import {
  applyBrandColor,
  applyBrandFont,
  BRAND_COLOR_ROLES,
  type BrandKitFile,
} from '../lib/designBrand'
import type { DesignStore } from '../lib/designStore'

/** Applies brand kit colors and the brand font to the selection or the artboard. */
export function DesignBrandMenu({
  kit,
  store,
  selection,
}: {
  kit: BrandKitFile | null
  store: DesignStore
  selection: string[]
}) {
  const { t, i18n } = useTranslation('design')
  const roles = BRAND_COLOR_ROLES.filter((role) => kit?.colors[role])
  if (!kit || (!roles.length && !kit.fontFamily)) return null
  const settings = i18n.getFixedT(i18n.language, 'settings')
  const close = (target: EventTarget & HTMLElement) =>
    target.closest('details')?.removeAttribute('open')
  return (
    <details className="design-export">
      <summary aria-label={t('brand')}>
        <Palette className="size-4" />
        <span>{kit.name || t('brand')}</span>
        <ChevronDown className="size-3" />
      </summary>
      <div className="design-export-menu" title={t('brandHint')}>
        {roles.map((role) => (
          <Button
            key={role}
            size="sm"
            variant="ghost"
            onClick={(event) => {
              close(event.currentTarget)
              store.commit(
                applyBrandColor(
                  store.getSnapshot().document,
                  selection,
                  kit.colors[role]!,
                ),
              )
            }}
          >
            <span
              className="design-brand-swatch"
              style={{ background: kit.colors[role] }}
            />
            {settings(`brand.colors.${role}`)}
          </Button>
        ))}
        {kit.fontFamily ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={(event) => {
              close(event.currentTarget)
              store.commit(
                applyBrandFont(
                  store.getSnapshot().document,
                  selection,
                  kit.fontFamily!,
                ),
              )
            }}
          >
            <span
              className="design-brand-swatch design-brand-font"
              style={{ fontFamily: kit.fontFamily }}
            >
              Aa
            </span>
            {t('brandFont')} · {kit.fontFamily}
          </Button>
        ) : null}
      </div>
    </details>
  )
}
