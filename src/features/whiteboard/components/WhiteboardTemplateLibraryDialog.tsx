import {
  GitBranch,
  LayoutTemplate,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  Plus,
  Presentation,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  WORKSPACE_TEMPLATE_LIBRARY_DIALOG_CLASSNAME,
  WorkspaceTemplateLibraryFrame,
} from '@/features/workspace/components/WorkspaceTemplateLibraryFrame'
import {
  Dialog,
  DialogContent,
} from '@/registry/ui/dialog'

import {
  instantiateWhiteboardTemplate,
  WHITEBOARD_TEMPLATES,
  type WhiteboardTemplateCategory,
  type WhiteboardTemplateCreationSelection,
  type WhiteboardTemplateDefinition,
} from '../lib/whiteboardTemplates'
import { WhiteboardTemplatePreview } from './WhiteboardTemplateGallery'

export function WhiteboardTemplateLibraryDialog({
  busy = false,
  onOpenChange,
  onSelect,
  open,
}: {
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (selection?: WhiteboardTemplateCreationSelection) => Promise<boolean>
  open: boolean
}) {
  const { t } = useTranslation('workspace')
  const [activeCategory, setActiveCategory] = useState<WhiteboardTemplateCategory>('recommended')
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const disabled = busy || pendingId !== null
  const categories = useMemo(() => [
    { id: 'recommended' as const, label: t('board.templates.categories.recommended'), icon: Sparkles },
    { id: 'planning' as const, label: t('board.templates.categories.planning'), icon: ListChecks },
    { id: 'meetings' as const, label: t('board.templates.categories.meetings'), icon: MessagesSquare },
    { id: 'presentation' as const, label: t('board.templates.categories.presentation'), icon: Presentation },
  ], [t])

  useEffect(() => {
    if (!open) return
    setActiveCategory('recommended')
    setErrorMessage('')
    setPendingId(null)
    setQuery('')
  }, [open])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredTemplates = WHITEBOARD_TEMPLATES.filter((template) => {
    if (!normalizedQuery) return template.categories.includes(activeCategory)
    const copy = `${t(`board.templates.items.${template.id}.name`)} ${t(`board.templates.items.${template.id}.description`)}`
    return copy.toLocaleLowerCase().includes(normalizedQuery)
  })
  const showBlank = normalizedQuery
    ? `${t('board.templates.blank.name')} ${t('board.templates.blank.description')}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
    : activeCategory === 'recommended'

  async function createBlankBoard() {
    setPendingId('blank')
    setErrorMessage('')
    try {
      if (!await onSelect()) setErrorMessage(t('board.templates.creation.createFailed'))
    } finally {
      setPendingId(null)
    }
  }

  async function createFromTemplate(template: WhiteboardTemplateDefinition) {
    setPendingId(template.id)
    setErrorMessage('')
    try {
      const created = await onSelect({
        templateId: template.id,
        title: t(`board.templates.items.${template.id}.name`),
        template: instantiateWhiteboardTemplate(
          template.id,
          { x: 600, y: 380 },
          (key) => t(`board.templates.content.${key}`),
        ),
      })
      if (!created) setErrorMessage(t('board.templates.creation.createFailed'))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (disabled ? null : onOpenChange(nextOpen))}>
      <DialogContent
        size="none"
        className={WORKSPACE_TEMPLATE_LIBRARY_DIALOG_CLASSNAME}
        data-testid="whiteboard-template-library-dialog"
        disableAutoFocus
      >
        <WorkspaceTemplateLibraryFrame
          title={t('board.templates.creation.title')}
          description={t('board.templates.creation.description')}
          icon={LayoutTemplate}
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={t('board.templates.creation.searchPlaceholder')}
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={(category) => {
            setActiveCategory(category)
            setQuery('')
          }}
        >
          <section className="mx-auto max-w-7xl">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-foreground">
                  {normalizedQuery
                    ? t('board.templates.creation.searchResults', { query })
                    : categories.find((item) => item.id === activeCategory)?.label}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('board.templates.creation.hint')}
                </p>
              </div>
              {errorMessage ? (
                <span className="text-xs text-destructive" role="alert">{errorMessage}</span>
              ) : null}
            </div>

            {showBlank || filteredTemplates.length ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
                {showBlank ? (
                  <BlankBoardCard
                    busy={pendingId === 'blank'}
                    disabled={disabled}
                    onCreate={() => void createBlankBoard()}
                    title={t('board.templates.blank.name')}
                    description={t('board.templates.blank.description')}
                  />
                ) : null}
                {filteredTemplates.map((template) => (
                  <BoardTemplateCard
                    key={template.id}
                    busy={pendingId === template.id}
                    disabled={disabled}
                    template={template}
                    title={t(`board.templates.items.${template.id}.name`)}
                    description={t(`board.templates.items.${template.id}.description`)}
                    useLabel={t('board.templates.creation.use')}
                    onCreate={() => void createFromTemplate(template)}
                  />
                ))}
              </div>
            ) : (
              <div className="grid min-h-48 place-items-center rounded-xl border border-dashed bg-muted/30 px-6 text-center">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('board.templates.creation.noMatches')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('board.templates.creation.noMatchesHint')}
                  </p>
                </div>
              </div>
            )}
          </section>
        </WorkspaceTemplateLibraryFrame>
      </DialogContent>
    </Dialog>
  )
}

function BlankBoardCard({
  busy,
  description,
  disabled,
  onCreate,
  title,
}: {
  busy: boolean
  description: string
  disabled: boolean
  onCreate: () => void
  title: string
}) {
  return (
    <article className="group min-w-0">
      <button
        type="button"
        className="relative block aspect-[16/9] w-full overflow-hidden rounded-xl border bg-muted/25 transition hover:border-primary/35 hover:shadow-soft disabled:opacity-60"
        disabled={disabled}
        onClick={onCreate}
        data-testid="whiteboard-template-blank"
      >
        <span className="absolute inset-0 grid place-items-center">
          {busy ? (
            <LoaderCircle className="size-7 animate-spin text-primary" />
          ) : (
            <span className="grid size-20 place-items-center rounded-xl border border-dashed border-primary/30 bg-background shadow-sm">
              <Plus className="size-7 text-primary" />
            </span>
          )}
        </span>
      </button>
      <h4 className="mt-3 text-sm font-semibold text-foreground">{title}</h4>
      <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{description}</p>
    </article>
  )
}

function BoardTemplateCard({
  busy,
  description,
  disabled,
  onCreate,
  template,
  title,
  useLabel,
}: {
  busy: boolean
  description: string
  disabled: boolean
  onCreate: () => void
  template: WhiteboardTemplateDefinition
  title: string
  useLabel: string
}) {
  return (
    <article className="group min-w-0">
      <button
        type="button"
        className="relative block aspect-[16/9] w-full overflow-hidden rounded-xl border bg-surface-soft text-left transition hover:border-primary/35 hover:shadow-soft disabled:opacity-60"
        disabled={disabled}
        onClick={onCreate}
        data-testid={`whiteboard-template-create-${template.id}`}
      >
        <WhiteboardTemplatePreview
          className="h-full rounded-none border-0 bg-transparent p-5 group-hover:bg-transparent"
          templateId={template.id}
        />
        <span className="absolute inset-0 grid place-items-center bg-foreground/0 opacity-0 transition group-hover:bg-foreground/10 group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm">
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : useLabel}
          </span>
        </span>
      </button>
      <div className="mt-3 flex items-center gap-2">
        <GitBranch className="size-3.5 shrink-0 text-primary" />
        <h4 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h4>
      </div>
      <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
        {description}
      </p>
    </article>
  )
}
