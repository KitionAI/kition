import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

/**
 * The document editor's strings: Kition's own (`document` and `common` of every locale). The
 * editor's CodeMirror extensions translate through the global i18next instance, so this
 * initialises that one.
 */
const LOCALES = import.meta.glob<Record<string, unknown>>('../../../../src/i18n/locales/*/{document,common}.json', { import: 'default' })
const NAMESPACES = ['document', 'common'] as const

function available() {
  return [...new Set(Object.keys(LOCALES).map((file) => file.split('/').at(-2) ?? ''))].filter(Boolean)
}

/** The locale of the editor's strings for the host's `locale`: the same, the same language, or `en-US`. */
export function documentLocale(locale: string) {
  const locales = available()
  if (locales.includes(locale)) return locale
  const language = locale.split('-')[0]
  return locales.find((candidate) => candidate.split('-')[0] === language) ?? 'en-US'
}

async function load(locale: string) {
  const resources: Record<string, Record<string, unknown>> = {}
  for (const namespace of NAMESPACES) {
    const file = LOCALES[`../../../../src/i18n/locales/${locale}/${namespace}.json`]
    if (file) resources[namespace] = await file()
  }
  return resources
}

/** Initialises the global i18next instance for the document editor (it translates in the `document` namespace). */
export async function startDocumentI18n(hostLocale: string): Promise<i18n> {
  const locale = documentLocale(hostLocale)
  const resources: Record<string, Record<string, Record<string, unknown>>> = { 'en-US': await load('en-US') }
  if (locale !== 'en-US') resources[locale] = await load(locale)
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en-US',
    defaultNS: 'document',
    ns: [...NAMESPACES],
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  })
  return i18next
}
