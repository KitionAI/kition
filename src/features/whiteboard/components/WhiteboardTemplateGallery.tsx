import { LayoutTemplate } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/registry/ui/popover'
import { cn } from '@/lib/utils'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import {
  WHITEBOARD_TEMPLATES,
  type WhiteboardTemplateId,
} from '../lib/whiteboardTemplates'
import type { WhiteboardPoint } from '../lib/whiteboardTypes'

export function WhiteboardTemplateGallery({
  canvasSize,
  controller,
  onOpenChange,
  open,
}: {
  canvasSize: WhiteboardPoint
  controller: WhiteboardEditorController
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { t } = useTranslation('workspace')

  function insertTemplate(templateId: WhiteboardTemplateId) {
    controller.insertTemplate(
      templateId,
      canvasSize,
      (key) => t(`board.templates.content.${key}`),
    )
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('board.templates.title')}
          title={t('board.templates.title')}
          data-testid="whiteboard-template-trigger"
        >
          <LayoutTemplate className="size-4" />
          <span>{t('board.templates.trigger')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[520px] rounded-xl border bg-popover p-3 shadow-[var(--shadow-floating)]"
        data-testid="whiteboard-template-gallery"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-1 pb-3">
          <div className="text-sm font-semibold text-foreground">
            {t('board.templates.title')}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('board.templates.description')}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {WHITEBOARD_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="group rounded-xl border bg-background p-2.5 text-left transition-colors hover:border-hairline-strong hover:bg-surface-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => insertTemplate(template.id)}
              data-testid={`whiteboard-template-${template.id}`}
            >
              <WhiteboardTemplatePreview templateId={template.id} />
              <div className="mt-2 text-sm font-semibold text-foreground">
                {t(`board.templates.items.${template.id}.name`)}
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
                {t(`board.templates.items.${template.id}.description`)}
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function WhiteboardTemplatePreview({
  className,
  templateId,
}: {
  className?: string
  templateId: WhiteboardTemplateId
}) {
  return (
    <div className={cn(
      'h-20 overflow-hidden rounded-lg border bg-surface-soft p-2 text-muted-foreground transition-colors group-hover:bg-background',
      className,
    )}>
      <svg
        viewBox="0 0 180 64"
        className="h-full w-full"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <TemplatePreviewContent templateId={templateId} />
      </svg>
    </div>
  )
}

function TemplatePreviewContent({ templateId }: { templateId: WhiteboardTemplateId }) {
  switch (templateId) {
    case 'mind-map':
      return (
        <>
          <path d="M90 32 42 15M90 32 42 49M90 32l48-17M90 32l48 17" />
          <rect x="66" y="23" width="48" height="18" rx="5" className="fill-accent stroke-brand" />
          <rect x="19" y="8" width="46" height="14" rx="4" className="fill-background stroke-border" />
          <rect x="19" y="42" width="46" height="14" rx="4" className="fill-background stroke-border" />
          <rect x="115" y="8" width="46" height="14" rx="4" className="fill-background stroke-border" />
          <rect x="115" y="42" width="46" height="14" rx="4" className="fill-background stroke-border" />
        </>
      )
    case 'flowchart':
      return (
        <>
          <path d="M39 32h22M94 32h18M143 32h18M127 43v10H78V43" />
          <rect x="12" y="24" width="27" height="16" rx="8" className="fill-tint-mint stroke-success" />
          <rect x="61" y="21" width="33" height="22" rx="4" className="fill-tint-sky stroke-border" />
          <path d="m127 18 16 14-16 14-15-14Z" className="fill-tint-yellow stroke-warning" />
          <rect x="67" y="50" width="22" height="10" rx="3" className="fill-tint-rose stroke-destructive" />
          <rect x="143" y="24" width="27" height="16" rx="8" className="fill-accent stroke-brand" />
        </>
      )
    case 'project-roadmap':
      return (
        <>
          <path d="M26 33h128" />
          {[20, 58, 96, 134].map((x, index) => (
            <g key={x}>
              <circle cx={x + 6} cy="33" r="3" className="fill-brand stroke-brand" />
              <rect x={x} y={index % 2 === 0 ? 8 : 42} width="32" height="14" rx="4" className="fill-background stroke-border" />
            </g>
          ))}
        </>
      )
    case 'kanban-board':
      return (
        <>
          {[8, 66, 124].map((x) => (
            <rect key={x} x={x} y="5" width="48" height="54" rx="4" className="fill-background stroke-border" />
          ))}
          <path d="M16 14h22M74 14h22M132 14h22" />
          <rect x="15" y="21" width="34" height="12" rx="3" className="fill-tint-yellow stroke-warning" />
          <rect x="73" y="21" width="34" height="12" rx="3" className="fill-accent stroke-brand" />
          <rect x="131" y="21" width="34" height="12" rx="3" className="fill-tint-mint stroke-success" />
          <rect x="15" y="39" width="34" height="12" rx="3" className="fill-tint-sky stroke-border" />
        </>
      )
    case 'meeting-retrospective':
      return (
        <>
          {[8, 66, 124].map((x) => (
            <rect key={x} x={x} y="5" width="48" height="54" rx="4" className="fill-background stroke-border" />
          ))}
          <circle cx="18" cy="15" r="3" className="fill-success stroke-success" />
          <circle cx="76" cy="15" r="3" className="fill-warning stroke-warning" />
          <circle cx="134" cy="15" r="3" className="fill-brand stroke-brand" />
          <rect x="15" y="23" width="34" height="13" rx="3" className="fill-tint-mint stroke-success" />
          <rect x="73" y="23" width="34" height="13" rx="3" className="fill-tint-peach stroke-warning" />
          <rect x="131" y="23" width="34" height="13" rx="3" className="fill-accent stroke-brand" />
        </>
      )
    case 'presentation-storyboard':
      return (
        <>
          {[8, 66, 124].flatMap((x) => [5, 36].map((y) => (
            <g key={`${x}-${y}`}>
              <rect x={x} y={y} width="48" height="23" rx="3" className="fill-background stroke-border" />
              <rect x={x + 5} y={y + 7} width="38" height="11" rx="2" className="fill-accent stroke-brand" />
            </g>
          )))}
        </>
      )
  }
}
