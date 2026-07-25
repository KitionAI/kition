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

import esCommon from './locales/es-ES/common.json'
import esSettings from './locales/es-ES/settings.json'
import esWorkspace from './locales/es-ES/workspace.json'
import esWorkspaceLauncher from './locales/es-ES/workspaceLauncher.json'
import esAgent from './locales/es-ES/agent.json'
import esDocument from './locales/es-ES/document.json'
import esTable from './locales/es-ES/table.json'
import esElectron from './locales/es-ES/electron.json'
import esErrors from './locales/es-ES/errors.json'
import esWorkflow from './locales/es-ES/workflow.json'
import esConnections from './locales/es-ES/connections.json'

import frCommon from './locales/fr-FR/common.json'
import frSettings from './locales/fr-FR/settings.json'
import frWorkspace from './locales/fr-FR/workspace.json'
import frWorkspaceLauncher from './locales/fr-FR/workspaceLauncher.json'
import frAgent from './locales/fr-FR/agent.json'
import frDocument from './locales/fr-FR/document.json'
import frTable from './locales/fr-FR/table.json'
import frElectron from './locales/fr-FR/electron.json'
import frErrors from './locales/fr-FR/errors.json'
import frWorkflow from './locales/fr-FR/workflow.json'
import frConnections from './locales/fr-FR/connections.json'

import ptCommon from './locales/pt-BR/common.json'
import ptSettings from './locales/pt-BR/settings.json'
import ptWorkspace from './locales/pt-BR/workspace.json'
import ptWorkspaceLauncher from './locales/pt-BR/workspaceLauncher.json'
import ptAgent from './locales/pt-BR/agent.json'
import ptDocument from './locales/pt-BR/document.json'
import ptTable from './locales/pt-BR/table.json'
import ptElectron from './locales/pt-BR/electron.json'
import ptErrors from './locales/pt-BR/errors.json'
import ptWorkflow from './locales/pt-BR/workflow.json'
import ptConnections from './locales/pt-BR/connections.json'

import ruCommon from './locales/ru-RU/common.json'
import ruSettings from './locales/ru-RU/settings.json'
import ruWorkspace from './locales/ru-RU/workspace.json'
import ruWorkspaceLauncher from './locales/ru-RU/workspaceLauncher.json'
import ruAgent from './locales/ru-RU/agent.json'
import ruDocument from './locales/ru-RU/document.json'
import ruTable from './locales/ru-RU/table.json'
import ruElectron from './locales/ru-RU/electron.json'
import ruErrors from './locales/ru-RU/errors.json'
import ruWorkflow from './locales/ru-RU/workflow.json'
import ruConnections from './locales/ru-RU/connections.json'

import { readStoredLocale, writeStoredLocale, detectBrowserLocale } from './storage'
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
  'es-ES': {
    common: esCommon,
    settings: esSettings,
    workspace: esWorkspace,
    workspaceLauncher: esWorkspaceLauncher,
    agent: esAgent,
    document: esDocument,
    table: esTable,
    electron: esElectron,
    errors: esErrors,
    workflow: esWorkflow,
    connections: esConnections,
  },
  'fr-FR': {
    common: frCommon,
    settings: frSettings,
    workspace: frWorkspace,
    workspaceLauncher: frWorkspaceLauncher,
    agent: frAgent,
    document: frDocument,
    table: frTable,
    electron: frElectron,
    errors: frErrors,
    workflow: frWorkflow,
    connections: frConnections,
  },
  'pt-BR': {
    common: ptCommon,
    settings: ptSettings,
    workspace: ptWorkspace,
    workspaceLauncher: ptWorkspaceLauncher,
    agent: ptAgent,
    document: ptDocument,
    table: ptTable,
    electron: ptElectron,
    errors: ptErrors,
    workflow: ptWorkflow,
    connections: ptConnections,
  },
  'ru-RU': {
    common: ruCommon,
    settings: ruSettings,
    workspace: ruWorkspace,
    workspaceLauncher: ruWorkspaceLauncher,
    agent: ruAgent,
    document: ruDocument,
    table: ruTable,
    electron: ruElectron,
    errors: ruErrors,
    workflow: ruWorkflow,
    connections: ruConnections,
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
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'pt-BR': 'Portuguese',
  'ru-RU': 'Russian',
}

export function getLanguageNameForLocale(locale: Locale | string | null | undefined): string {
  return LOCALE_LANGUAGE_NAMES[resolveLocale(locale)]
}

export function setCurrentLocale(next: Locale | string | null | undefined) {
  const target = resolveLocale(next)
  if (i18next.language === target) {
    return
  }
  writeStoredLocale(target)
  void i18next.changeLanguage(target)
  syncDocumentLang(target)
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

export default i18next
