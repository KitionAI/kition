const SETUP_REQUEST_KEY = 'kition.email-sync.setup-request.v1'
export const EMAIL_SYNC_SETUP_REQUEST_EVENT = 'kition:email-sync:setup-request'
const SETUP_EVENT_RETRY_DELAYS = [0, 100, 500]

export type EmailSyncSetupRequest = {
  tablePath: string
  runAfterSave?: 'full'
}

export function requestEmailSyncSetup(
  tablePath: string,
  options: Pick<EmailSyncSetupRequest, 'runAfterSave'> = {},
) {
  const request = { tablePath, ...options } satisfies EmailSyncSetupRequest
  try {
    sessionStorage.setItem(SETUP_REQUEST_KEY, JSON.stringify(request))
  } catch {
    // The workflow tab still opens when session storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent('kition:onboarding:open-local-workflow', {
    detail: { kitablePath: tablePath },
  }))
  for (const delay of SETUP_EVENT_RETRY_DELAYS) {
    window.setTimeout(() => {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new CustomEvent(EMAIL_SYNC_SETUP_REQUEST_EVENT, {
        detail: request,
      }))
    }, delay)
  }
}

export function consumeEmailSyncSetupRequest(expectedTablePath?: string): EmailSyncSetupRequest | null {
  try {
    const raw = sessionStorage.getItem(SETUP_REQUEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EmailSyncSetupRequest>
    const tablePath = typeof parsed.tablePath === 'string' ? parsed.tablePath.trim() : ''
    if (!tablePath || (expectedTablePath && normalizeTablePath(tablePath) !== normalizeTablePath(expectedTablePath))) return null
    sessionStorage.removeItem(SETUP_REQUEST_KEY)
    return {
      tablePath,
      ...(parsed.runAfterSave === 'full' ? { runAfterSave: 'full' as const } : {}),
    }
  } catch {
    return null
  }
}

function normalizeTablePath(path: string) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}
