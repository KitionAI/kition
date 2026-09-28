/**
 * Languages offered as translation targets, as BCP 47 codes. Shared by the
 * settings model and the document feature. Display names come from
 * Intl.DisplayNames at runtime so no localized literals live in source.
 */
export const TRANSLATION_LANGUAGES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'it',
  'pt-BR',
  'ru',
  'ar',
] as const

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]

/** `auto` follows the app language. */
export type TranslationTargetPreference = TranslationLanguage | 'auto'

function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && (TRANSLATION_LANGUAGES as readonly string[]).includes(value)
}

export function normalizeTranslationTargetPreference(value: unknown): TranslationTargetPreference {
  return isTranslationLanguage(value) ? value : 'auto'
}

function displayName(language: TranslationLanguage, inLanguage: string) {
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language' }).of(language) || language
  } catch {
    return language
  }
}

/** The language's name in its own script, for menus. */
export function translationLanguageEndonym(language: TranslationLanguage) {
  return displayName(language, language)
}

/** The language's English name, used in model prompts. */
export function translationLanguageEnglishName(language: TranslationLanguage) {
  return displayName(language, 'en')
}
