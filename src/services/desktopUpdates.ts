import { trackProductEvent } from '@/features/analytics/lib/productAnalytics'

export type UpdatePhase =
  | 'idle' | 'unsupported' | 'checking' | 'up-to-date'
  | 'available' | 'downloading' | 'downloaded' | 'error'

export type UpdateErrorKind = 'network' | 'verification' | 'disk' | 'rate-limit' | 'other'

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'unsupported'; reason: string }
  | { phase: 'checking' }
  | { phase: 'up-to-date'; currentVersion?: string }
  | { phase: 'available'; version?: string; releaseNotes?: string; releaseDate?: string }
  | { phase: 'downloading'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version?: string }
  | { phase: 'error'; message: string; errorKind: UpdateErrorKind; phaseAtError: UpdatePhase }

type Bridge = {
  UpdatesGetState?: () => Promise<UpdateState>
  UpdatesCheck?: () => Promise<UpdateState>
  UpdatesDownload?: () => Promise<void>
  UpdatesInstall?: () => Promise<void>
  UpdatesSetBetaChannel?: (enabled: boolean) => Promise<void>
  UpdatesSetAutoCheck?: (enabled: boolean) => Promise<void>
  EventsOn?: (name: string, cb: (s: UpdateState) => void) => () => void
  updatesEvent?: string
}

function bridge(): Bridge | null {
  return (globalThis as any).kitionDesktop ?? null
}

const UNSUPPORTED: UpdateState = { phase: 'unsupported', reason: 'web preview' }

export async function getUpdateState(): Promise<UpdateState> {
  return (await bridge()?.UpdatesGetState?.()) ?? UNSUPPORTED
}

export async function checkForUpdates(): Promise<UpdateState> {
  try {
    const state = (await bridge()?.UpdatesCheck?.()) ?? UNSUPPORTED
    trackProductEvent('update_check_completed', {
      result: state.phase === 'error' ? 'failure' : state.phase === 'unsupported' ? 'unavailable' : 'success',
      update_state: state.phase,
    })
    return state
  } catch (error) {
    trackProductEvent('update_check_completed', { result: 'failure', update_state: 'error' })
    throw error
  }
}

export async function downloadUpdate(): Promise<void> {
  await bridge()?.UpdatesDownload?.()
}

export async function installUpdate(): Promise<void> {
  try {
    await bridge()?.UpdatesInstall?.()
    trackProductEvent('update_install_completed', { result: 'success', update_state: 'downloaded' })
  } catch (error) {
    trackProductEvent('update_install_completed', { result: 'failure', update_state: 'error' })
    throw error
  }
}

export async function setBetaChannel(enabled: boolean): Promise<void> {
  await bridge()?.UpdatesSetBetaChannel?.(enabled)
}

export async function setAutoCheckUpdates(enabled: boolean): Promise<void> {
  await bridge()?.UpdatesSetAutoCheck?.(enabled)
}

export function subscribeToUpdates(cb: (state: UpdateState) => void): () => void {
  const b = bridge()
  if (!b?.EventsOn || !b?.updatesEvent) {
    return () => {}
  }
  return b.EventsOn(b.updatesEvent, cb)
}
