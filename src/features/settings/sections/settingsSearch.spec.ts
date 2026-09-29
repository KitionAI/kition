import { describe, expect, it } from 'vitest'

import { buildSettingsSearchIndex, filterSettingsSections } from './settingsSearch'

const bundles: Record<string, Record<string, unknown>> = {
  settings: {
    general: { theme: { title: 'Theme', dark: 'Dark mode' } },
    language: { label: 'Language' },
    display: { zoom: 'Zoom level' },
    network: { proxy: 'HTTP proxy' },
    runtime: { logs: 'Runtime logs' },
    developer: { analytics: 'Analytics inspector' },
    about: { version: 'Version' },
    account: { signIn: 'Sign in' },
    models: { title: 'Models' },
  },
  connections: { title: 'Email connections' },
}
const t = ((key: string) => key.replace('sections.', '').replace('.label', ' label')) as never
const i18n = { language: 'en-US', getResourceBundle: (_lng: string, ns: string) => bundles[ns] }

describe('settings search', () => {
  const index = buildSettingsSearchIndex(t, i18n)

  it('indexes each section from its label and pane strings, plus the provider catalogs', () => {
    expect(index.get('general')).toContain('dark mode')
    expect(index.get('general')).toContain('language')
    expect(index.get('models')).toContain('openai')
    expect(index.get('connections')).toContain('email connections')
  })

  it('shows every section without a query and keeps About separate from the main list', () => {
    const visible = filterSettingsSections('', index, 'Advanced')
    expect(visible.main.map((section) => section.key)).toEqual(['general', 'account', 'models', 'connections', 'display', 'brand'])
    expect(visible.about?.key).toBe('about')
    expect(visible.advanced.map((section) => section.key)).toEqual(['network', 'runtime', 'developer'])
  })

  it('filters by pane text and reveals every advanced section when the group label matches', () => {
    const proxy = filterSettingsSections('proxy', index, 'Advanced')
    expect(proxy.main).toEqual([])
    expect(proxy.about).toBeUndefined()
    expect(proxy.advanced.map((section) => section.key)).toEqual(['network'])

    const group = filterSettingsSections('qqgroup', index, 'Qqgroup')
    expect(group.advanced.map((section) => section.key)).toEqual(['network', 'runtime', 'developer'])
    expect(group.main).toEqual([])
  })
})
