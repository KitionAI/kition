import { beforeEach, describe, expect, it } from 'vitest'

import {
  appendAgentLocalSource,
  extractAgentLocalPathReference,
  readAgentLocalSourcesForWorkspace,
  writeAgentLocalSourcesForSession,
} from './agentLocalSources'

describe('agent local source persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps local paths device-local and scoped by workspace and session', () => {
    writeAgentLocalSourcesForSession('/workspaces/alpha', 7, [{
      id: 'source-project',
      label: 'project',
      root_path: '/Users/alice/code/project',
      access: 'read',
    }])

    expect(readAgentLocalSourcesForWorkspace('/workspaces/alpha')).toEqual({
      7: [{
        id: 'source-project',
        label: 'project',
        root_path: '/Users/alice/code/project',
        access: 'read',
      }],
    })
    expect(readAgentLocalSourcesForWorkspace('/workspaces/beta')).toEqual({})
  })

  it('removes the device-local grant when the session has no sources', () => {
    writeAgentLocalSourcesForSession('/workspaces/alpha', 7, [{
      id: 'source-project',
      label: 'project',
      root_path: '/home/test-user/project',
      access: 'read',
    }])
    writeAgentLocalSourcesForSession('/workspaces/alpha', 7, [])

    expect(readAgentLocalSourcesForWorkspace('/workspaces/alpha')).toEqual({})
  })
})

describe('agent local source prompt references', () => {
  it('detects relative, home, absolute, and Windows folder references', () => {
    const useContentFrom = String.fromCodePoint(0x8bf7, 0x6839, 0x636e)
    const contentInside = String.fromCodePoint(0x91cc, 0x7684, 0x5185, 0x5bb9, 0x751f, 0x6210, 0x6587, 0x6863)
    const analyze = String.fromCodePoint(0x5206, 0x6790)
    const localizedFolder = String.fromCodePoint(0x9879, 0x76ee, 0x8d44, 0x6599)
    const documentsInside = String.fromCodePoint(0x91cc, 0x7684, 0x6587, 0x6863)
    expect(extractAgentLocalPathReference('Analyze ../kition and write a report')).toBe('../kition')
    expect(extractAgentLocalPathReference(`${useContentFrom}../kition${contentInside}`)).toBe('../kition')
    expect(extractAgentLocalPathReference(`${analyze}../${localizedFolder}${documentsInside}`)).toBe(`../${localizedFolder}`)
    expect(extractAgentLocalPathReference('Read ~/Projects/example first')).toBe('~/Projects/example')
    expect(extractAgentLocalPathReference('Inspect /opt/example/docs.')).toBe('/opt/example/docs')
    expect(extractAgentLocalPathReference('Use C:\\Projects\\example')).toBe('C:\\Projects\\example')
  })

  it('does not mistake a web URL for a local path', () => {
    expect(extractAgentLocalPathReference('Publish this on https://x.com/example')).toBe('')
  })

  it('deduplicates attached folders by their real path', () => {
    const source = {
      id: 'source-project',
      label: 'project',
      root_path: '/example/project',
      access: 'read' as const,
    }
    expect(appendAgentLocalSource([source], { ...source, id: 'source-duplicate' })).toEqual([source])
  })
})
