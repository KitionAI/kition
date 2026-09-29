import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { queryKeys } from '@/api/queryKeys'
import {
  fillDesignTemplate,
  loadDesignTemplatePackage,
  type DesignTemplate,
} from '../lib/designTemplates'
import { DesignArtwork } from './DesignArtwork'
import type { DesignDocument } from '../lib/designTypes'
export function DesignLibrary({
  onApply,
}: {
  onApply: (document: DesignDocument) => void
}) {
  const { t } = useTranslation('design')
  const templates = useQuery({
    queryKey: queryKeys.designTemplates(),
    queryFn: () => loadDesignTemplatePackage(),
    staleTime: Infinity,
  })
  // Localized copy fills the slots; the template keeps its English defaults.
  const build = (template: DesignTemplate) =>
    fillDesignTemplate(template, {
      slots: {
        headline: t(`starters.${template.id}.heading`, { defaultValue: '' }),
        body: t(`starters.${template.id}.body`, { defaultValue: '' }),
        label: t(`starters.${template.id}.label`, { defaultValue: '' }),
      },
    })
  return (
    <div className="design-library">
      <p className="design-panel-heading">{t('layouts')}</p>
      <p className="design-help">
        {templates.isError ? t('layoutsError') : t('layoutsHint')}
      </p>
      <div className="design-starters">
        {templates.data?.templates.map(({ resource, template }) => {
          const preview = build(template)
          return (
            <button
              type="button"
              key={template.id}
              className="design-starter"
              onClick={() => onApply(build(template))}
            >
              <svg
                viewBox={`0 0 ${template.width} ${template.height}`}
                aria-hidden="true"
              >
                <DesignArtwork
                  document={preview}
                  images={{}}
                  prefix={`starter-${template.id}`}
                />
              </svg>
              <span>
                {t(`starters.${template.id}.name`, {
                  defaultValue: resource.title,
                })}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
