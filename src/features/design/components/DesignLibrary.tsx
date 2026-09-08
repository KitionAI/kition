import { useTranslation } from 'react-i18next'
import {
  createDesignStarter,
  designStarters,
  type DesignStarter,
} from '../lib/designStarters'
import { DesignArtwork } from './DesignArtwork'
import type { DesignDocument } from '../lib/designTypes'
export function DesignLibrary({
  onApply,
}: {
  onApply: (document: DesignDocument) => void
}) {
  const { t } = useTranslation('design')
  const build = (kind: DesignStarter) =>
    createDesignStarter(kind, {
      heading: t(`starters.${kind}.heading`),
      body: t(`starters.${kind}.body`),
      label: t(`starters.${kind}.label`),
    })
  return (
    <div className="design-library">
      <p className="design-panel-heading">{t('layouts')}</p>
      <p className="design-help">{t('layoutsHint')}</p>
      <div className="design-starters">
        {designStarters.map((kind) => (
          <button
            type="button"
            key={kind}
            className="design-starter"
            onClick={() => onApply(build(kind))}
          >
            <svg viewBox="0 0 1080 1440" aria-hidden="true">
              <DesignArtwork
                document={build(kind)}
                images={{}}
                prefix={`starter-${kind}`}
              />
            </svg>
            <span>{t(`starters.${kind}.name`)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
