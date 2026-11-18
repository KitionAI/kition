import { isSupportedLocale, type Locale } from './types'

export const STORAGE_KEY = 'kition.locale.v1'

export function readStoredLocale(): Locale | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return isSupportedLocale(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeStoredLocale(locale: Locale) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // ignore — storage may be full or disabled
  }
}

export function detectBrowserLocale(): Locale | null {
  if (typeof navigator === 'undefined') {
    return null
  }
  const candidates = [navigator.language, ...(navigator.languages || [])]
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = candidate.toLowerCase()
    if (normalized.startsWith('en')) return 'en-US'
    if (normalized.startsWith('zh')) return 'zh-CN'
    if (normalized.startsWith('es')) return 'es-ES'
    if (normalized.startsWith('fr')) return 'fr-FR'
    if (normalized.startsWith('pt')) return 'pt-BR'
    if (normalized.startsWith('ru')) return 'ru-RU'
  }
  return null
}
