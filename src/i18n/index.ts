import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'

import enCommon from './locales/en-US/common.json'
import enSettings from './locales/en-US/settings.json'
import enWorkspace from './locales/en-US/workspace.json'
import enWorkspaceLauncher from './locales/en-US/workspaceLauncher.json'
import enAgent from './locales/en-US/agent.json'
import enDocument from './locales/en-US/document.json'
import enTable from './locales/en-US/table.json'
import enElectron from './locales/en-US/electron.json'
import enErrors from './locales/en-US/errors.json'
import enWorkflow from './locales/en-US/workflow.json'
import enConnections from './locales/en-US/connections.json'

import zhMetadata from './locales/zh-CN/metadata.json'

import { readStoredLocale, writeStoredLocale, detectBrowserLocale } from './storage'
import { loadLocaleResources } from './loadLocaleResources'
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  SUPPORTED_NAMESPACES,
  isSupportedLocale,
  resolveLocale,
  type Locale,
  type Namespace,
} from './types'

const resources = {
  'en-US': {
    common: enCommon,
    settings: enSettings,
    workspace: enWorkspace,
    workspaceLauncher: enWorkspaceLauncher,
    agent: enAgent,
    document: enDocument,
    table: enTable,
    electron: enElectron,
    errors: enErrors,
    workflow: enWorkflow,
    connections: enConnections,
  },
} as const

function pickInitialLocale(): Locale {
  return readStoredLocale() ?? detectBrowserLocale() ?? DEFAULT_LOCALE
}

function syncDocumentLang(locale: Locale) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

let initialized = false
const localeLoadPromises = new Map<Locale, Promise<void>>()

async function ensureLocaleLoaded(locale: Locale) {
  if (locale === DEFAULT_LOCALE || i18next.hasResourceBundle(locale, 'common')) {
    return
  }
  const existing = localeLoadPromises.get(locale)
  if (existing) return existing

  const loading = loadLocaleResources(locale).then((loadedResources) => {
    for (const namespace of SUPPORTED_NAMESPACES) {
      i18next.addResourceBundle(locale, namespace, loadedResources[namespace], true, true)
    }
  }).finally(() => {
    localeLoadPromises.delete(locale)
  })
  localeLoadPromises.set(locale, loading)
  return loading
}

export function ensureI18nInitialized(): I18nInstance {
  if (initialized) {
    return i18next
  }
  initialized = true

  const initialLocale = pickInitialLocale()

  i18next
    .use(initReactI18next)
    .init({
      resources,
      lng: initialLocale,
      fallbackLng: DEFAULT_LOCALE,
      defaultNS: 'common',
      ns: [...SUPPORTED_NAMESPACES],
      supportedLngs: [...SUPPORTED_LOCALES],
      interpolation: {
        escapeValue: false,
      },
      returnNull: false,
      react: {
        useSuspense: false,
      },
    })

  syncDocumentLang(initialLocale)

  return i18next
}

export function getCurrentLocale(): Locale {
  return resolveLocale(i18next.language)
}

const LOCALE_LANGUAGE_NAMES: Record<Locale, string> = {
  'en-US': 'English',
  'zh-CN': 'Simplified Chinese',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'pt-BR': 'Portuguese',
  'ru-RU': 'Russian',
}

const LOCALE_ENDONYMS: Record<Locale, string> = {
  'en-US': 'English',
  'zh-CN': zhMetadata.endonym,
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'pt-BR': 'Português (Brasil)',
  'ru-RU': 'Русский',
}

export function getLanguageNameForLocale(locale: Locale | string | null | undefined): string {
  return LOCALE_LANGUAGE_NAMES[resolveLocale(locale)]
}

export function getLocaleEndonym(locale: Locale): string {
  return LOCALE_ENDONYMS[locale]
}

export function setCurrentLocale(next: Locale | string | null | undefined) {
  const target = resolveLocale(next)
  writeStoredLocale(target)
  return ensureLocaleLoaded(target).then(async () => {
    if (i18next.language !== target) {
      await i18next.changeLanguage(target)
    }
    syncDocumentLang(target)
  })
}

export function getI18nInstance(): I18nInstance {
  return ensureI18nInitialized()
}

export { useTranslation }
export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  SUPPORTED_NAMESPACES,
  isSupportedLocale,
  resolveLocale,
}
export type { Locale, Namespace }

ensureI18nInitialized()

const initialLocale = getCurrentLocale()
export const i18nReady = ensureLocaleLoaded(initialLocale)
  .then(async () => {
    if (i18next.language !== initialLocale) {
      await i18next.changeLanguage(initialLocale)
    }
    syncDocumentLang(initialLocale)
    return i18next
  })
  .catch(async () => {
    await i18next.changeLanguage(DEFAULT_LOCALE)
    syncDocumentLang(DEFAULT_LOCALE)
    return i18next
  })

export default i18next
