import { Check, ImagePlus, LoaderCircle } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'

import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'

import type { ImageStudioContext, ImageStudioPlacementOptions } from '../lib/imageStudioTypes'

export type ResultPlacementState = { added?: boolean; replaced?: boolean }

export function GenerationProgress({
  status,
  testIdPrefix,
  variants,
}: {
  status: 'submitting' | 'generating'
  testIdPrefix: string
  variants: number
}) {
  const { t } = useTranslation('imageGeneration')
  return (
    <section className="rounded-xl border border-primary/20 bg-accent/55 p-3" role="status" aria-live="polite" data-testid={`${testIdPrefix}-generation-progress`}>
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

export function GenerationResults({
  context,
  onAddAll,
  onAddResult,
  onMarkPlacement,
  onReplaceResult,
  onSetPlacementByPath,
  paths,
  placementByPath,
  placementOptions,
  testIdPrefix,
}: {
  context: ImageStudioContext
  onAddAll: (paths: string[], options: ImageStudioPlacementOptions) => void
  onAddResult: (path: string, options: ImageStudioPlacementOptions) => void
  onMarkPlacement: (path: string, placement: keyof ResultPlacementState) => void
  onReplaceResult: (path: string, options: ImageStudioPlacementOptions) => void
  onSetPlacementByPath: Dispatch<SetStateAction<Record<string, ResultPlacementState>>>
  paths: string[]
  placementByPath: Record<string, ResultPlacementState>
  placementOptions: ImageStudioPlacementOptions
  testIdPrefix: string
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
            data-testid={`${testIdPrefix}-add-all`}
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
                data-testid={`${testIdPrefix}-add-${index}`}
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
                data-testid={`${testIdPrefix}-replace-${index}`}
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

export function SelectField({
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

