import { toast, type ToastOptions } from '@kition/tessera-ui'

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

function toToast(opts: NotifyOpts | undefined, defaultDuration: number): ToastOptions {
  const duration = opts?.duration ?? defaultDuration
  const out: ToastOptions = { duration }
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
    return toast.success(msg, toToast(opts, DEFAULT_DURATION_MS))
  },
  error(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.error(msg, toToast(opts, DEFAULT_ERROR_DURATION_MS))
  },
  warning(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.warning(msg, toToast(opts, DEFAULT_DURATION_MS))
  },
  info(msg: string, opts?: NotifyOpts): NotifyId {
    return toast.info(msg, toToast(opts, DEFAULT_DURATION_MS))
  },
  loading(msg: string, opts?: NotifyOpts): NotifyId {
    // A loading notice stays until its result replaces it; respect an explicit duration only.
    const out = toToast(opts, Number.POSITIVE_INFINITY)
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
    return toast.error(msg, toToast({ ...opts, duration: Number.POSITIVE_INFINITY, action }, DEFAULT_ERROR_DURATION_MS))
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
    void toast.promise(p, { loading: msgs.loading, success: msgs.success, error: msgs.error }, toToast(opts, DEFAULT_DURATION_MS))
    return p
  },
}
