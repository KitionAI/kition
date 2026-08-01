export type OnboardingManifest = {
  version: number
  folder: string
  welcome: {
    filename: string
    asset: string
    folder?: string
  }
  documents?: Array<{ asset: string; filename: string; folder?: string }>
  tables: Array<{ asset: string; filename: string; folder?: string }>
  images?: Array<{ asset: string; filename: string }>
  guides?: { manifest: string; folder?: string }
}

export const ONBOARDING_BASE = '/onboarding'
export const ONBOARDING_WELCOME_PATH = 'Getting Started/Welcome to Kition.md'
export const ONBOARDING_EMAIL_INBOX_SYNC_PATH = 'Getting Started/Operations & Analytics/Email Inbox Sync.kitable'

export async function fetchOnboardingManifest(
  fetchText: (url: string) => Promise<string> = defaultFetchText,
): Promise<OnboardingManifest> {
  const text = await fetchText(`${ONBOARDING_BASE}/manifest.json`)
  return JSON.parse(text) as OnboardingManifest
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`)
  return res.text()
}
