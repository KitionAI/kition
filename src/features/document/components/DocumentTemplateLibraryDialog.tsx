import {
  Blocks,
  BookOpenText,
  Briefcase,
  CalendarDays,
  ChartGantt,
  ChartNoAxesCombined,
  CheckSquare,
  ClipboardList,
  Contact,
  FilePlus2,
  FileText,
  FlaskConical,
  GitBranch,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Megaphone,
  Network,
  NotebookPen,
  PanelsTopLeft,
  RotateCcw,
  Rocket,
  Target,
  Workflow,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { loadTemplateContent, listTemplates, type TemplateEntry } from '@/features/document/editor/vault/templates'
import type { DocumentCreationPreset } from '@/features/document/lib/documentCreation'
import {
  getBuiltinDocumentTemplates,
  renderDocumentTemplatePlaceholders,
  type BuiltinDocumentTemplate,
  type DocumentTemplateCategory,
  type DocumentTemplateIcon,
  type DocumentTemplatePreview,
  type DocumentTemplateTone,
} from '@/features/document/lib/documentTemplates'
import { cn } from '@/lib/utils'
import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import {
  WORKSPACE_TEMPLATE_LIBRARY_DIALOG_CLASSNAME,
  WorkspaceTemplateLibraryFrame,
} from '@/features/workspace/components/WorkspaceTemplateLibraryFrame'
import {
  Dialog,
  DialogContent,
} from '@/registry/ui/dialog'

type TemplateCategoryFilter = 'all' | 'workspace' | DocumentTemplateCategory

type DocumentTemplateLibraryDialogProps = {
  open: boolean
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (preset?: DocumentCreationPreset) => Promise<boolean>
}

const iconByKind: Record<DocumentTemplateIcon, ComponentType<{ className?: string }>> = {
  action: ListChecks,
  analytics: ChartNoAxesCombined,
  architecture: Blocks,
  brainstorm: Lightbulb,
  brief: Briefcase,
  calendar: CalendarDays,
  checklist: CheckSquare,
  client: Contact,
  daily: BookOpenText,
  flowchart: GitBranch,
  launch: Megaphone,
  meeting: NotebookPen,
  okr: Target,
  organization: Network,
  product: PanelsTopLeft,
  research: FlaskConical,
  report: ClipboardList,
  review: RotateCcw,
  swimlane: Workflow,
  timeline: ChartGantt,
}

const previewToneClass: Record<DocumentTemplateTone, string> = {
  cream: 'bg-tint-cream',
  gray: 'bg-tint-gray',
  lavender: 'bg-tint-lavender',
  mint: 'bg-tint-mint',
  peach: 'bg-tint-peach',
  rose: 'bg-tint-rose',
  sky: 'bg-tint-sky',
  yellow: 'bg-tint-yellow',
}

export function DocumentTemplateLibraryDialog({
  open,
  busy = false,
  onOpenChange,
  onCreate,
}: DocumentTemplateLibraryDialogProps) {
  const { t } = useTranslation('document')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<TemplateCategoryFilter>('all')
  const [workspaceTemplates, setWorkspaceTemplates] = useState<TemplateEntry[] | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const builtins = useMemo(() => getBuiltinDocumentTemplates(t), [t])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCategory('all')
    setPendingId(null)
    setErrorMessage('')
    setWorkspaceTemplates(null)
    let cancelled = false
    void listTemplates()
      .then((templates) => {
        if (!cancelled) setWorkspaceTemplates(templates)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceTemplates([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredBuiltins = builtins.filter((template) => {
    if (category !== 'all' && category !== template.category) return false
    if (!normalizedQuery) return true
    return `${template.title} ${template.description}`.toLocaleLowerCase().includes(normalizedQuery)
  })
  const filteredWorkspaceTemplates = (workspaceTemplates || []).filter((template) => {
    if (category !== 'all' && category !== 'workspace') return false
    if (!normalizedQuery) return true
    return `${template.name} ${template.path}`.toLocaleLowerCase().includes(normalizedQuery)
  })
  const showBlank = category === 'all' && (
    !normalizedQuery
    || t('templateLibrary.blank.title').toLocaleLowerCase().includes(normalizedQuery)
    || t('templateLibrary.blank.description').toLocaleLowerCase().includes(normalizedQuery)
  )
  const hasResults = showBlank || filteredBuiltins.length > 0 || filteredWorkspaceTemplates.length > 0
  const disabled = busy || pendingId !== null

  const categories: Array<{ id: TemplateCategoryFilter; label: string; icon: typeof FileText }> = [
    { id: 'all', label: t('templateLibrary.categories.all'), icon: Rocket },
    { id: 'work', label: t('templateLibrary.categories.work'), icon: Briefcase },
    { id: 'planning', label: t('templateLibrary.categories.planning'), icon: CalendarDays },
    { id: 'personal', label: t('templateLibrary.categories.personal'), icon: NotebookPen },
    ...(workspaceTemplates?.length
      ? [{ id: 'workspace' as const, label: t('templateLibrary.categories.workspace'), icon: FileText }]
      : []),
  ]

  const createBlankDocument = async () => {
    setPendingId('blank')
    setErrorMessage('')
    try {
      if (!await onCreate()) setErrorMessage(t('templateLibrary.createFailed'))
    } finally {
      setPendingId(null)
    }
  }

  const createFromBuiltin = async (template: BuiltinDocumentTemplate) => {
    setPendingId(template.id)
    setErrorMessage('')
    try {
      const created = await onCreate({
        title: template.title,
        content: renderDocumentTemplatePlaceholders(template.content, template.title).replace('{{cursor}}', ''),
        templateId: template.id,
      })
      if (!created) setErrorMessage(t('templateLibrary.createFailed'))
    } finally {
      setPendingId(null)
    }
  }

  const createFromWorkspaceTemplate = async (template: TemplateEntry) => {
    const templateId = `workspace:${template.path}`
    setPendingId(templateId)
    setErrorMessage('')
    try {
      const content = await loadTemplateContent(template.path, template.name)
      if (content === null) {
        setErrorMessage(t('templateLibrary.loadFailed'))
        return
      }
      const created = await onCreate({
        title: template.name,
        content,
        templateId,
      })
      if (!created) setErrorMessage(t('templateLibrary.createFailed'))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (disabled ? null : onOpenChange(nextOpen))}>
      <DialogContent
        size="none"
        className={WORKSPACE_TEMPLATE_LIBRARY_DIALOG_CLASSNAME}
        data-testid="document-template-library-dialog"
        disableAutoFocus
      >
        <WorkspaceTemplateLibraryFrame
          title="Template Center"
          description="Choose a template or a blank document to create a new Markdown document."
          icon={FileText}
          query={query}
          onQueryChange={setQuery}
          categories={categories}
          activeCategory={category}
          onCategoryChange={(nextCategory) => {
            setCategory(nextCategory)
            setQuery('')
          }}
        >
          <section className="mx-auto max-w-7xl">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-foreground">
                  {normalizedQuery
                    ? `Search results for “${query}”`
                    : categories.find((item) => item.id === category)?.label}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">Choose a focused writing structure and customize it after creation.</p>
              </div>
              {errorMessage ? <span className="text-xs text-destructive" role="alert">{errorMessage}</span> : null}
            </div>
            {hasResults ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
                {showBlank ? (
                  <TemplateCard
                    title={t('templateLibrary.blank.title')}
                    description={t('templateLibrary.blank.description')}
                    icon={FilePlus2}
                    previewClassName="bg-muted/60"
                    busy={pendingId === 'blank'}
                    disabled={disabled}
                    onClick={() => void createBlankDocument()}
                    testId="document-template-blank"
                  />
                ) : null}
                {filteredBuiltins.map((template) => (
                  <TemplateCard
                    key={template.id}
                    title={template.title}
                    description={template.description}
                    icon={iconByKind[template.icon]}
                    previewClassName={previewToneClass[template.tone]}
                    preview={template.preview}
                    coverImage={template.coverImage}
                    busy={pendingId === template.id}
                    disabled={disabled}
                    onClick={() => void createFromBuiltin(template)}
                    testId={`document-template-${template.id}`}
                  />
                ))}
                {filteredWorkspaceTemplates.map((template) => {
                  const templateId = `workspace:${template.path}`
                  return (
                    <TemplateCard
                      key={template.path}
                      title={template.name}
                      description={t('templateLibrary.workspaceTemplateDescription', { path: template.path })}
                      icon={FileText}
                      previewClassName="bg-accent"
                      busy={pendingId === templateId}
                      disabled={disabled}
                      onClick={() => void createFromWorkspaceTemplate(template)}
                      testId="document-template-workspace"
                    />
                  )
                })}
              </div>
            ) : (
              <div className="grid min-h-48 place-items-center rounded-xl border border-dashed border-border bg-muted/30 px-6 text-center">
                <div>
                  <p className="mt-3 text-sm font-medium text-foreground">{t('templateLibrary.noMatches')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('templateLibrary.noMatchesHint')}</p>
                </div>
              </div>
            )}
            <p className="mt-8 text-xs text-muted-foreground">
              {workspaceTemplates === null
                ? t('templateLibrary.loadingWorkspaceTemplates')
                : t('templateLibrary.templateCount', { count: builtins.length + workspaceTemplates.length })}
            </p>
          </section>
        </WorkspaceTemplateLibraryFrame>
      </DialogContent>
    </Dialog>
  )
}

function TemplateCard({
  title,
  description,
  icon: Icon,
  previewClassName,
  preview,
  coverImage,
  busy,
  disabled,
  onClick,
  testId,
}: {
  title: string
  description: string
  icon: ComponentType<{ className?: string }>
  previewClassName: string
  preview?: DocumentTemplatePreview
  coverImage?: string
  busy: boolean
  disabled: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <article className="group min-w-0">
      <div className="relative">
        <button
          type="button"
          className={cn('relative block aspect-[16/9] w-full overflow-hidden rounded-xl border border-border text-left transition hover:border-primary/35 hover:shadow-soft disabled:opacity-60', previewClassName)}
          onClick={onClick}
          disabled={disabled}
          data-testid={testId}
          data-preview={preview}
          data-cover-image={coverImage}
        >
          {coverImage ? (
            <img
              alt=""
              className="absolute inset-0 size-full object-cover"
              loading="lazy"
              src={resolveBundledAssetURL(coverImage)}
            />
          ) : null}
          <span className="absolute left-4 top-4 grid size-9 place-items-center rounded-lg border border-border/50 bg-background/85 text-foreground shadow-sm">
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
          </span>
          {!coverImage ? (
            <>
              <span className="absolute left-4 right-14 top-[4.25rem] h-2 rounded-sm bg-foreground/20" />
              <span className="absolute left-4 right-8 top-[5.4rem] h-1.5 rounded-sm bg-foreground/10" />
              <span className="absolute left-4 right-20 top-[6.4rem] h-1.5 rounded-sm bg-foreground/10" />
            </>
          ) : null}
        </button>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-foreground/0 opacity-0 transition group-hover:bg-foreground/10 group-hover:opacity-100 group-focus-within:opacity-100">
          <Button type="button" size="sm" className="pointer-events-auto" disabled={disabled} onClick={onClick}>
            Use
          </Button>
        </div>
      </div>
      <h4 className="mt-3 truncate text-sm font-semibold text-foreground">{title}</h4>
      <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{description}</p>
    </article>
  )
}
