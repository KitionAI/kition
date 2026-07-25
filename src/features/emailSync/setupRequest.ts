const SETUP_REQUEST_KEY = 'kition.email-sync.setup-request.v1'
export const EMAIL_SYNC_SETUP_REQUEST_EVENT = 'kition:email-sync:setup-request'

export type EmailSyncSetupRequest = {
  tablePath: string
}

export function requestEmailSyncSetup(tablePath: string) {
  try {
    sessionStorage.setItem(SETUP_REQUEST_KEY, JSON.stringify({ tablePath } satisfies EmailSyncSetupRequest))
  } catch {
    // The workflow tab still opens when session storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent('kition:onboarding:open-local-workflow', {
    detail: { kitablePath: tablePath },
  }))
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(EMAIL_SYNC_SETUP_REQUEST_EVENT, {
      detail: { tablePath },
    }))
  }, 0)
}

export function consumeEmailSyncSetupRequest(expectedTablePath?: string): EmailSyncSetupRequest | null {
  try {
    const raw = sessionStorage.getItem(SETUP_REQUEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EmailSyncSetupRequest>
    const tablePath = typeof parsed.tablePath === 'string' ? parsed.tablePath.trim() : ''
    if (!tablePath || (expectedTablePath && tablePath !== expectedTablePath)) return null
    sessionStorage.removeItem(SETUP_REQUEST_KEY)
    return { tablePath }
  } catch {
    return null
  }
}
