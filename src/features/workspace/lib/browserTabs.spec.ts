import { describe, expect, it } from 'vitest'

import {
  applyWorkspaceBrowserSessionSnapshot,
  buildWorkspaceBrowserTabId,
  buildWorkspaceBrowserTabTitle,
  doesWorkspaceBrowserTabMatchSnapshot,
  findLinkedWorkspaceTabIds,
  findWorkspaceBrowserTabIdsForSnapshot,
  resolveWorkspaceBrowserTabOrigin,
  resolveWorkspaceBrowserTabNavigationURL,
  resolveWorkspaceBrowserHost,
} from './browserTabs'

describe('workspace browser tab utilities', () => {
  it('normalizes browser hosts from host and url inputs', () => {
    expect(resolveWorkspaceBrowserHost({ host: 'www.X.com' })).toBe('x.com')
    expect(
      resolveWorkspaceBrowserHost({
        url: 'https://www.youtube.com/results?search_query=test',
      }),
    ).toBe('youtube.com')
  })

  it('builds stable browser tab ids from normalized hosts', () => {
    expect(
      buildWorkspaceBrowserTabId({
        provider: 'generic-web',
        url: 'https://www.youtube.com/',
      }),
    ).toBe('browser:generic-web:youtube.com')
  })

  it('builds distinct browser tab ids for different origin tables on the same host', () => {
    expect(
      buildWorkspaceBrowserTabId({
        provider: 'generic-web',
        url: 'https://www.youtube.com/',
        origin_tab_id: 'document:Untitled table 9.kitable',
      }),
    ).toBe(
      'browser:generic-web:youtube.com:document:Untitled table 9.kitable',
    )
  })

  it('builds distinct browser tab ids for different hosts from the same origin table', () => {
    expect(
      buildWorkspaceBrowserTabId({
        provider: 'generic-web',
        url: 'https://www.youtube.com/',
        origin_tab_id: 'document:travel.kitable',
      }),
    ).not.toBe(
      buildWorkspaceBrowserTabId({
        provider: 'generic-web',
        url: 'https://www.tiktok.com/',
        origin_tab_id: 'document:travel.kitable',
      }),
    )
  })

  it('fills missing browser tab origin metadata from the current table context', () => {
    expect(
      resolveWorkspaceBrowserTabOrigin(
        {
          provider: 'generic-web',
          url: 'https://www.youtube.com/',
        },
        {
          documentPath: 'travel.kitable',
          tableId: 42,
          originLabel: 'Travel Leads',
        },
      ),
    ).toEqual({
      originDocumentPath: 'travel.kitable',
      originTabId: 'document:travel.kitable',
      originLabel: 'Travel Leads',
      originTableId: 42,
    })
  })

  it('builds explicit browser tab titles instead of bare page titles', () => {
    expect(
      buildWorkspaceBrowserTabTitle({
        provider: 'generic-web',
        url: 'https://www.youtube.com/',
        query: 'Sanya Travel',
        title: 'Home',
        origin_label: 'Untitled table 9',
      }),
    ).toBe('youtube.com · Untitled table 9 · Sanya Travel · Home')
  })

  it('strips repeated web prefixes from restored browser tab titles', () => {
    expect(
      buildWorkspaceBrowserTabTitle({
        provider: 'generic-web',
        title: '[Web] [Web] [Web] youtube.com · Home',
      }),
    ).toBe('youtube.com · Home')
  })

  it('prefers the saved tab url when restoring a browser tab', () => {
    expect(
      resolveWorkspaceBrowserTabNavigationURL({
        tabURL: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A',
        liveURL: 'https://www.tiktok.com/search?q=sanya',
      }),
    ).toBe(
      'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A',
    )
  })

  it('matches browser tabs by provider and resolved host', () => {
    const tab = {
      id: 'browser:generic-web:youtube.com',
      type: 'browser' as const,
      title: 'YouTube · Sanya Travel',
      provider: 'generic-web' as const,
      host: 'youtube.com',
      url: 'https://www.youtube.com/',
    }

    expect(
      doesWorkspaceBrowserTabMatchSnapshot(tab, {
        provider: 'generic-web',
        url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A',
      }),
    ).toBe(true)
    expect(
      doesWorkspaceBrowserTabMatchSnapshot(tab, {
        provider: 'generic-web',
        url: 'https://x.com/home',
      }),
    ).toBe(false)
  })

  it('matches browser tabs by exact url before falling back to host', () => {
    const tab = {
      id: 'browser:generic-web:youtube.com:document:travel.kitable',
      type: 'browser' as const,
      title: '[Web] youtube.com · Travel Leads · Sanya Travel',
      provider: 'generic-web' as const,
      host: 'youtube.com',
      url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
    }

    expect(
      doesWorkspaceBrowserTabMatchSnapshot(tab, {
        provider: 'generic-web',
        url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8#hash',
      }),
    ).toBe(true)
  })

  it('falls back to the only provider tab when snapshot host is unavailable', () => {
    const tabs = [
      {
        id: 'browser:generic-web:youtube.com',
        type: 'browser' as const,
        title: 'YouTube',
        provider: 'generic-web' as const,
        host: 'youtube.com',
        url: 'https://www.youtube.com/',
      },
    ]

    expect(
      findWorkspaceBrowserTabIdsForSnapshot(tabs, {
        provider: 'generic-web',
        title: 'Search results',
      }),
    ).toEqual(['browser:generic-web:youtube.com'])
  })

  it('does not fan out host-only snapshot updates across multiple tabs on the same host', () => {
    const tabs = [
      {
        id: 'browser:generic-web:youtube.com:document:travel-a.kitable',
        type: 'browser' as const,
        title: '[Web] youtube.com · Travel A · Sanya Travel',
        provider: 'generic-web' as const,
        host: 'youtube.com',
        url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
      },
      {
        id: 'browser:generic-web:youtube.com:document:travel-b.kitable',
        type: 'browser' as const,
        title: '[Web] youtube.com · Travel B · Sanya Hotels',
        provider: 'generic-web' as const,
        host: 'youtube.com',
        url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A%E9%85%92%E5%BA%97',
      },
    ]

    expect(
      findWorkspaceBrowserTabIdsForSnapshot(tabs, {
        provider: 'generic-web',
        title: 'Search results',
        url: 'https://www.youtube.com/',
      }),
    ).toEqual([])
  })

  it('applies browser session snapshots onto tab state', () => {
    const tab = {
      id: 'browser:generic-web:youtube.com',
      type: 'browser' as const,
      title: 'YouTube · Sanya Travel',
      provider: 'generic-web' as const,
      host: 'youtube.com',
      url: 'https://www.youtube.com/',
    }

    expect(
      applyWorkspaceBrowserSessionSnapshot(tab, {
        provider: 'generic-web',
        title: 'Search results',
        url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A',
        query: 'Sanya Travel',
        origin_label: 'Untitled table 9',
      }),
    ).toMatchObject({
      host: 'youtube.com',
      query: 'Sanya Travel',
      title: 'youtube.com · Untitled table 9 · Sanya Travel · Search results',
      url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A',
    })
  })

  it('finds linked source table tab when a browser tab is active', () => {
    expect(
      findLinkedWorkspaceTabIds([
        {
          id: 'document:travel.kitable',
          type: 'document',
          title: 'Travel Leads',
          path: 'travel.kitable',
          format: 'data',
        },
        {
          id: 'browser:generic-web:youtube.com:document:travel.kitable',
          type: 'browser',
          title: '[Web] youtube.com · Travel Leads · Home',
          provider: 'generic-web',
          host: 'youtube.com',
          originTabId: 'document:travel.kitable',
        },
      ], 'browser:generic-web:youtube.com:document:travel.kitable'),
    ).toEqual(['document:travel.kitable'])
  })

  it('finds linked browser tabs when a source table tab is active', () => {
    expect(
      findLinkedWorkspaceTabIds([
        {
          id: 'document:travel.kitable',
          type: 'document',
          title: 'Travel Leads',
          path: 'travel.kitable',
          format: 'data',
        },
        {
          id: 'browser:generic-web:youtube.com:document:travel.kitable',
          type: 'browser',
          title: '[Web] youtube.com · Travel Leads · Home',
          provider: 'generic-web',
          host: 'youtube.com',
          originTabId: 'document:travel.kitable',
        },
        {
          id: 'browser:generic-web:tiktok.com:document:other.kitable',
          type: 'browser',
          title: '[Web] tiktok.com · Other Table · Home',
          provider: 'generic-web',
          host: 'tiktok.com',
          originTabId: 'document:other.kitable',
        },
      ], 'document:travel.kitable'),
    ).toEqual(['browser:generic-web:youtube.com:document:travel.kitable'])
  })
})
