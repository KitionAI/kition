import { Bot, CircleUserRound, Database, Info, Mail, Monitor, Network, Palette, Settings, SlidersHorizontal } from 'lucide-react'

/** The settings sections in sidebar order, with where each one's searchable copy lives. */
export const settingsSections = [
  { key: 'general', icon: Settings, group: 'primary' },
  { key: 'account', icon: CircleUserRound, group: 'primary' },
  { key: 'models', icon: Bot, group: 'primary' },
  { key: 'connections', icon: Mail, group: 'primary' },
  { key: 'display', icon: Monitor, group: 'primary' },
  { key: 'brand', icon: Palette, group: 'primary' },
  { key: 'network', icon: Network, group: 'advanced' },
  { key: 'runtime', icon: Database, group: 'advanced' },
  { key: 'developer', icon: SlidersHorizontal, group: 'advanced' },
  { key: 'about', icon: Info, group: 'primary' },
] as const

export const primarySettingsSections = settingsSections.filter((section) => section.group === 'primary')
export const advancedSettingsSections = settingsSections.filter((section) => section.group === 'advanced')

export type SettingsSectionKey = typeof settingsSections[number]['key']
export type SettingsSectionDefinition = typeof settingsSections[number]

// Where each section's searchable field labels/descriptions live in the i18n
// resources. Most panes read from the same-named path under the `settings`
// namespace, but some pull in extra subtrees (general also renders `language`,
// namespace, while connections has its own top-level namespace.
export const settingsSectionContentSources: Record<SettingsSectionKey, Array<{ ns: string; path?: string }>> = {
  general: [{ ns: 'settings', path: 'general' }, { ns: 'settings', path: 'language' }],
  account: [{ ns: 'settings', path: 'account' }],
  models: [{ ns: 'settings', path: 'models' }],
  connections: [{ ns: 'connections' }],
  display: [{ ns: 'settings', path: 'display' }],
  brand: [{ ns: 'settings', path: 'brand' }],
  network: [{ ns: 'settings', path: 'network' }],
  runtime: [{ ns: 'settings', path: 'runtime' }],
  developer: [{ ns: 'settings', path: 'developer' }],
  about: [{ ns: 'settings', path: 'about' }],
}
