import fs from 'node:fs/promises'
import path from 'node:path'

const registryFileName = 'browser-sites.json'
const flushDebounceMs = 800
const maxFaviconLength = 4096

function normalizeProfileId(value) {
  const trimmed = String(value || '').trim()
  return trimmed || 'default'
}

function normalizeHost(value) {
  const trimmed = String(value || '').trim().toLowerCase()
  if (!trimmed) {
    return ''
  }
  const rawHost = trimmed.replace(/^https?:\/\//, '').split('/')[0] || ''
  return rawHost.replace(/^www\./, '')
}

function resolveHost(host, url) {
  const explicit = normalizeHost(host)
  if (explicit) {
    return explicit
  }
  const rawURL = String(url || '').trim()
  if (!rawURL) {
    return ''
  }
  try {
    return normalizeHost(new URL(rawURL).hostname)
  } catch {
    return ''
  }
}

function isTrackableURL(url) {
  return /^https?:\/\//i.test(String(url || '').trim())
}

function recordKey(host, profileId) {
  return `${normalizeProfileId(profileId)}::${normalizeHost(host)}`
}

// Persists the set of sites the user has used inside the embedded browser, plus
// a best-effort login flag. Metadata only — no cookie values or credentials are
// ever written here; the live session stays in the Chromium partition.
export class BrowserSiteRegistry {
  constructor(desktopEnv) {
    const dataDir = desktopEnv?.data_dir || process.cwd()
    this.filePath = path.join(dataDir, registryFileName)
    this.sites = new Map()
    this.loaded = false
    this.flushTimer = null
    this.flushing = null
  }

  async load() {
    if (this.loaded) {
      return
    }
    this.loaded = true
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const records = Array.isArray(parsed?.sites) ? parsed.sites : []
      for (const record of records) {
        const host = normalizeHost(record?.host)
        if (!host) {
          continue
        }
        const profileId = normalizeProfileId(record?.profileId)
        this.sites.set(recordKey(host, profileId), {
          host,
          profileId,
          url: String(record?.url || ''),
          title: String(record?.title || ''),
          favicon: String(record?.favicon || ''),
          provider: String(record?.provider || 'generic-web'),
          firstSeenAt: String(record?.firstSeenAt || record?.lastSeenAt || ''),
          lastSeenAt: String(record?.lastSeenAt || ''),
          visitCount: Number(record?.visitCount) || 0,
          loggedIn: Boolean(record?.loggedIn),
          lastCheckedAt: String(record?.lastCheckedAt || ''),
        })
      }
    } catch {
      // Missing or corrupt registry — start empty, never block browsing.
      this.sites.clear()
    }
  }

  scheduleFlush() {
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, flushDebounceMs)
  }

  async flush() {
    if (this.flushing) {
      return this.flushing
    }
    const payload = JSON.stringify({ version: 1, sites: this.listSites() }, null, 2)
    this.flushing = fs
      .writeFile(this.filePath, payload, 'utf8')
      .catch(() => {
        // Best-effort persistence; ignore write errors.
      })
      .finally(() => {
        this.flushing = null
      })
    return this.flushing
  }

  async flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  upsertVisit({ host, url, title, provider, profileId } = {}) {
    if (!isTrackableURL(url) && !normalizeHost(host)) {
      return null
    }
    const resolvedHost = resolveHost(host, url)
    if (!resolvedHost) {
      return null
    }
    const normalizedProfileId = normalizeProfileId(profileId)
    const key = recordKey(resolvedHost, normalizedProfileId)
    const now = new Date().toISOString()
    const existing = this.sites.get(key)
    const next = {
      host: resolvedHost,
      profileId: normalizedProfileId,
      url: isTrackableURL(url) ? String(url) : existing?.url || '',
      title: String(title || '').trim() || existing?.title || '',
      favicon: existing?.favicon || '',
      provider: String(provider || existing?.provider || 'generic-web'),
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      visitCount: (existing?.visitCount || 0) + 1,
      loggedIn: existing?.loggedIn || false,
      lastCheckedAt: existing?.lastCheckedAt || '',
    }
    this.sites.set(key, next)
    this.scheduleFlush()
    return next
  }

  setFavicon(host, profileId, favicon) {
    const key = recordKey(host, profileId)
    const existing = this.sites.get(key)
    if (!existing) {
      return
    }
    const value = String(favicon || '').trim()
    if (!value || value.length > maxFaviconLength || value === existing.favicon) {
      return
    }
    existing.favicon = value
    this.scheduleFlush()
  }

  setLoginStatus(host, profileId, loggedIn) {
    const key = recordKey(host, profileId)
    const existing = this.sites.get(key)
    if (!existing) {
      return
    }
    existing.loggedIn = Boolean(loggedIn)
    existing.lastCheckedAt = new Date().toISOString()
    this.scheduleFlush()
  }

  forgetSite(host, profileId) {
    const normalizedHost = normalizeHost(host)
    if (!normalizedHost) {
      return []
    }
    const removed = []
    if (profileId) {
      const key = recordKey(normalizedHost, profileId)
      const record = this.sites.get(key)
      if (record && this.sites.delete(key)) {
        removed.push(record)
      }
    } else {
      for (const [key, record] of this.sites) {
        if (record.host === normalizedHost) {
          this.sites.delete(key)
          removed.push(record)
        }
      }
    }
    if (removed.length) {
      this.scheduleFlush()
    }
    return removed
  }

  getSite(host, profileId) {
    return this.sites.get(recordKey(host, profileId)) || null
  }

  listSites() {
    return Array.from(this.sites.values())
      .map((record) => ({ ...record }))
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
  }
}

export const __browserSiteRegistryTestUtils = {
  normalizeHost,
  normalizeProfileId,
  resolveHost,
  isTrackableURL,
  recordKey,
}
