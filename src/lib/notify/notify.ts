import { toast, type ExternalToast } from 'sonner'

export type NotifyId = string | number

export interface NotifyOpts {
  /** Same id replaces an existing toast instead of stacking. */
  id?: NotifyId
  /** Default depends on variant. Pass `Number.POSITIVE_INFINITY` for sticky. */
  duration?: number
  action?: { label: string; onClick: () => void }
  description?: string
}

const DEFAULT_DURATION_MS = 4000
const DEFAULT_ERROR_DURATION_MS = 6000

function toSonner(opts: NotifyOpts | undefined, defaultDuration: number): ExternalToast {
  const duration = opts?.duration ?? defaultDuration
  const out: ExternalToast = { duration }
  if (opts?.id !== undefined) out.id = opts.id
  if (opts?.description !== undefined) out.description = opts.description
  if (opts?.action) {
    out.action = {
      label: opts.action.label,
      onClick: opts.action.onClick,
    }
  }
  return out
}

export const notify = {
  success(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.success(msg, toSonner(opts, DEFAULT_DURATION_MS))
  },
  error(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.error(msg, toSonner(opts, DEFAULT_ERROR_DURATION_MS))
  },
  warning(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.warning(msg, toSonner(opts, DEFAULT_DURATION_MS))
  },
  info(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.info(msg, toSonner(opts, DEFAULT_DURATION_MS))
  },
  loading(msg: string, opts?: NotifyOpts): NotifyId {
    // sonner's loading is sticky by default; respect explicit duration only.
    const out = toSonner(opts, Number.POSITIVE_INFINITY)
    if (opts?.duration === undefined) delete out.duration
    return toast.loading(msg, out)
  },
  dismiss(id?: NotifyId): void {
    toast.dismiss(id)
  },

  persistentError(
    msg: string,
    action: { label: string; onClick: () => void },
    opts?: Omit<NotifyOpts, 'duration' | 'action'>,
  ): NotifyId {
    return toast.error(msg, toSonner({ ...opts, duration: Number.POSITIVE_INFINITY, action }, DEFAULT_ERROR_DURATION_MS))
  },

  promise<T>(
    p: Promise<T>,
    msgs: {
      loading: string
      success: string | ((v: T) => string)
      error: string | ((e: unknown) => string)
    },
    opts?: NotifyOpts,
  ): Promise<T> {
    toast.promise(p, { loading: msgs.loading, success: msgs.success, error: msgs.error, ...toSonner(opts, DEFAULT_DURATION_MS) })
    return p
  },
}
