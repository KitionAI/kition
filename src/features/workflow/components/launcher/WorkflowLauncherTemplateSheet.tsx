import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkflowLauncherTemplateCard } from './WorkflowLauncherTemplateCard'
import type { WorkflowTemplate } from '@/features/workflow/templates'

export interface WorkflowLauncherTemplateSheetProps {
  open: boolean
  templates: WorkflowTemplate[]
  onSelect: (template: WorkflowTemplate) => void
  onClose: () => void
}

export function WorkflowLauncherTemplateSheet(props: WorkflowLauncherTemplateSheetProps) {
  const { open, templates, onSelect, onClose } = props
  const [query, setQuery] = useState('')
  const { t } = useTranslation('workflow')

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return templates
    return templates.filter((tpl) =>
      tpl.name.toLowerCase().includes(needle) || tpl.description.toLowerCase().includes(needle),
    )
  }, [templates, query])

  if (!open) return null

  return (
    <div
      data-testid="workflow-launcher-template-sheet"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-card shadow-floating"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold text-foreground">{t('launcher.templateSheet.title')}</h2>
          <label className="relative ml-auto block w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/80" />
            <input
              data-testid="workflow-launcher-template-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('launcher.templateSheet.searchPlaceholder')}
              className="h-8 w-full rounded-lg border border-border bg-muted/40 pl-7 pr-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </label>
          <button type="button" onClick={onClose} className="inline-grid size-8 place-items-center rounded-lg hover:bg-muted" aria-label={t('launcher.templateSheet.closeAria')}>
            <X className="size-4" />
          </button>
        </header>
        <div className="grid gap-3 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((tpl) => (
            <WorkflowLauncherTemplateCard key={tpl.id} template={tpl} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </div>
  )
}
