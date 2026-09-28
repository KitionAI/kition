/**
 * Pure logic for selection translation: the target language list, which
 * language to translate into, the prompt sent to the model, and cleanup of
 * the model's answer. No React, no I/O.
 */
import type { Locale } from '@/i18n'
import {
  translationLanguageEnglishName,
  type TranslationLanguage,
  type TranslationTargetPreference,
} from '@/lib/translationLanguages'

export {
  TRANSLATION_LANGUAGES,
  translationLanguageEndonym,
  translationLanguageEnglishName,
  type TranslationLanguage,
  type TranslationTargetPreference,
} from '@/lib/translationLanguages'

const APP_LOCALE_TO_LANGUAGE: Record<Locale, TranslationLanguage> = {
  'en-US': 'en',
  'zh-CN': 'zh-Hans',
  'es-ES': 'es',
  'fr-FR': 'fr',
  'pt-BR': 'pt-BR',
  'ru-RU': 'ru',
}

function translationLanguageForLocale(locale: Locale): TranslationLanguage {
  return APP_LOCALE_TO_LANGUAGE[locale] ?? 'en'
}

type Script = 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic' | 'latin' | 'other'

const SCRIPT_PATTERNS: Array<[Exclude<Script, 'other'>, RegExp]> = [
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['han', /\p{Script=Han}/gu],
  ['hangul', /\p{Script=Hangul}/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['latin', /\p{Script=Latin}/gu],
]

/** The script with the most letters in `text`; kana wins over Han when present, since Japanese mixes both. */
export function detectDominantScript(text: string): Script {
  const counts = SCRIPT_PATTERNS.map(([script, pattern]) => [script, text.match(pattern)?.length ?? 0] as const)
  const kana = counts.find(([script]) => script === 'kana')?.[1] ?? 0
  if (kana > 0) return 'kana'
  const [best, count] = counts.reduce((top, entry) => (entry[1] > top[1] ? entry : top))
  return count > 0 ? best : 'other'
}

const ENGLISH_MARKERS = new Set(['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'with', 'are', 'this', 'on', 'be', 'as'])

function looksEnglish(text: string) {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? []
  if (words.length < 3) return false
  const hits = words.filter((word) => ENGLISH_MARKERS.has(word)).length
  return hits / words.length >= 0.12
}

/** Whether `text` already appears to be written in `language`. Cheap heuristics only; ambiguous cases return false. */
export function isTextInLanguage(text: string, language: TranslationLanguage) {
  const script = detectDominantScript(text)
  switch (language) {
    case 'zh-Hans':
    case 'zh-Hant':
      return script === 'han'
    case 'ja':
      return script === 'kana'
    case 'ko':
      return script === 'hangul'
    case 'ru':
      return script === 'cyrillic'
    case 'ar':
      return script === 'arabic'
    case 'en':
      return script === 'latin' && looksEnglish(text)
    default:
      // Latin-script languages other than English cannot be told apart cheaply.
      return false
  }
}

/**
 * Target for a translation: the explicit preference, else the app language.
 * When the text is already in that language, translate to the other side of
 * the common pair instead (Chinese for English, English for everything else).
 */
export function resolveTranslationTarget(input: {
  preference: TranslationTargetPreference
  appLocale: Locale
  text: string
}): TranslationLanguage {
  const base = input.preference === 'auto' ? translationLanguageForLocale(input.appLocale) : input.preference
  if (!isTextInLanguage(input.text, base)) return base
  return base === 'en' ? 'zh-Hans' : 'en'
}

/** Longest selection sent for translation, matching the other selection actions. */
export const MAX_TRANSLATION_CHARACTERS = 6000

export function buildTranslationMessages(text: string, target: TranslationLanguage) {
  const languageName = translationLanguageEnglishName(target)
  const system = [
    `You translate Markdown text into ${languageName} (${target}).`,
    'Return only the translation. No preamble, no explanation, no quotes, no code fence around the answer.',
    'Keep all Markdown syntax exactly: emphasis markers, list bullets, numbering, heading hashes, blockquote markers, tables, and line breaks.',
    'Translate link text but keep link URLs unchanged. Keep inline code, code blocks, file paths, URLs, and [[wikilink]] targets unchanged.',
    'Keep proper nouns and product names as they are unless they have an established translation.',
    'If the text is already in the target language, return it unchanged.',
  ].join('\n')
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: text },
  ]
}

/** Strips a code fence or quotes the model wrapped around the whole answer, and surrounding blank lines. */
export function cleanTranslationResult(raw: string, source: string) {
  let result = raw.replace(/^\s*\n|\n\s*$/g, '').trim()
  const fence = result.match(/^```[\w-]*\n([\s\S]*?)\n```$/)
  if (fence && !source.trim().startsWith('```')) result = fence[1]
  const quoted = result.match(/^(["“])([\s\S]*)(["”])$/)
  if (quoted && !/^["“]/.test(source.trim())) result = quoted[2]
  return result.trim()
}

/**
 * Translates `text` into `target`. Supplied by the workspace (it knows which
 * model is selected); the document feature only calls it. Rejects with
 * TranslationModelMissingError when no text model is configured.
 */
export type DocumentTranslateText = (
  text: string,
  target: TranslationLanguage,
  signal: AbortSignal,
) => Promise<string>

export class TranslationModelMissingError extends Error {
  constructor() {
    super('No text model is configured for translation.')
    this.name = 'TranslationModelMissingError'
  }
}

/** The hosted Kition account is not connected or the user declined to connect. */
export class TranslationAccountNotReadyError extends Error {
  constructor() {
    super('Connect your Kition account to translate with Kition Cloud models.')
    this.name = 'TranslationAccountNotReadyError'
  }
}

/** Everything the editor needs to offer translation; supplied by the workspace. */
export type DocumentTranslationSupport = {
  translateText: DocumentTranslateText
  /** Saved default target; `auto` follows the app language. */
  preference: TranslationTargetPreference
  onChangePreference: (target: TranslationLanguage) => void
  onConfigureModel?: () => void
}
