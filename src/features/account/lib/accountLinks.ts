import type { PortalAccountSession } from '@/api/desktop'
import { DEFAULT_CONSOLE_TOPUP_URL } from '@/services/consoleCredits'
import { normalizeAccountActionURL } from './accountPresentation'

export const KITION_SUPPORT_URL = 'mailto:support@kition.ai'
export const KITION_TERMS_URL = 'https://kition.ai/terms'
export const KITION_PRIVACY_URL = 'https://kition.ai/privacy'

export function getKitionAccountLinks(session?: PortalAccountSession | null) {
  return {
    billing: normalizeAccountActionURL(session?.billing_url) || DEFAULT_CONSOLE_TOPUP_URL,
    topup: normalizeAccountActionURL(session?.topup_url) || DEFAULT_CONSOLE_TOPUP_URL,
    support: normalizeAccountActionURL(session?.support_url, { allowMailto: true }) || KITION_SUPPORT_URL,
    terms: normalizeAccountActionURL(session?.terms_url) || KITION_TERMS_URL,
    privacy: normalizeAccountActionURL(session?.privacy_url) || KITION_PRIVACY_URL,
  }
}
