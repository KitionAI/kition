import {
  ArrowLeft,
  Ban,
  Check,
  Image as ImageIcon,
  ImagePlus,
  LoaderCircle,
  SlidersHorizontal,
  TextCursorInput,
  WandSparkles,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  buildImagePrompt,
  filterImagePromptTemplates,
  getImagePromptTemplate,
  getMissingRequiredImagePromptVariables,
  getRecommendedImagePromptTemplateIds,
  type ImagePromptAspectRatio,
  type ImagePromptTemplateCategoryFilter,
  type ImagePromptTemplateDefinition,
  type ImagePromptTemplateId,
  type ImagePromptTemplateView,
  type ImagePromptTextMode,
  type ImagePromptVariableValues,
} from '@/features/media-generation/lib/imagePromptTemplates'
import { cn } from '@/lib/utils'
import { openExternalURL } from '@/services/desktop'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'

import type {
  WhiteboardImageGenerationRequest,
  WhiteboardImageGenerationStartResult,
} from '../lib/whiteboardImageGeneration'
import {
  WhiteboardImageSelectedTemplate,
  WhiteboardImageTemplateGallery,
  WhiteboardImageVariableField,
} from './WhiteboardImageTemplateGallery'

export type WhiteboardImageStudioContext = {
  replaceElementId?: string
  selectionText: string
  sourceImagePaths: string[]
}

export type WhiteboardImageStudioGenerationState = {
  error?: string
  paths: string[]
  requestId?: string
  status: 'idle' | 'submitting' | 'generating' | 'ready' | 'error'
}

const ASPECT_RATIOS: readonly ImagePromptAspectRatio[] = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2',
]
const RESOLUTIONS = ['1K', '2K', '4K'] as const
const QUALITIES = ['low', 'medium', 'high'] as const
const TEXT_MODES: readonly ImagePromptTextMode[] = [
  'editable_overlay', 'baked_text', 'no_text',
]
const EMPTY_VARIABLES: ImagePromptVariableValues = {
  subject: '',
  scene: '',
  details: '',
  palette: '',
}

type StudioScreen = 'gallery' | 'generator'
type ResultPlacementState = { added?: boolean; replaced?: boolean }

