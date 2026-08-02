import type { UpdateState } from '@/services/desktopUpdates'

type DownloadingUpdateState = Extract<UpdateState, { phase: 'downloading' }>

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function formatUpdateBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const megabytes = bytes / (1024 * 1024)
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

type UpdateDownloadProgressProps = {
  state: DownloadingUpdateState
  label: string
}

export function UpdateDownloadProgress({ state, label }: UpdateDownloadProgressProps) {
  const percent = clampPercent(state.percent)
  const roundedPercent = Math.round(percent)

  return (
    <div className="w-[280px] max-w-full space-y-1.5 text-left">
      <div
        className="h-2 overflow-hidden rounded-sm bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPercent}
      >
        <span
          className="block h-full bg-primary transition-[width] duration-200 ease-linear"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground">
        <span>{formatUpdateBytes(state.transferred)} / {formatUpdateBytes(state.total)}</span>
        <span>{formatUpdateBytes(state.bytesPerSecond)}/s</span>
      </div>
    </div>
  )
}
