import { SyncRpcError } from '@/lib/sync'
import { CollabUnavailableError } from './syncConnection'

type Translate = (key: string) => string

/**
 * What a co-editing dialog says when sharing, opening a link or syncing fails: the cause in plain
 * words and what to do, never the raw error (it goes to the console).
 */
export function collabErrorText(error: unknown, t: Translate) {
  if (error instanceof CollabUnavailableError) return t(error.reason === 'off' ? 'collab.needsAccount' : 'collab.unreachable')
  if (error instanceof SyncRpcError) {
    switch (error.reason) {
      case 'forbidden':
      case 'unauthorized':
        return t('collab.needsAccount')
      case 'not-found':
      case 'invalid':
        return t('collab.linkNotFound')
      case 'unavailable':
        return t('collab.unreachable')
      case 'rate-limited':
        return t('collab.busy')
    }
  }
  const raw = error instanceof Error ? error.message : String(error)
  console.warn('[collab] failed:', raw)
  if (/this build cannot open/.test(raw)) return t('collab.kitUnavailable')
  return t('collab.failed')
}