export function WhiteboardImageStudio({
  available,
  boardPath,
  context,
  generation,
  onAddAll,
  onAddResult,
  onClose,
  onGenerate,
  onReplaceResult,
  open,
}: {
  available: boolean
  boardPath: string
  context: WhiteboardImageStudioContext
  generation: WhiteboardImageStudioGenerationState
  onAddAll: (paths: string[], options: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }) => void
  onAddResult: (path: string, options: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }) => void
  onClose: () => void
  onGenerate: (request: WhiteboardImageGenerationRequest) => Promise<WhiteboardImageGenerationStartResult>
  onReplaceResult: (path: string, options: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }) => void
  open: boolean
}) {
  const { t } = useTranslation('imageGeneration')
  const suggestedTemplateId: ImagePromptTemplateId = context.sourceImagePaths.length
    ? 'mixed-media-memory-card'
    : context.selectionText ? 'engineering-infographic' : 'surreal-city-poster'
  const initialTemplate = getImagePromptTemplate(suggestedTemplateId)
  const [screen, setScreen] = useState<StudioScreen>('gallery')
  const [templateId, setTemplateId] = useState<ImagePromptTemplateId>(suggestedTemplateId)
  const [templateView, setTemplateView] = useState<ImagePromptTemplateView>('recommended')
  const [category, setCategory] = useState<ImagePromptTemplateCategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [variables, setVariables] = useState<ImagePromptVariableValues>(() => (
    initialVariables(initialTemplate, context.selectionText)
  ))
  const [exactText, setExactText] = useState('')
  const [aspectRatio, setAspectRatio] = useState<ImagePromptAspectRatio>(initialTemplate.defaultAspectRatio)
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>('1K')
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>('medium')
  const [variants, setVariants] = useState(1)
  const [textMode, setTextMode] = useState<ImagePromptTextMode>(initialTemplate.defaultTextMode)
  const [localError, setLocalError] = useState('')
  const [placementByPath, setPlacementByPath] = useState<Record<string, ResultPlacementState>>({})

  useEffect(() => {
    if (!open) return
    const nextTemplate = getImagePromptTemplate(suggestedTemplateId)
    setScreen('gallery')
    setTemplateId(nextTemplate.id)
    setTemplateView('recommended')
    setCategory('all')
    setQuery('')
    setVariables(initialVariables(nextTemplate, context.selectionText))
    setAspectRatio(nextTemplate.defaultAspectRatio)
    setTextMode(nextTemplate.defaultTextMode)
    setExactText('')
    setLocalError('')
    setPlacementByPath({})
  }, [context.replaceElementId, context.selectionText, context.sourceImagePaths, open, suggestedTemplateId])

  const selectedTemplate = useMemo(
    () => getImagePromptTemplate(templateId),
    [templateId],
  )
  const recommendedTemplateIds = useMemo(() => getRecommendedImagePromptTemplateIds({
    hasReferenceImage: context.sourceImagePaths.length > 0,
    hasSelectionText: Boolean(context.selectionText.trim()),
  }), [context.selectionText, context.sourceImagePaths.length])
  const visibleTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return filterImagePromptTemplates({
      category,
      recommendedIds: recommendedTemplateIds,
      view: templateView,
    }).filter((template) => {
      if (!normalizedQuery) return true
      return [
        t(`templates.${template.id}.name`),
        t(`templates.${template.id}.description`),
        ...template.styles,
        ...template.scenes,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    })
  }, [category, query, recommendedTemplateIds, t, templateView])
  const requiresReference = selectedTemplate.operation === 'edit'
  const missingVariables = getMissingRequiredImagePromptVariables(selectedTemplate, variables)
  const busy = generation.status === 'submitting' || generation.status === 'generating'
  const canGenerate = available
    && !busy
    && missingVariables.length === 0
    && (!requiresReference || context.sourceImagePaths.length > 0)

  if (!open) return null

  function chooseTemplate(template: ImagePromptTemplateDefinition) {
    setTemplateId(template.id)
    setVariables(initialVariables(template, context.selectionText))
    setAspectRatio(template.defaultAspectRatio)
    setTextMode(template.defaultTextMode)
    setExactText('')
    setLocalError('')
    setScreen('generator')
  }

  async function submit() {
    setLocalError('')
    const missing = getMissingRequiredImagePromptVariables(selectedTemplate, variables)[0]
    if (missing) {
      setLocalError(t('errors.variableRequired', { field: t(`variables.${missing}.label`) }))
      return
    }
    if (requiresReference && context.sourceImagePaths.length === 0) {
      setLocalError(t('errors.referenceRequired'))
      return
    }
    setPlacementByPath({})
    try {
      const requestId = createImageGenerationRequestId()
      const result = await onGenerate({
        aspectRatio,
        boardPath,
        exactText: textMode === 'no_text' ? undefined : exactText.trim() || undefined,
        prompt: buildImagePrompt({
          aspectRatio,
          exactText,
          quality,
          resolution,
          selectionText: context.selectionText,
          templateId,
          textMode,
          variables,
        }),
        quality,
        replaceElementId: context.replaceElementId,
        requestId,
        resolution,
        sourceImagePaths: context.sourceImagePaths,
        templateId,
        textMode,
        variants,
      })
      if (!result.accepted) setLocalError(result.error || t('errors.startFailed'))
    } catch {
      setLocalError(t('errors.startFailed'))
    }
  }

  const placementOptions = { aspectRatio, exactText, textMode }
  function markPlacement(path: string, placement: keyof ResultPlacementState) {
    setPlacementByPath((current) => ({
      ...current,
      [path]: { ...current[path], [placement]: true },
    }))
  }

  return (
    <aside
      className="absolute bottom-3 right-3 top-3 z-[60] flex w-[520px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-xl border bg-background shadow-[var(--shadow-floating)]"
      aria-label={t('title')}
      data-testid="whiteboard-image-studio"
    >
      <header className="flex min-h-[68px] items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <WandSparkles className="size-4 text-brand" />
            {screen === 'gallery' ? t('title') : t(`templates.${templateId}.name`)}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {screen === 'gallery' ? t('gallery.description') : t('generator.description')}
          </p>
        </div>
        <button
          type="button"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
          aria-label={t('close')}
          data-testid="whiteboard-image-studio-close"
        >
          <X className="size-4" />
        </button>
      </header>

      {screen === 'gallery' ? (
        <WhiteboardImageTemplateGallery
          category={category}
          context={context}
          onCategoryChange={setCategory}
          onChoose={chooseTemplate}
          onQueryChange={setQuery}
          onViewChange={setTemplateView}
          query={query}
          templateView={templateView}
          templates={visibleTemplates}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 p-4">
            <button
              type="button"
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setScreen('gallery')}
              data-testid="whiteboard-image-back-to-templates"
            >
              <ArrowLeft className="size-3.5" />
              {t('actions.backToTemplates')}
            </button>

            <WhiteboardImageSelectedTemplate
              context={context}
              template={selectedTemplate}
            />

            {requiresReference && context.sourceImagePaths.length === 0 ? (
              <div className="rounded-lg border border-warning-border bg-warning-background p-3 text-xs leading-5 text-warning-foreground" role="alert">
                {t('generator.referenceRequired')}
              </div>
            ) : null}

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{t('sections.customize')}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('generator.customizeHint')}</p>
              </div>
              {selectedTemplate.variables.map((variable) => (
                <WhiteboardImageVariableField
                  key={variable.key}
                  multiline={variable.multiline}
                  required={variable.required}
                  templateId={templateId}
                  variableKey={variable.key}
                  value={variables[variable.key]}
                  onChange={(value) => setVariables((current) => ({
                    ...current,
                    [variable.key]: value,
                  }))}
                />
              ))}
              {textMode !== 'no_text' ? (
                <label className="block text-xs font-medium text-foreground">
                  {t(`fields.${textMode === 'editable_overlay' ? 'editableText' : 'visibleText'}`)}
                  <textarea
                    className="mt-1.5 min-h-16 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                    value={exactText}
                    onChange={(event) => setExactText(event.target.value)}
                    placeholder={t(`fields.${textMode === 'editable_overlay' ? 'editableTextPlaceholder' : 'visibleTextPlaceholder'}`)}
                    data-testid="whiteboard-image-exact-text"
                  />
                  {textMode === 'editable_overlay' ? (
                    <span className="mt-1.5 flex items-start gap-1.5 text-[11px] font-normal leading-4 text-accent-foreground">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-brand" />
                      {t('fields.editableTextDescription')}
                    </span>
                  ) : null}
                </label>
              ) : null}
            </section>

            <details className="group rounded-xl border bg-surface-soft" data-testid="whiteboard-image-advanced-settings">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-semibold text-foreground">
                <span className="flex items-center gap-2">
                  <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                  {t('sections.advanced')}
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">{aspectRatio} · {resolution} · {t(`quality.${quality}`)}</span>
              </summary>
              <div className="space-y-4 border-t p-3">
                <div>
                  <div className="text-xs font-medium text-foreground">{t('fields.textMode')}</div>
                  <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                    {TEXT_MODES.map((mode) => {
                      const Icon = TEXT_MODE_ICONS[mode]
                      return (
                        <button
                          key={mode}
                          type="button"
                          className={cn(
                            'min-h-16 rounded-lg border p-2 text-left transition-colors',
                            textMode === mode
                              ? 'border-primary bg-accent text-accent-foreground'
                              : 'bg-background text-muted-foreground hover:border-hairline-strong',
                          )}
                          onClick={() => setTextMode(mode)}
                          aria-pressed={textMode === mode}
                          data-testid={`whiteboard-image-text-mode-${mode}`}
                        >
                          <Icon className="size-3.5" />
                          <strong className="mt-1.5 block text-[11px] font-semibold">
                            {t(`textModes.${mode}.name`)}
                          </strong>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <SelectField label={t('fields.aspectRatio')} value={aspectRatio} onChange={(value) => setAspectRatio(value as ImagePromptAspectRatio)} options={ASPECT_RATIOS} />
                  <SelectField label={t('fields.resolution')} value={resolution} onChange={(value) => setResolution(value as (typeof RESOLUTIONS)[number])} options={RESOLUTIONS} />
                  <SelectField label={t('fields.quality')} value={quality} onChange={(value) => setQuality(value as (typeof QUALITIES)[number])} options={QUALITIES} translateOption={(value) => t(`quality.${value}`)} />
                  <label className="text-xs font-medium text-foreground">
                    {t('fields.variants')}
                    <select
                      className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={variants}
                      onChange={(event) => setVariants(Number(event.target.value))}
                    >
                      {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                </div>
              </div>
            </details>

            {busy ? (
              <GenerationProgress
                status={generation.status === 'submitting' ? 'submitting' : 'generating'}
                variants={variants}
              />
            ) : null}

            {generation.paths.length ? (
              <GenerationResults
                context={context}
                paths={generation.paths}
                placementByPath={placementByPath}
                placementOptions={placementOptions}
                onAddAll={onAddAll}
                onAddResult={onAddResult}
                onMarkPlacement={markPlacement}
                onReplaceResult={onReplaceResult}
                onSetPlacementByPath={setPlacementByPath}
              />
            ) : null}

            <p className="text-[11px] leading-4 text-muted-foreground">
              {t('source', {
                license: selectedTemplate.source.license,
                repository: selectedTemplate.source.repository,
              })}{' '}
              <button
                type="button"
                className="font-medium text-brand underline-offset-2 hover:underline"
                onClick={() => void openExternalURL(selectedTemplate.source.url)}
              >
                {t('actions.viewSource')}
              </button>
            </p>
          </div>
        </div>
      )}

      {screen === 'generator' ? (
        <footer className="border-t bg-background p-3">
          {(localError || generation.error) ? (
            <p className="mb-2 text-xs text-destructive" role="alert">{localError || generation.error}</p>
          ) : null}
          {!available ? <p className="mb-2 text-xs text-muted-foreground">{t('errors.unavailable')}</p> : null}
          <button
            type="button"
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
            disabled={!canGenerate}
            onClick={() => void submit()}
            data-testid="whiteboard-image-generate"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
            {busy ? t('actions.generating') : t('actions.generate', { count: variants })}
          </button>
        </footer>
      ) : null}
    </aside>
  )
}

function GenerationProgress({
  status,
  variants,
}: {
  status: 'submitting' | 'generating'
  variants: number
}) {
  const { t } = useTranslation('imageGeneration')
  return (
    <section className="rounded-xl border border-primary/20 bg-accent/55 p-3" role="status" aria-live="polite" data-testid="whiteboard-image-generation-progress">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-brand shadow-sm">
          <LoaderCircle className="size-4 animate-spin" />
        </span>
        <div>
          <div className="text-xs font-semibold text-foreground">{t(`status.${status}`)}</div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{t('status.detail', { count: variants })}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden="true">
        {Array.from({ length: variants }, (_, index) => (
          <span key={index} className="aspect-square animate-pulse rounded-md border bg-background/75" />
        ))}
      </div>
    </section>
  )
}

function GenerationResults({
  context,
  onAddAll,
  onAddResult,
  onMarkPlacement,
  onReplaceResult,
  onSetPlacementByPath,
  paths,
  placementByPath,
  placementOptions,
}: {
  context: WhiteboardImageStudioContext
  onAddAll: (paths: string[], options: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }) => void
  onAddResult: (path: string, options: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }) => void
  onMarkPlacement: (path: string, placement: keyof ResultPlacementState) => void
  onReplaceResult: (path: string, options: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }) => void
  onSetPlacementByPath: Dispatch<SetStateAction<Record<string, ResultPlacementState>>>
  paths: string[]
  placementByPath: Record<string, ResultPlacementState>
  placementOptions: { aspectRatio: ImagePromptAspectRatio; exactText: string; textMode: ImagePromptTextMode }
}) {
  const { t } = useTranslation('imageGeneration')
  return (
    <section aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ImagePlus className="size-4 text-brand" />
          {t('sections.results')}
        </h3>
        {paths.length > 1 ? (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-accent"
            onClick={() => {
              onAddAll(paths, placementOptions)
              onSetPlacementByPath((current) => Object.fromEntries(
                paths.map((path) => [path, { ...current[path], added: true }]),
              ))
            }}
            data-testid="whiteboard-image-add-all"
          >
            {paths.every((path) => placementByPath[path]?.added) ? t('actions.addedAll') : t('actions.addAll')}
          </button>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {paths.map((path, index) => (
          <article key={path} className="overflow-hidden rounded-lg border bg-background">
            <div className="aspect-square bg-surface-soft">
              <img className="h-full w-full object-contain" src={resolveWorkspaceFileURL(path)} alt={t('resultAlt', { index: index + 1 })} />
            </div>
            <div className="grid grid-cols-2 gap-1 p-2">
              <button
                type="button"
                className="flex h-8 items-center justify-center gap-1 rounded-md border text-xs font-medium hover:bg-muted disabled:bg-muted disabled:text-muted-foreground"
                disabled={placementByPath[path]?.added}
                onClick={() => {
                  onAddResult(path, placementOptions)
                  onMarkPlacement(path, 'added')
                }}
                data-testid={`whiteboard-image-add-${index}`}
              >
                {placementByPath[path]?.added ? <Check className="size-3.5" /> : null}
                {placementByPath[path]?.added ? t('actions.added') : t('actions.add')}
              </button>
              <button
                type="button"
                className="flex h-8 items-center justify-center gap-1 rounded-md bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
                disabled={!context.replaceElementId || placementByPath[path]?.replaced}
                onClick={() => {
                  onReplaceResult(path, placementOptions)
                  onMarkPlacement(path, 'replaced')
                }}
                data-testid={`whiteboard-image-replace-${index}`}
              >
                {placementByPath[path]?.replaced ? <Check className="size-3.5" /> : null}
                {placementByPath[path]?.replaced ? t('actions.replaced') : t('actions.replace')}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function SelectField({
  label,
  onChange,
  options,
  translateOption,
  value,
}: {
  label: string
  onChange: (value: string) => void
  options: readonly string[]
  translateOption?: (value: string) => string
  value: string
}) {
  return (
    <label className="text-xs font-medium text-foreground">
      {label}
      <select
        className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => <option key={option} value={option}>{translateOption?.(option) || option}</option>)}
      </select>
    </label>
  )
}

const TEXT_MODE_ICONS: Record<ImagePromptTextMode, ComponentType<{ className?: string }>> = {
  editable_overlay: TextCursorInput,
  baked_text: ImageIcon,
  no_text: Ban,
}

function initialVariables(
  template: ImagePromptTemplateDefinition,
  selectionText: string,
): ImagePromptVariableValues {
  const values = { ...EMPTY_VARIABLES }
  if (template.variables.some((variable) => variable.key === 'subject')) {
    values.subject = selectionText.trim().slice(0, 280)
  } else if (selectionText.trim()) {
    values.details = selectionText.trim().slice(0, 800)
  }
  return values
}

function createImageGenerationRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
