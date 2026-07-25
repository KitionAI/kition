import { AppWindow, ExternalLink, Globe, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { dispatchOpenWorkspaceBrowserTab } from '@/features/workspace/lib/browserTabs'
import { formatWorkspaceTime } from '@/features/workspace/lib/workspace'
import { cn } from '@/lib/utils'
import {
  forgetBrowserSite,
  listBrowserSites,
  refreshBrowserSiteLoginStatus,
  type BrowserSite,
} from '@/services/desktop'

export function WorkspaceBrowserSitesPanel() {
  const { t } = useTranslation('workspace')
  const [sites, setSites] = useState<BrowserSite[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const result = await listBrowserSites()
        if (!cancelled) {
          setSites(result.sites)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const result = await refreshBrowserSiteLoginStatus({})
      setSites(result.sites)
    } finally {
      setRefreshing(false)
    }
  }, [])

  const handleForget = useCallback(
    async (site: BrowserSite) => {
      const result = await forgetBrowserSite({ host: site.host, profile_id: site.profileId })
      setSites(result.sites)
    },
    [],
  )

  const handleOpen = useCallback((site: BrowserSite) => {
    dispatchOpenWorkspaceBrowserTab({
      provider: site.provider,
      host: site.host,
      url: site.url || `https://${site.host}`,
      profile_id: site.profileId,
      activate: true,
    })
  }, [])

  const handleOpenNewTab = useCallback(() => {
    dispatchOpenWorkspaceBrowserTab({ provider: 'generic-web', activate: true })
  }, [])

  return (
    <div className="workspace-browser-sites-panel">
      <div className="workspace-browser-sites-header">
        <span className="workspace-browser-sites-icon">
          <Globe className="size-5" />
        </span>
        <span className="min-w-0">
          <h2>{t('browserSites.title')}</h2>
          <p>{t('browserSites.visitedCount', { count: sites.length })}</p>
        </span>
        <div className="workspace-browser-sites-header-actions">
          <button
            type="button"
            className="workspace-browser-sites-open"
            onClick={handleOpenNewTab}
            title={t('browserSites.openBrowserTitle')}
          >
            <AppWindow className="size-4" />
            <span>{t('browserSites.openBrowser')}</span>
          </button>
          <button
            type="button"
            className="workspace-browser-sites-refresh"
            onClick={() => void handleRefresh()}
            disabled={refreshing || loading}
            title={t('browserSites.refreshLoginStatus')}
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            <span>{t('browserSites.refreshLoginStatus')}</span>
          </button>
        </div>
      </div>
      {loading ? (
        <div className="workspace-browser-sites-empty">
          <p>{t('browserSites.loading')}</p>
        </div>
      ) : sites.length ? (
        <ul className="workspace-browser-sites-list">
          {sites.map((site) => (
            <li key={`${site.profileId}::${site.host}`} className="workspace-browser-sites-row">
              <span className="workspace-browser-sites-favicon">
                {site.favicon ? (
                  <img
                    alt=""
                    src={site.favicon}
                    onError={(event) => {
                      event.currentTarget.style.display = 'none'
                    }}
                  />
                ) : (
                  <Globe className="size-4" />
                )}
              </span>
              <span className="workspace-browser-sites-meta">
                <strong>{site.title || site.host}</strong>
                <small>{site.host}</small>
                <small>{t('browserSites.lastVisited', { time: formatWorkspaceTime(site.lastSeenAt) })}</small>
              </span>
              <span
                className={cn(
                  'workspace-browser-sites-badge',
                  site.loggedIn
                    ? 'workspace-browser-sites-badge--in'
                    : 'workspace-browser-sites-badge--out',
                )}
              >
                {site.loggedIn ? t('browserSites.signedIn') : t('browserSites.signedOut')}
              </span>
              <span className="workspace-browser-sites-actions">
                <button
                  type="button"
                  onClick={() => handleOpen(site)}
                  title={t('browserSites.openSite')}
                  aria-label={t('browserSites.open', { host: site.host })}
                >
                  <ExternalLink className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleForget(site)}
                  title={t('browserSites.forgetSite')}
                  aria-label={t('browserSites.forget', { host: site.host })}
                >
                  <Trash2 className="size-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="workspace-browser-sites-empty">
          <h3>{t('browserSites.emptyTitle')}</h3>
          <p>{t('browserSites.emptyDescription')}</p>
        </div>
      )}
    </div>
  )
}
