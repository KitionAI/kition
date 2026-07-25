import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, Plus, Sparkles } from 'lucide-react'
import { getBuiltinTemplates, type WorkflowTemplate } from '@/features/workflow/templates'
import { WorkflowLauncherDecor } from './WorkflowLauncherDecor'
import { WorkflowLauncherTemplateGrid } from './WorkflowLauncherTemplateGrid'
import { WorkflowLauncherTemplateSheet } from './WorkflowLauncherTemplateSheet'

export type HomeLauncherActionKind = 'ai' | 'scratch' | 'template' | 'agent'

export interface WorkflowHomeLauncherProps {
  onGenerateWithAi: () => void
  onStartFromScratch: () => void
  onTemplateSelect: (template: WorkflowTemplate) => void
  onAgentClick: () => void
  busyAction?: HomeLauncherActionKind | null
  busyTemplateId?: string
  errorMessage?: string | null
  scopeLabel?: string
}

export function WorkflowHomeLauncher(props: WorkflowHomeLauncherProps) {
  const {
    onGenerateWithAi, onStartFromScratch, onTemplateSelect, onAgentClick,
    busyAction, busyTemplateId, errorMessage, scopeLabel,
  } = props
  const [sheetOpen, setSheetOpen] = useState(false)
  const { t } = useTranslation('workflow')
  const templates = getBuiltinTemplates(t)
  const disabled = Boolean(busyAction)
  const heroTitle = scopeLabel
    ? t('launcher.home.heroTitleWithScope', { scope: scopeLabel })
    : t('launcher.home.heroTitleDefault')
  const heroSubtitle = scopeLabel
    ? t('launcher.home.heroSubtitleWithScope', { scope: scopeLabel })
    : t('launcher.home.heroSubtitleDefault')

  return (
    <div data-testid="workflow-home-launcher" data-scope-label={scopeLabel || ''} className="min-h-full bg-background px-8 py-12 lg:px-16">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-[640px]">
          <h1 className="text-2xl font-bold text-foreground">{heroTitle}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{heroSubtitle}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="workflow-home-launcher-cta-ai"
              onClick={onGenerateWithAi}
              disabled={disabled}
              className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
            >
              {busyAction === 'ai' ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {t('launcher.hero.ctaGenerateAi')}
            </button>
            <button
              type="button"
              data-testid="workflow-home-launcher-cta-scratch"
              onClick={onStartFromScratch}
              disabled={disabled}
              className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
            >
              {busyAction === 'scratch' ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t('launcher.hero.ctaStartFromScratch')}
            </button>
          </div>
          {errorMessage ? (
            <div data-testid="workflow-home-launcher-error" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorMessage}
            </div>
          ) : null}
        </div>
        <WorkflowLauncherDecor />
      </div>

      <div className="mx-auto max-w-[1080px]">
        <WorkflowLauncherTemplateGrid
          templates={templates}
          busyTemplateId={busyTemplateId}
          onSelect={onTemplateSelect}
          onExploreMore={() => setSheetOpen(true)}
          onAgentClick={onAgentClick}
        />
      </div>

      <WorkflowLauncherTemplateSheet
        open={sheetOpen}
        templates={templates}
        onSelect={(tpl) => { setSheetOpen(false); onTemplateSelect(tpl) }}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  )
}
