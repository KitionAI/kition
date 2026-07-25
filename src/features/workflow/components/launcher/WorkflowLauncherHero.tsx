import { ArrowLeft, ArrowUp, LoaderCircle, Plus, Sparkles, Table } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TriggerTableSelect, type TriggerTableOption } from '@/features/workflow/components/TriggerTableSelect'

export type LauncherView = 'gallery' | 'ai-prompt'

export interface WorkflowLauncherHeroProps {
  view: LauncherView
  tableName: string
  prompt: string
  submitting: boolean
  errorMessage: string | null
  onPromptChange: (next: string) => void
  onSwitchToAiPrompt: () => void
  onSwitchToGallery: () => void
  onAiSubmit: () => void
  onStartFromScratch: () => void
  /** Optional table picker for the AI prompt page. Provided when the
   *  launcher mounted without a pre-bound table (top-level "Chat with
   *  AI" entry from the Workflows tab) so the user can pick the trigger
   *  table inline before submitting. When omitted (kitable-scoped
   *  launcher mount where the table is fixed), the readonly tableName
   *  display is rendered instead.
   *
   *  When `options` is empty AND `emptyState` is provided, the picker
   *  collapses to a "no tables yet — create one" CTA card so the user
   *  has a way forward in fresh workspaces instead of seeing a
   *  permanently-disabled Start button. */
  tablePicker?: {
    options: TriggerTableOption[]
    pickedTableId: string
    onPick: (nextTableId: string) => void
    emptyState?: {
      onCreate: () => void
      busy: boolean
    }
  }
}

export function WorkflowLauncherHero(props: WorkflowLauncherHeroProps) {
  if (props.view === 'gallery') return <GalleryHero {...props} />
  return <AiPromptHero {...props} />
}

function GalleryHero(props: WorkflowLauncherHeroProps) {
  const { submitting, errorMessage, onSwitchToAiPrompt, onStartFromScratch } = props
  const { t } = useTranslation('workflow')
  return (
    <div className="max-w-[640px]">
      <h1 className="text-2xl font-bold text-foreground">{t('launcher.hero.galleryTitle')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t('launcher.hero.gallerySubtitle')}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="workflow-launcher-cta-ai"
          onClick={onSwitchToAiPrompt}
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
        >
          <Sparkles className="size-4" />
          {t('launcher.hero.ctaGenerateAi')}
        </button>
        <button
          type="button"
          data-testid="workflow-launcher-cta-scratch"
          onClick={onStartFromScratch}
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
        >
          {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {t('launcher.hero.ctaStartFromScratch')}
        </button>
      </div>
      {errorMessage ? (
        <div data-testid="workflow-model-error" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}

function AiPromptHero(props: WorkflowLauncherHeroProps) {
  const {
    tableName, prompt, submitting, errorMessage, tablePicker,
    onPromptChange, onSwitchToGallery, onAiSubmit,
  } = props
  const { t } = useTranslation('workflow')

  // The build endpoint rejects an unbound submit (`tableId required`),
  // and we already render the picker when no table is preselected, so
  // gate Submit on a chosen tableId too. Without this the picker
  // implies "pick first", but submitting anyway would surface a raw
  // 400 from the backend.
  const hasTable = tablePicker ? Boolean(tablePicker.pickedTableId) : Boolean(tableName)
  const canSubmit = prompt.trim().length > 0 && hasTable && !submitting

  return (
    <div className="max-w-[640px]">
      <button
        type="button"
        data-testid="workflow-launcher-ai-back"
        onClick={onSwitchToGallery}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> {t('launcher.hero.aiPromptBack')}
      </button>
      <h1 className="mt-3 text-xl font-semibold text-foreground">{t('launcher.hero.aiPromptTitle')}</h1>
      <label className="mt-3 block text-xs text-muted-foreground">{t('launcher.hero.aiPromptTableLabel')}</label>
      {tablePicker ? (
        tablePicker.options.length === 0 && tablePicker.emptyState ? (
          <div
            data-testid="workflow-table-picker-empty"
            className="mt-1 flex items-start gap-3 rounded-lg border border-dashed border-primary/30 bg-muted/40 px-3 py-3 text-sm"
          >
            <Table className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-medium text-foreground">
                {t('launcher.hero.aiPromptTableEmptyTitle')}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t('launcher.hero.aiPromptTableEmptyBody')}
              </p>
              <button
                type="button"
                data-testid="workflow-table-picker-empty-cta"
                onClick={tablePicker.emptyState.onCreate}
                disabled={tablePicker.emptyState.busy || submitting}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-card px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {tablePicker.emptyState.busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                {t('launcher.hero.aiPromptTableEmptyCta')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1">
            <TriggerTableSelect
              value={tablePicker.pickedTableId}
              options={tablePicker.options}
              onChange={tablePicker.onPick}
              disabled={submitting}
              draftLabel={t('launcher.hero.aiPromptTablePickerPlaceholder')}
              testId="workflow-table-picker"
            />
            {!tablePicker.pickedTableId ? (
              <p className="mt-1 text-[11px] text-muted-foreground" data-testid="workflow-table-picker-hint">
                {t('launcher.hero.aiPromptTablePickerHint')}
              </p>
            ) : null}
          </div>
        )
      ) : (
        <input
          data-testid="workflow-table-name"
          readOnly
          value={tableName}
          className="mt-1 w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
        />
      )}
      <label className="mt-3 block text-xs text-muted-foreground">{t('launcher.hero.aiPromptLabel')}</label>
      <textarea
        data-testid="workflow-prompt"
        rows={5}
        value={prompt}
        placeholder={t('launcher.hero.aiPromptPlaceholder')}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
            e.preventDefault()
            onAiSubmit()
          }
        }}
        className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
      <button
        type="button"
        data-testid="workflow-launcher-ai-submit"
        onClick={onAiSubmit}
        disabled={!canSubmit}
        className="mt-4 inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted"
      >
        {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        {t('launcher.hero.aiPromptSubmit')}
      </button>
      {/* Preserve old test-id alias so legacy e2e tests still pass */}
      <button type="button" data-testid="workflow-start-btn" hidden onClick={() => { if (canSubmit) onAiSubmit() }} />
      {errorMessage ? (
        <div data-testid="workflow-model-error" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}
