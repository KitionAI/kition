import { Check, FileClock, FileText, LoaderCircle, MoreHorizontal, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/registry/ui/popover'

export type WorkflowDetailView = 'configuration' | 'history' | 'logs'

type WorkflowHomeActionsMenuProps = {
  activeView: WorkflowDetailView
  labels: {
    moreActions: string
    configuration: string
    history: string
    logs: string
    delete: string
  }
  deleting: boolean
  deleteDisabled: boolean
  onSelectView: (view: WorkflowDetailView) => void
  onDelete: () => void
}

const VIEW_ITEMS = [
  { view: 'configuration' as const, icon: SlidersHorizontal, testId: 'workflow-home-view-configuration' },
  { view: 'history' as const, icon: FileClock, testId: 'workflow-home-history' },
  { view: 'logs' as const, icon: FileText, testId: 'workflow-home-logs' },
]

export function WorkflowHomeActionsMenu({
  activeView,
  labels,
  deleting,
  deleteDisabled,
  onSelectView,
  onDelete,
}: WorkflowHomeActionsMenuProps) {
  const [open, setOpen] = useState(false)

  function selectView(view: WorkflowDetailView) {
    onSelectView(view)
    setOpen(false)
  }

  function requestDelete() {
    setOpen(false)
    onDelete()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={labels.moreActions}
          title={labels.moreActions}
          data-testid="workflow-home-more-actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-52 rounded-lg border border-border bg-card p-1 shadow-floating"
      >
        <div role="menu" aria-label={labels.moreActions} className="grid gap-0.5">
          {VIEW_ITEMS.map(({ view, icon: Icon, testId }) => (
            <button
              key={view}
              type="button"
              role="menuitemradio"
              aria-checked={activeView === view}
              data-testid={testId}
              onClick={() => selectView(view)}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm hover:bg-muted',
                activeView === view && 'bg-muted/70 font-medium',
              )}
            >
              <Icon className="size-4 text-muted-foreground" />
              <span className="flex-1">{labels[view]}</span>
              {activeView === view ? <Check className="size-4 text-primary" /> : null}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            data-testid="workflow-home-delete"
            onClick={requestDelete}
            disabled={deleteDisabled}
            className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
          >
            {deleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            <span>{labels.delete}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
