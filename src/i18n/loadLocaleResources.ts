import {
  SUPPORTED_NAMESPACES,
  type Locale,
  type Namespace,
} from './types'

type LocaleResource = Record<string, unknown>
type LocaleResources = Record<Namespace, LocaleResource>
type LocaleModule = { default: LocaleResource }

const localeModules = import.meta.glob<LocaleModule>([
  './locales/*/*.json',
  '!./locales/en-US/*.json',
  '!./locales/*/metadata.json',
])

export async function loadLocaleResources(locale: Locale): Promise<LocaleResources> {
  const entries = await Promise.all(SUPPORTED_NAMESPACES.map(async (namespace) => {
    const modulePath = `./locales/${locale}/${namespace}.json`
    const loadModule = localeModules[modulePath]
    if (!loadModule) {
      throw new Error(`missing locale resource: ${modulePath}`)
    }
    const module = await loadModule()
    return [namespace, module.default] as const
  }))

  return Object.fromEntries(entries) as LocaleResources
}
