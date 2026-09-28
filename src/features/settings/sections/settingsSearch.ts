/**
 * The settings sidebar search: each section's haystack is its label plus
 * every translated string of its pane, and provider names from the code
 * catalogs. Filtering is pure so the sidebar rules are testable.
 */
import type { i18n as I18n, TFunction } from 'i18next'

import { emailProviderCatalog } from '@/features/emailProviders/public'
import {
  advancedSettingsSections,
  primarySettingsSections,
  settingsSectionContentSources,
  settingsSections,
  type SettingsSectionDefinition,
  type SettingsSectionKey,
} from '@/features/settings/sections/sectionRegistry'
import { desktopProviderCatalog } from '@/services/desktopSettings'

function collectSearchableStrings(node: unknown, out: string[]) {
  if (typeof node === 'string') {
    out.push(node)
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectSearchableStrings(value, out)
    }
  }
}

export type SettingsSearchIndex = ReadonlyMap<SettingsSectionKey, string>

export function buildSettingsSearchIndex(t: TFunction, i18n: Pick<I18n, 'language' | 'getResourceBundle'>): SettingsSearchIndex {
  const map = new Map<SettingsSectionKey, string>()
  for (const section of settingsSections) {
    const parts: string[] = [t(`sections.${section.key}.label`)]
    for (const source of settingsSectionContentSources[section.key]) {
      const bundle = i18n.getResourceBundle(i18n.language, source.ns)
      collectSearchableStrings(source.path ? bundle?.[source.path] : bundle, parts)
    }
    if (section.key === 'models') {
      for (const provider of desktopProviderCatalog) {
        parts.push(provider.label, provider.sublabel, provider.descriptor, provider.badge, provider.authLabel)
      }
    }
    if (section.key === 'connections') {
      for (const provider of emailProviderCatalog) {
        parts.push(provider.label, provider.credentialLabel, provider.credentialHint)
      }
    }
    map.set(section.key, parts.join(' ').toLowerCase())
  }
  return map
}

export type VisibleSettingsSections = {
  main: SettingsSectionDefinition[]
  about: SettingsSectionDefinition | undefined
  advanced: SettingsSectionDefinition[]
}

/**
 * Sections that match `query` (already trimmed and lower-cased). A query that
 * matches the Advanced group label shows every advanced section.
 */
export function filterSettingsSections(query: string, index: SettingsSearchIndex, advancedLabel: string): VisibleSettingsSections {
  const matches = (section: SettingsSectionDefinition) => (index.get(section.key) ?? '').includes(query)
  const primary = query ? primarySettingsSections.filter(matches) : primarySettingsSections
  const advancedLabelMatches = Boolean(query && advancedLabel.toLowerCase().includes(query))
  const advanced = query && !advancedLabelMatches ? advancedSettingsSections.filter(matches) : advancedSettingsSections
  return {
    main: primary.filter((section) => section.key !== 'about'),
    about: primary.find((section) => section.key === 'about'),
    advanced,
  }
}
