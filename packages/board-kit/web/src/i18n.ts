import { createInstance, type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

/** The board editor's strings: Kition's own (`workspace`, `imageGeneration`, and `common` of every locale). */
const LOCALES = import.meta.glob<Record<string, unknown>>('../../../../src/i18n/locales/*/{workspace,imageGeneration,common}.json', { import: 'default' })
const NAMESPACES = ['workspace', 'imageGeneration', 'common'] as const

function available() {
  return [...new Set(Object.keys(LOCALES).map((file) => file.split('/').at(-2) ?? ''))].filter(Boolean)
}

/** The locale of the editor's strings for the host's `locale`: the same, the same language, or `en-US`. */
export function boardLocale(locale: string) {
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

/** An i18next instance for the board editor (it translates in the `workspace` namespace). */
export async function createBoardI18n(hostLocale: string): Promise<i18n> {
  const locale = boardLocale(hostLocale)
  const resources: Record<string, Record<string, Record<string, unknown>>> = { 'en-US': await load('en-US') }
  if (locale !== 'en-US') resources[locale] = await load(locale)
  const instance = createInstance()
  await instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en-US',
    defaultNS: 'workspace',
    ns: [...NAMESPACES],
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  })
  return instance
}
