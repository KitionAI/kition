import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui'

export function EmailSyncTriggerPanel({
  enabled,
  intervalMinutes,
  busy = false,
  onSave,
}: {
  enabled: boolean
  intervalMinutes: number
  busy?: boolean
  onSave: (enabled: boolean, intervalMinutes: number) => void
}) {
  const [value, setValue] = useState(enabled ? String(intervalMinutes) : 'manual')

  useEffect(() => {
    setValue(enabled ? String(intervalMinutes) : 'manual')
  }, [enabled, intervalMinutes])

  return (
    <div className="grid gap-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Start this workflow</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Run manually or poll the mailbox on a fixed interval.
        </p>
      </div>

      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        <span>Trigger</span>
        <select
          className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          data-testid="email-sync-trigger-schedule"
        >
          <option value="manual">Manual only</option>
          <option value="5">Every 5 minutes</option>
          <option value="15">Every 15 minutes</option>
          <option value="30">Every 30 minutes</option>
          <option value="60">Every hour</option>
          <option value="360">Every 6 hours</option>
          <option value="1440">Every day</option>
        </select>
      </label>

      <Button
        disabled={busy}
        onClick={() => onSave(
          value !== 'manual',
          value === 'manual' ? intervalMinutes : Number(value),
        )}
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Save trigger
      </Button>
    </div>
  )
}
