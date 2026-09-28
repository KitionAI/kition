import { describe, expect, it } from 'vitest'

import { appLocationPathname, leaveAppView, normalizeAppPathname, parseAppLocation, resolveSettingsSection } from './appLocation'

describe('resolveSettingsSection', () => {
  it('keeps legacy provider links pointed at the models pane', () => {
    expect(resolveSettingsSection('providers')).toBe('models')
    expect(resolveSettingsSection('ai-providers')).toBe('models')
    expect(resolveSettingsSection('email-providers')).toBe('connections')
  })

  it('keeps old demo and advanced links pointed at their new parent panes', () => {
    expect(resolveSettingsSection('demos')).toBe('general')
    expect(resolveSettingsSection('advanced')).toBe('developer')
    expect(resolveSettingsSection('runtime')).toBe('runtime')
    expect(resolveSettingsSection('shortcuts')).toBe('general')
  })

  it('falls back to general for unknown or non-string sections', () => {
    expect(resolveSettingsSection('missing')).toBe('general')
    expect(resolveSettingsSection(null)).toBe('general')
  })
})

describe('normalizeAppPathname', () => {
  it('keeps the served routes and returns removed ones to the documents workspace', () => {
    expect(normalizeAppPathname('/')).toBe('/documents')
    expect(normalizeAppPathname('/workflow/new')).toBe('/workflow/new')
    expect(normalizeAppPathname('/settings')).toBe('/settings')
    expect(normalizeAppPathname('/writing/wechat_article')).toBe('/documents')
    expect(normalizeAppPathname('/image')).toBe('/documents')
  })
})

describe('parseAppLocation', () => {
  it('reads the settings section from the query', () => {
    expect(parseAppLocation({ pathname: '/settings', search: '?section=providers', state: null }))
      .toEqual({ view: 'settings', section: 'models' })
    expect(parseAppLocation({ pathname: '/settings', search: '', state: null }))
      .toEqual({ view: 'settings', section: 'general' })
  })

  it('keeps the workflow sub-path and takes its context from history state when complete', () => {
    const context = { documentId: 'd1', tableId: 't1', tableName: 'Leads' }
    expect(parseAppLocation({ pathname: '/workflow/new', search: '', state: { workflowContext: context } }))
      .toEqual({ view: 'workflow', pathname: '/workflow/new', context })
    expect(parseAppLocation({ pathname: '/workflow', search: '', state: { workflowContext: { documentId: 'd1' } } }))
      .toEqual({ view: 'workflow', pathname: '/workflow', context: null })
    expect(parseAppLocation({ pathname: '/workflow', search: '', state: null }).view).toBe('workflow')
  })

  it('sends unknown and root paths to the documents workspace', () => {
    expect(parseAppLocation({ pathname: '/', search: '', state: null })).toEqual({ view: 'documents' })
    expect(parseAppLocation({ pathname: '/image', search: '?section=models', state: null })).toEqual({ view: 'documents' })
    expect(parseAppLocation({ pathname: '/scenario', search: '', state: null })).toEqual({ view: 'scenario' })
  })
})

describe('appLocationPathname', () => {
  it('round-trips each view', () => {
    for (const pathname of ['/documents', '/settings', '/scenario', '/workflow/new']) {
      expect(appLocationPathname(parseAppLocation({ pathname, search: '', state: null }))).toBe(pathname)
    }
  })
})

describe('leaveAppView', () => {
  it('returns to the documents workspace only when the URL names that view', () => {
    window.history.replaceState({ keep: true }, '', '/settings?section=models')
    leaveAppView('scenario')
    expect(window.location.pathname).toBe('/settings')
    leaveAppView('settings')
    expect(window.location.pathname).toBe('/documents')
    expect(window.history.state).toEqual({ keep: true })
  })
})
