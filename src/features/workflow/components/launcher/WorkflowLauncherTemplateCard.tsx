import { AlarmClock, CalendarClock, Database, FileText, LoaderCircle, MessageSquare, Plus, Send, Sparkles } from 'lucide-react'
import type { ComponentType } from 'react'
import type { WorkflowTemplate, TemplateIconRef } from '@/features/workflow/templates'

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  AlarmClock,
  CalendarClock,
  Database,
  FileText,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
}

export interface WorkflowLauncherTemplateCardProps {
  template: WorkflowTemplate
  onSelect: (template: WorkflowTemplate) => void
  busy?: boolean
  /** When true, render a one-line description under the title. Off by default
   *  so the launcher landing page (3-col grid) keeps its compact look; the
   *  modal picker opts in to give users more context per card. */
  showDescription?: boolean
}

export function WorkflowLauncherTemplateCard({ template, onSelect, busy, showDescription }: WorkflowLauncherTemplateCardProps) {
  return (
    <button
      type="button"
      data-testid="workflow-launcher-template-card"
      onClick={() => { if (!busy) onSelect(template) }}
      aria-disabled={busy}
      className={`group flex h-full w-full flex-col items-stretch gap-3 rounded-xl border border-border bg-card p-4 text-left card-interactive hover:border-primary/30 hover:shadow-soft ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center">
        {template.icons.map((icon, idx) => (
          <IconChip key={idx} icon={icon} stacked={idx > 0} />
        ))}
        {typeof template.badgeCount === 'number' ? (
          <span className="-ml-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">+{template.badgeCount}</span>
        ) : null}
        {busy ? <LoaderCircle className="ml-auto size-4 animate-spin text-primary" /> : null}
      </div>
      <span className="block text-sm font-medium text-foreground">{template.name}</span>
      {showDescription && template.description ? (
        <span
          data-testid="workflow-launcher-template-card-description"
          className="-mt-1 block text-xs leading-relaxed text-muted-foreground"
        >
          {template.description}
        </span>
      ) : null}
    </button>
  )
}

function IconChip({ icon, stacked }: { icon: TemplateIconRef; stacked: boolean }) {
  const offset = stacked ? '-ml-1.5' : ''
  if (icon.kind === 'emoji') {
    return (
      <span
        data-testid="workflow-launcher-template-card-icon"
        className={`grid size-7 place-items-center rounded-md bg-tint-peach/40 text-base ${offset}`}
      >
        {icon.char}
      </span>
    )
  }
  const Icon = ICON_MAP[icon.name]
  return (
    <span
      data-testid="workflow-launcher-template-card-icon"
      className={`grid size-7 place-items-center rounded-md bg-primary/15 text-primary ${offset}`}
    >
      {Icon ? <Icon className="size-4" /> : null}
    </span>
  )
}
