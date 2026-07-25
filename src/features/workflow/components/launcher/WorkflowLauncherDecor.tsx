import { Sparkles } from 'lucide-react'

export function WorkflowLauncherDecor() {
  return (
    <div data-testid="workflow-launcher-decor" className="hidden lg:flex lg:flex-col lg:items-start lg:gap-3">
      <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm italic text-foreground shadow-sm">
        Auto-send follow-up reminders
        <br />
        at 9:00 am each day
      </div>
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground">
          <Sparkles className="size-3.5" />
        </span>
        <span className="flex gap-1">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        </span>
      </div>
    </div>
  )
}
