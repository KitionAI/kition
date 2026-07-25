import { ONBOARDING_BASE } from './onboardingManifest'

export type OnboardingGuide = {
  slug: string
  displayName: string
  summary: string
  intro: 'intro.md'
  seeds: string[]
  assets?: string[]
  tableFile: string | null
}

export type OnboardingGuideManifest = {
  version: 1
  guides: OnboardingGuide[]
}

export const ONBOARDING_GUIDE_BASE = ONBOARDING_BASE
export const ONBOARDING_GUIDE_MANIFEST_URL = `${ONBOARDING_BASE}/guides.json`
export const ONBOARDING_GUIDE_FOLDER = 'Guides'
