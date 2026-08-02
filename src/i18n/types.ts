export const SUPPORTED_LOCALES = ['en-US', 'zh-CN', 'es-ES', 'fr-FR', 'pt-BR', 'ru-RU'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en-US'

export const SUPPORTED_NAMESPACES = [
  'common',
  'settings',
  'workspace',
  'workspaceLauncher',
  'agent',
  'document',
  'table',
  'electron',
  'errors',
  'workflow',
  'connections',
] as const

export type Namespace = (typeof SUPPORTED_NAMESPACES)[number]

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function resolveLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  return isSupportedLocale(value) ? value : fallback
}
