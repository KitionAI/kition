import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  IMAGE_PROMPT_TEMPLATE_CATEGORIES,
  type ImagePromptTemplateCategoryFilter,
  type ImagePromptTemplateDefinition,
  type ImagePromptTemplateId,
  type ImagePromptTemplateView,
  type ImagePromptVariableKey,
} from '@/features/media-generation/lib/imagePromptTemplates'
import { cn } from '@/lib/utils'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'

import type { WhiteboardImageStudioContext } from './WhiteboardImageStudio'

const TEMPLATE_VIEWS: readonly ImagePromptTemplateView[] = [
  'recommended', 'all', 'generate', 'edit',
]

export function WhiteboardImageTemplateGallery({
  category,
  context,
  onCategoryChange,
  onChoose,
  onQueryChange,
  onViewChange,
  query,
  templateView,
  templates,
}: {
  category: ImagePromptTemplateCategoryFilter
  context: WhiteboardImageStudioContext
  onCategoryChange: (category: ImagePromptTemplateCategoryFilter) => void
  onChoose: (template: ImagePromptTemplateDefinition) => void
  onQueryChange: (query: string) => void
  onViewChange: (view: ImagePromptTemplateView) => void
  query: string
  templateView: ImagePromptTemplateView
  templates: readonly ImagePromptTemplateDefinition[]
}) {
  const { t } = useTranslation('imageGeneration')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="whiteboard-image-template-gallery">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          className="h-10 w-full rounded-lg border bg-surface-soft pl-9 pr-3 text-sm outline-none focus:border-primary focus:bg-background focus:ring-2 focus:ring-primary/15"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('gallery.searchPlaceholder')}
          data-testid="whiteboard-image-template-search"
        />
      </label>
      <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg border bg-surface-soft p-1" role="group" aria-label={t('templateViews.label')}>
        {TEMPLATE_VIEWS.map((view) => (
          <button
            key={view}
            type="button"
            className={cn(
              'min-w-0 rounded-md px-1.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors',
              templateView === view
                ? 'bg-background text-foreground shadow-sm'
                : 'hover:bg-background/70 hover:text-foreground',
            )}
            onClick={() => onViewChange(view)}
            aria-pressed={templateView === view}
            data-testid={`whiteboard-image-template-view-${view}`}
          >
            {t(`templateViews.${view}`)}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" aria-label={t('categories.label')}>
        {IMAGE_PROMPT_TEMPLATE_CATEGORIES.map((item) => (
          <button
            key={item}
            type="button"
            className={cn(
              'shrink-0 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
              category === item
                ? 'border-primary bg-accent text-accent-foreground'
                : 'bg-background text-muted-foreground hover:border-hairline-strong hover:text-foreground',
            )}
            onClick={() => onCategoryChange(item)}
            aria-pressed={category === item}
            data-testid={`whiteboard-image-template-category-${item}`}
          >
            {t(`categories.${item}`)}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground">{t(`gallery.headings.${templateView}`)}</h3>
        <span className="text-[11px] text-muted-foreground">{t('gallery.templateCount', { count: templates.length })}</span>
      </div>
      {templates.length ? (
        <div className="mt-2 grid grid-cols-2 gap-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              needsReference={template.operation === 'edit' && context.sourceImagePaths.length === 0}
              onSelect={() => onChoose(template)}
              template={template}
            />
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-xl border border-dashed bg-surface-soft p-8 text-center text-xs text-muted-foreground">
          {t('gallery.empty')}
        </div>
      )}
    </div>
  )
}

function TemplateCard({
  needsReference,
  onSelect,
  template,
}: {
  needsReference: boolean
  onSelect: () => void
  template: ImagePromptTemplateDefinition
}) {
  const { t } = useTranslation('imageGeneration')
  return (
    <button
      type="button"
      className="group overflow-hidden rounded-xl border bg-background text-left transition hover:border-hairline-strong hover:shadow-[var(--shadow-soft)]"
      onClick={onSelect}
      data-testid={`whiteboard-image-template-${template.id}`}
    >
      <span className="relative block h-40 overflow-hidden bg-surface-soft">
        <img
          className="h-full w-full object-contain p-1 transition duration-200 group-hover:scale-[1.02]"
          src={template.thumbnail}
          alt={t('templatePreviewAlt', { name: t(`templates.${template.id}.name`) })}
        />
        <span className="absolute left-2 top-2 rounded-md border border-background/80 bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-foreground shadow-sm backdrop-blur">
          {t(`templateMeta.${template.operation}`)}
        </span>
        {template.defaultTextMode === 'editable_overlay' ? (
          <span className="absolute right-2 top-2 rounded-md border border-primary/20 bg-accent/95 px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground shadow-sm backdrop-blur">
            {t('templateMeta.editableText')}
          </span>
        ) : null}
        {needsReference ? (
          <span className="absolute bottom-2 left-2 right-2 rounded-md bg-warning-background/95 px-2 py-1 text-[10px] font-medium text-warning-foreground shadow-sm backdrop-blur">
            {t('templateMeta.selectImageFirst')}
          </span>
        ) : null}
      </span>
      <span className="block p-3">
        <strong className="block text-xs font-semibold text-foreground">{t(`templates.${template.id}.name`)}</strong>
        <span className="mt-1 line-clamp-2 block min-h-8 text-[11px] leading-4 text-muted-foreground">
          {t(`templates.${template.id}.description`)}
        </span>
        <span className="mt-2 flex items-center justify-between gap-2 text-[10px] font-medium">
          <span className="text-muted-foreground">{template.defaultAspectRatio}</span>
          <span className="text-brand">{t('actions.useTemplate')} →</span>
        </span>
      </span>
    </button>
  )
}

export function WhiteboardImageSelectedTemplate({
  context,
  template,
}: {
  context: WhiteboardImageStudioContext
  template: ImagePromptTemplateDefinition
}) {
  const { t } = useTranslation('imageGeneration')
  return (
    <section className="overflow-hidden rounded-xl border bg-background">
      <div className="grid grid-cols-[152px_1fr]">
        <img
          className="h-full min-h-40 w-full bg-surface-soft object-contain p-1"
          src={template.thumbnail}
          alt={t('templatePreviewAlt', { name: t(`templates.${template.id}.name`) })}
        />
        <div className="p-3">
          <div className="flex flex-wrap gap-1">
            <span className="rounded-md border bg-surface-soft px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t(`templateMeta.${template.operation}`)}
            </span>
            <span className="rounded-md border bg-surface-soft px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {template.defaultAspectRatio}
            </span>
            {template.defaultTextMode === 'editable_overlay' ? (
              <span className="rounded-md border border-primary/20 bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
                {t('templateMeta.editableText')}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(`templates.${template.id}.description`)}</p>
          {context.sourceImagePaths.length ? (
            <div className="mt-2 flex items-center gap-1.5">
              {context.sourceImagePaths.slice(0, 3).map((path, index) => (
                <img
                  key={path}
                  className="size-9 rounded-md border bg-surface-soft object-cover"
                  src={resolveWorkspaceFileURL(path)}
                  alt={t('referenceAlt', { index: index + 1 })}
                />
              ))}
              <span className="text-[10px] text-muted-foreground">
                {t('generator.referenceCount', { count: context.sourceImagePaths.length })}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function WhiteboardImageVariableField({
  multiline,
  onChange,
  required,
  templateId,
  value,
  variableKey,
}: {
  multiline?: boolean
  onChange: (value: string) => void
  required?: boolean
  templateId: ImagePromptTemplateId
  value: string
  variableKey: ImagePromptVariableKey
}) {
  const { t } = useTranslation('imageGeneration')
  const className = 'mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15'
  const placeholder = t(`templates.${templateId}.placeholders.${variableKey}`, {
    defaultValue: t(`variables.${variableKey}.placeholder`),
  })
  return (
    <label className="block text-xs font-medium text-foreground">
      {t(`variables.${variableKey}.label`)}
      {required ? <span className="ml-1 text-destructive">*</span> : null}
      {multiline ? (
        <textarea
          className={cn(className, 'min-h-20 resize-y')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-testid={`whiteboard-image-variable-${variableKey}`}
        />
      ) : (
        <input
          className={cn(className, 'h-10')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-testid={`whiteboard-image-variable-${variableKey}`}
        />
      )}
    </label>
  )
}
