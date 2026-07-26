import { BrowserView, WebContentsView, session, shell } from 'electron'
import { DESKTOP_BROWSER_SESSION_EVENT } from './channels.mjs'
import { normalizeExternalURL } from './external-url.mjs'

const defaultProfileId = 'default'
const panelMinWidth = 420
const defaultLeftInset = 272
const defaultTopInset = 98
const defaultRightInset = 0
const defaultDebuggerSoftTimeoutMs = 2500
const defaultNavigationSoftTimeoutMs = 8000
const chromeDesktopUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const chromeUserAgentMetadata = {
  architecture: 'x86',
  bitness: '64',
  brands: [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: '126' },
    { brand: 'Google Chrome', version: '126' },
  ],
  fullVersionList: [
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: '126.0.0.0' },
    { brand: 'Google Chrome', version: '126.0.0.0' },
  ],
  mobile: false,
  model: '',
  platform: 'macOS',
  platformVersion: '10.15.7',
  wow64: false,
}
const htmlEntityMap = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}
const codePointText = (...values) => String.fromCodePoint(...values)
const loginHints = [
  'login',
  'log in',
  'sign in',
  codePointText(0x767b, 0x5f55),
  codePointText(0x767b, 0x5165),
]
const loginRequiredHints = [
  ...loginHints,
  codePointText(0x767b, 0x5f55, 0x540e),
  codePointText(0x8bf7, 0x5148, 0x767b, 0x5f55),
  codePointText(0x7acb, 0x5373, 0x767b, 0x5f55),
]
const riskGateHints = [
  codePointText(0x5b89, 0x5168, 0x9650, 0x5236),
  codePointText(0x98ce, 0x9669),
  codePointText(0x5f02, 0x5e38, 0x6d41, 0x91cf),
  codePointText(0x8bbf, 0x95ee, 0x53d7, 0x9650),
  codePointText(0x8bf7, 0x5b8c, 0x6210, 0x9a8c, 0x8bc1),
  'verify',
  'verification',
  'captcha',
  'security check',
  'reliable network',
  'risk pass',
]

function truncateText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  return typeof limit === 'number' && limit > 0 && text.length > limit
    ? text.slice(0, limit) + '...'
    : text
}

function decodeHtmlEntities(value = '') {
  return String(value || '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity || '').toLowerCase()
    if (normalized.startsWith('#x')) {
      const parsed = Number.parseInt(normalized.slice(2), 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    }
    if (normalized.startsWith('#')) {
      const parsed = Number.parseInt(normalized.slice(1), 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    }
    return htmlEntityMap[normalized] || match
  })
}

function stripHTML(value = '') {
  const withoutScripts = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  const text = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|main)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return truncateText(decodeHtmlEntities(text), 0)
}

function extractTagText(html = '', selectors = [], limit = 0) {
  for (const pattern of selectors) {
    const match = String(html || '').match(pattern)
    if (!match) {
      continue
    }
    const text = truncateText(stripHTML(match[1] || ''), limit)
    if (text) {
      return text
    }
  }
  return ''
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function buildMainContentPreview(html = '', maxContentLength = 700) {
  return extractTagText(
    html,
    [
      /<article\b[^>]*>([\s\S]*?)<\/article>/i,
      /<main\b[^>]*>([\s\S]*?)<\/main>/i,
      /<div\b[^>]*class=["'][^"']*(?:content|article|main|post|entry|detail)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<section\b[^>]*class=["'][^"']*(?:content|article|main|post|entry|detail)[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
    ],
    maxContentLength,
  ) || truncateText(stripHTML(html), maxContentLength)
}

function buildMainContentHTML(html = '', maxHTMLLength = 6000) {
  const matchers = [
    /<article\b[^>]*>[\s\S]*?<\/article>/i,
    /<main\b[^>]*>[\s\S]*?<\/main>/i,
    /<div\b[^>]*class=["'][^"']*(?:content|article|main|post|entry|detail)[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
    /<section\b[^>]*class=["'][^"']*(?:content|article|main|post|entry|detail)[^"']*["'][^>]*>[\s\S]*?<\/section>/i,
  ]
  for (const pattern of matchers) {
    const match = String(html || '').match(pattern)
    const snippet = String(match?.[0] || '').replace(/\s+/g, ' ').trim()
    if (snippet) {
      return snippet.length > maxHTMLLength
        ? snippet.slice(0, maxHTMLLength) + '...'
        : snippet
    }
  }
  const compact = String(html || '').replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxHTMLLength
    ? compact.slice(0, maxHTMLLength) + '...'
    : compact
}

function normalizeHref(href = '', pageURL = '') {
  const text = String(href || '').trim()
  if (!text || text.startsWith('#') || /^javascript:/i.test(text)) {
    return ''
  }
  try {
    const url = new URL(text, pageURL || 'https://example.com/')
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function extractAttributeValue(value = '', attributeName = '') {
  if (!value || !attributeName) {
    return ''
  }
  const pattern = new RegExp(`${attributeName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i')
  const match = String(value).match(pattern)
  return truncateText(decodeHtmlEntities(match?.[2] || ''), 180)
}

function resolveAnchorLabel(attributes = '', innerHTML = '') {
  const text = truncateText(stripHTML(innerHTML || ''), 120)
  if (text) {
    return text
  }
  const fallback = [
    extractAttributeValue(attributes, 'title'),
    extractAttributeValue(attributes, 'aria-label'),
    extractAttributeValue(attributes, 'alt'),
    extractAttributeValue(attributes, 'data-title'),
    extractAttributeValue(attributes, 'data-vtitle'),
  ].find(Boolean)
  return truncateText(fallback || '', 120)
}

function extractHeadingFromHTML(html = '') {
  return extractTagText(
    html,
    [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
      /<h3\b[^>]*>([\s\S]*?)<\/h3>/i,
      /<h4\b[^>]*>([\s\S]*?)<\/h4>/i,
      /<strong\b[^>]*>([\s\S]*?)<\/strong>/i,
    ],
    180,
  )
}

function extractSummaryFromBlock(html = '', title = '') {
  const text = truncateText(stripHTML(html), 280)
  if (!text) {
    return ''
  }
  const normalizedTitle = String(title || '').trim()
  if (!normalizedTitle) {
    return text
  }
  const summary = text.replace(normalizedTitle, '').replace(/\s+/g, ' ').trim()
  return truncateText(summary || text, 220)
}

function chooseBestBlockTitle(blockHTML = '', pageURL = '') {
  const heading = extractHeadingFromHTML(blockHTML)
  if (heading) {
    return heading
  }
  const links = extractLinksFromHTML(blockHTML, pageURL, 6)
  const bestLink = [...links]
    .sort((left, right) => String(right.text || '').length - String(left.text || '').length)[0]
  return truncateText(bestLink?.text || '', 180)
}

function extractContentBlocksFromHTML(html = '', pageURL = '', maxItems = 20) {
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<(?:li|section|div)\b[^>]*class=["'][^"']*(?:card|item|video|post|feed|list|module|content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|section|div)>/gi,
  ]
  const entities = []
  const seen = new Set()
  for (const pattern of patterns) {
    const matches = String(html || '').matchAll(pattern)
    for (const match of matches) {
      const blockHTML = String(match[1] || '').trim()
      if (!blockHTML) {
        continue
      }
      const blockLinks = extractLinksFromHTML(blockHTML, pageURL, 8)
      const title = chooseBestBlockTitle(blockHTML, pageURL)
      const primaryLink = blockLinks.find((link) => String(link.text || '').trim().length >= 4) || blockLinks[0] || null
      const url = String(primaryLink?.href || '').trim()
      const summary = extractSummaryFromBlock(blockHTML, title)
      const dedupeKey = `${url}::${title}`.trim().toLowerCase()
      if (!title || title.length < 4 || !dedupeKey || seen.has(dedupeKey)) {
        continue
      }
      seen.add(dedupeKey)
      entities.push({
        url,
        title: truncateText(title, 180),
        summary,
        text: truncateText(stripHTML(blockHTML), 400),
        html: truncateText(blockHTML.replace(/\s+/g, ' ').trim(), 1400),
      })
      if (entities.length >= maxItems) {
        return entities
      }
    }
  }
  return entities
}

function looksLikeChromeLink(attributes = '', text = '') {
  const lowerAttrs = String(attributes || '').toLowerCase()
  const lowerText = String(text || '').trim().toLowerCase()
  if (!lowerAttrs && !lowerText) {
    return false
  }
  const chromeHints = [
    'nav',
    'navbar',
    'menu',
    'header',
    'footer',
    'tab',
    'channel',
    'category',
    'breadcrumb',
    'toolbar',
  ]
  return chromeHints.some((hint) => lowerAttrs.includes(hint)) &&
    lowerText.length <= 16
}

function scoreContentHref(href = '') {
  const text = String(href || '').trim()
  if (!text) {
    return 0
  }
  let pathname = ''
  try {
    pathname = new URL(text).pathname.toLowerCase()
  } catch {
    pathname = text.toLowerCase()
  }
  let score = 0
  if (
    /\/(video|read|article|articles|note|notes|post|posts|thread|threads|status|statuses|detail|details|p|item|items)\b/.test(pathname)
  ) {
    score += 8
  }
  if (/\b(bv[a-z0-9]+|av\d+)\b/i.test(pathname)) {
    score += 6
  }
  if (/\/(space|user|users|profile|profiles|member|members|author|authors|up)\b/.test(pathname)) {
    score -= 6
  }
  if (/\/$/.test(pathname) && pathname.split('/').filter(Boolean).length <= 1) {
    score -= 2
  }
  return score
}

function extractLinksFromHTML(html = '', pageURL = '', maxLinks = 20) {
  const matches = String(html || '').matchAll(/<a\b([^>]*)href=(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)
  const candidates = []
  const seen = new Set()
  let rawCount = 0
  for (const match of matches) {
    rawCount += 1
    if (rawCount > 800) {
      break
    }
    const attributes = `${match[1] || ''} ${match[4] || ''}`
    const href = normalizeHref(match[3], pageURL)
    if (!href || seen.has(href)) {
      continue
    }
    const text = resolveAnchorLabel(attributes, match[5] || '')
    if (looksLikeChromeLink(attributes, text)) {
      continue
    }
    candidates.push({
      text,
      href,
      _score: scoreContentHref(href) + Math.min(4, Math.floor(String(text || '').trim().length / 12)),
      _order: rawCount,
    })
    seen.add(href)
  }
  return candidates
    .sort((left, right) => {
      const scoreDiff = Number(right._score || 0) - Number(left._score || 0)
      if (scoreDiff !== 0) {
        return scoreDiff
      }
      return Number(left._order || 0) - Number(right._order || 0)
    })
    .slice(0, maxLinks)
    .map((item) => ({
      text: item.text,
      href: item.href,
    }))
}

function buildPageContextFromHTML(options = {}) {
  const html = String(options.html || '')
  const pageURL = String(options.pageURL || '')
  const pageTitle = truncateText(String(options.pageTitle || ''), 200)
  const requestedCommand = String(options.command || '').trim().toLowerCase()
  const requestedEntityType = String(options.entityType || '').trim()
  const requestedQuery = String(options.query || '').trim()
  const maxPreviewLength = Math.max(120, Number(options.maxPreviewLength) || 900)
  const maxContentLength = Math.max(120, Number(options.maxContentLength) || 700)
  const maxLinks = Math.max(1, Number(options.maxLinks) || 20)
  const maxHTMLLength = Math.max(800, Number(options.maxHTMLLength) || 12000)
  const articleCount = (html.match(/<article\b/gi) || []).length
  const visibleTextPreview = truncateText(stripHTML(html), maxPreviewLength)
  const contentTextPreview = truncateText(buildMainContentPreview(html, maxContentLength), maxContentLength)
  const mainContentHTML = buildMainContentHTML(html, Math.min(maxHTMLLength, 8000))
  const htmlSnapshot = buildMainContentHTML(html, maxHTMLLength)
  const pageHeading = extractTagText(
    html,
    [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<main\b[^>]*>[\s\S]*?<h2\b[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<\/main>/i,
    ],
    160,
  )
  const links = extractLinksFromHTML(html, pageURL, maxLinks)
  const normalizedQuery = normalizeSearchText(requestedQuery)
  const queryTerms = requestedQuery
    ? requestedQuery
        .split(/\s+/)
        .map((item) => normalizeSearchText(item))
        .filter((item) => item.length >= 2)
    : []
  const matchesRequestedQuery = (value) => {
    if (!normalizedQuery) {
      return true
    }
    const normalizedValue = normalizeSearchText(value)
    if (!normalizedValue) {
      return false
    }
    if (normalizedValue.includes(normalizedQuery)) {
      return true
    }
    return queryTerms.length > 1 && queryTerms.every((term) => normalizedValue.includes(term))
  }
  const blockEntities = extractContentBlocksFromHTML(html, pageURL, maxLinks * 2)
  const extractedEntities = []
  const seenEntityKeys = new Set()
  for (const block of blockEntities) {
    if (!matchesRequestedQuery([block.title, block.summary, block.url].join(' '))) {
      continue
    }
    const dedupeKey = `${block.url}::${block.title}`.trim().toLowerCase()
    if (!dedupeKey || seenEntityKeys.has(dedupeKey)) {
      continue
    }
    seenEntityKeys.add(dedupeKey)
    extractedEntities.push({
      entity_type: requestedEntityType || 'unknown_item',
      url: block.url,
      title: block.title,
      author: '',
      published_at: '',
      summary: block.summary,
    })
    if (extractedEntities.length >= maxLinks) {
      break
    }
  }
  for (const link of links) {
    const title = truncateText(link.text, 180)
    if (!title || title.length < 6 || link.href === pageURL) {
      continue
    }
    if (!matchesRequestedQuery([title, link.href].join(' '))) {
      continue
    }
    const dedupeKey = `${link.href}::${title}`.trim().toLowerCase()
    if (seenEntityKeys.has(dedupeKey)) {
      continue
    }
    seenEntityKeys.add(dedupeKey)
    extractedEntities.push({
      entity_type: requestedEntityType || 'unknown_item',
      url: link.href,
      title,
      author: '',
      published_at: '',
      summary: '',
    })
    if (extractedEntities.length >= maxLinks) {
      break
    }
  }

  const hasPasswordInput = /<input\b[^>]*type=(["'])password\1/i.test(html)
  const lowerVisibleText = visibleTextPreview.toLowerCase()
  const loggedIn = !hasPasswordInput && !loginHints.some((hint) => lowerVisibleText.includes(hint))
  const detailEntity = pageURL || pageTitle || pageHeading
    ? [{
        entity_type: requestedEntityType || 'unknown_detail',
        url: pageURL,
        title: pageHeading || pageTitle,
        author: '',
        published_at: '',
        summary: contentTextPreview || visibleTextPreview,
      }]
    : []
  const listCommands = new Set(['search', 'feed', 'timeline', 'explore', 'extract-list', 'videos', 'comments', 'bookmarks'])
  const detailCommands = new Set(['thread', 'note', 'video', 'read', 'post', 'profile', 'user', 'channel', 'extract-detail'])
  const pageType = listCommands.has(requestedCommand)
    ? 'list'
    : detailCommands.has(requestedCommand)
      ? 'detail'
      : extractedEntities.length >= 3 ||
        articleCount >= 3 ||
        blockEntities.length >= 3 ||
        (links.length >= 12 && extractedEntities.length >= 1)
        ? 'list'
        : 'detail'

  return {
    supported_page: pageURL !== 'about:blank',
    logged_in: loggedIn,
    editor_ready: false,
    title_ready: Boolean(pageHeading || pageTitle),
    content_ready: Boolean(contentTextPreview || visibleTextPreview),
    page_url: pageURL,
    page_title: pageTitle,
    hostname: resolveURLHost(pageURL),
    page_heading: pageHeading,
    title_text: pageHeading,
    content_text_preview: contentTextPreview,
    visible_text_preview: visibleTextPreview,
    main_content_html: mainContentHTML,
    html_snapshot: htmlSnapshot,
    content_blocks: blockEntities,
    page_type: pageType,
    links,
    extracted_entities: pageType === 'list' ? extractedEntities : detailEntity,
    extracted_at: new Date().toISOString(),
  }
}

function normalizeProfileId(value) {
  const trimmed = String(value || '').trim()
  return trimmed || defaultProfileId
}

function normalizeTargetURL(request = {}, previousURL = '') {
  const rawURL = String(request.url || request.page_url || '').trim()
  if (/^https?:\/\//i.test(rawURL)) {
    return rawURL
  }
  const host = String(request.host || '').trim()
  if (host) {
    const normalizedHost = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    if (normalizedHost) {
      return `https://${normalizedHost}`
    }
  }
  return String(previousURL || '').trim()
}

function resolveURLHost(value = '') {
  const rawValue = String(value || '').trim()
  if (!rawValue) {
    return ''
  }
  try {
    return String(new URL(rawValue).hostname || '').trim().toLowerCase()
  } catch {
    return ''
  }
}

function looksLikeBareDomain(value = '') {
  const trimmed = String(value || '').trim()
  if (!trimmed || /\s/.test(trimmed)) {
    return false
  }
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return true
  }
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)) {
    return true
  }
  return /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)
}

function buildSearchURL(query = '') {
  return `https://www.bing.com/search?q=${encodeURIComponent(String(query || '').trim())}`
}

// Resolve a raw address-bar input into a navigation URL. Disambiguation between
// a URL and a web search lives here in the main process, never in the renderer.
function resolveAddressBarURL(rawInput = '') {
  const trimmed = String(rawInput || '').trim()
  if (!trimmed) {
    return ''
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed
  }
  if (looksLikeBareDomain(trimmed)) {
    return `https://${trimmed}`
  }
  return buildSearchURL(trimmed)
}

function readNavigationState(webContents) {
  if (!webContents || webContents.isDestroyed?.()) {
    return { canGoBack: false, canGoForward: false }
  }
  const history = webContents.navigationHistory
  const canGoBack = typeof history?.canGoBack === 'function'
    ? history.canGoBack()
    : typeof webContents.canGoBack === 'function'
      ? webContents.canGoBack()
      : false
  const canGoForward = typeof history?.canGoForward === 'function'
    ? history.canGoForward()
    : typeof webContents.canGoForward === 'function'
      ? webContents.canGoForward()
      : false
  return {
    canGoBack: Boolean(canGoBack),
    canGoForward: Boolean(canGoForward),
  }
}

function cookieDomainMatchesHost(cookieDomain = '', host = '') {
  const domain = String(cookieDomain || '').trim().toLowerCase().replace(/^\./, '')
  const target = String(host || '').trim().toLowerCase().replace(/^www\./, '')
  if (!domain || !target) {
    return false
  }
  return domain === target || target.endsWith(`.${domain}`) || domain.endsWith(`.${target}`)
}

async function settleWithSoftTimeout(task, timeoutMs) {
  const duration = Math.max(0, Number(timeoutMs) || 0)
  if (!duration) {
    return {
      status: 'resolved',
      value: await task,
    }
  }

  let timer = null
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        status: 'timed_out',
      })
    }, duration)
  })
  const taskPromise = Promise.resolve(task).then(
    (value) => ({
      status: 'resolved',
      value,
    }),
    (error) => ({
      status: 'rejected',
      error,
    }),
  )

  try {
    return await Promise.race([taskPromise, timeoutPromise])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function buildExtractionPrimeScript() {
  return `(() => {
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const root = document.scrollingElement || document.documentElement || document.body;
    if (!root) {
      return Promise.resolve({ primed: false, reason: 'no_root' });
    }
    const startY = window.scrollY || root.scrollTop || 0;
    const viewport = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0, 720);
    const maxScroll = Math.max(0, (root.scrollHeight || document.body?.scrollHeight || 0) - viewport);
    const firstStep = Math.min(maxScroll, startY + Math.max(480, Math.floor(viewport * 0.8)));
    const secondStep = Math.min(maxScroll, firstStep + Math.max(360, Math.floor(viewport * 0.6)));
    const go = async () => {
      if (firstStep > startY + 24) {
        window.scrollTo({ top: firstStep, behavior: 'instant' });
        await wait(180);
      }
      if (secondStep > firstStep + 24) {
        window.scrollTo({ top: secondStep, behavior: 'instant' });
        await wait(220);
      }
      if (startY !== (window.scrollY || root.scrollTop || 0)) {
        window.scrollTo({ top: startY, behavior: 'instant' });
        await wait(80);
      }
      return {
        primed: secondStep > startY + 24 || firstStep > startY + 24,
        startY,
        endY: window.scrollY || root.scrollTop || 0,
        viewport,
        scrollHeight: root.scrollHeight || document.body?.scrollHeight || 0,
      };
    };
    return go();
  })();`
}

function resetSearchWorkflowRuntime(session) {
  if (!session?.lastRuntime || typeof session.lastRuntime !== 'object') {
    return
  }
  const { search_workflow: _searchWorkflow, ...rest } = session.lastRuntime
  session.lastRuntime = rest
}

function looksLikeSearchResultsURL(value = '') {
  const lowerURL = String(value || '').trim().toLowerCase()
  if (!lowerURL) {
    return false
  }
  return lowerURL.includes('search_result')
    || lowerURL.includes('/search')
    || lowerURL.includes('keyword=')
    || lowerURL.includes('?q=')
    || lowerURL.includes('&q=')
    || lowerURL.includes('query=')
    || lowerURL.includes('search?')
    || lowerURL.includes('/results?')
    || lowerURL.includes('/results/')
}

function buildSearchBodyPreview(html = '') {
  return truncateText(stripHTML(html), 240)
}

function matchesSearchHint(text = '', hints = []) {
  const normalizedText = normalizeSearchText(text)
  if (!normalizedText) {
    return false
  }
  return hints.some((hint) => normalizedText.includes(normalizeSearchText(hint)))
}

function detectSearchBlockingState(options = {}) {
  const html = String(options.html || '')
  const pageURL = String(options.pageURL || '').trim()
  const pageTitle = truncateText(String(options.pageTitle || ''), 200)
  const bodyPreview = buildSearchBodyPreview(html)
  const combinedText = [pageTitle, bodyPreview].join(' ')

  if (matchesSearchHint(combinedText, riskGateHints)) {
    return {
      applied: false,
      reason: 'risk_gate',
      page_url: pageURL,
      page_title: pageTitle,
      body_text_preview: bodyPreview,
    }
  }
  if (
    /<input\b[^>]*type=(["'])password\1/i.test(html)
    || matchesSearchHint(combinedText, loginRequiredHints)
  ) {
    return {
      applied: false,
      reason: 'login_required',
      page_url: pageURL,
      page_title: pageTitle,
      body_text_preview: bodyPreview,
    }
  }
  return null
}

function resolveDirectSearchResultsURL(request = {}, currentURL = '') {
  const explicitURL = String(request.url || request.page_url || '').trim()
  if (looksLikeSearchResultsURL(explicitURL)) {
    return explicitURL
  }
  const activeURL = String(currentURL || '').trim()
  if (looksLikeSearchResultsURL(activeURL)) {
    return activeURL
  }
  return ''
}

function buildSearchWorkflowResultFromPage(options = {}) {
  const pageURL = String(options.pageURL || '').trim()
  const pageTitle = truncateText(String(options.pageTitle || ''), 200)
  const html = String(options.html || '')
  const directURL = String(options.directURL || '').trim()
  const bodyPreview = buildSearchBodyPreview(html)
  const blockedState = detectSearchBlockingState({
    html,
    pageURL,
    pageTitle,
  })
  if (blockedState) {
    return blockedState
  }
  if (looksLikeSearchResultsURL(pageURL)) {
    return {
      applied: true,
      reason: directURL && pageURL === directURL
        ? 'direct_results_url'
        : 'already_on_search_page',
      page_url: pageURL,
      page_title: pageTitle,
    }
  }
  return {
    applied: false,
    reason: directURL ? 'search_results_not_reached' : 'search_url_unavailable',
    page_url: pageURL,
    page_title: pageTitle,
    body_text_preview: bodyPreview,
    direct_url: directURL,
  }
}

export class GenericBrowserSessionManager {
  constructor(_desktopEnv, getMainWindow, options = {}) {
    this.getMainWindow = getMainWindow
    this.siteRegistry = options.siteRegistry || null
    this.providerKey = String(options.providerKey || 'generic-web')
    this.configureSession = typeof options.configureSession === 'function'
      ? options.configureSession
      : async () => {}
    this.sessions = new Map()
    this.activeProfileId = defaultProfileId
    this.panelVisible = false
    this.debuggerSoftTimeoutMs = defaultDebuggerSoftTimeoutMs
    this.navigationSoftTimeoutMs = defaultNavigationSoftTimeoutMs
    this.hostLayout = {
      leftInset: defaultLeftInset,
      topInset: defaultTopInset,
      rightInset: defaultRightInset,
    }
  }

  getSession(profileId, createIfMissing = false) {
    const normalized = normalizeProfileId(profileId)
    if (!this.sessions.has(normalized) && createIfMissing) {
      this.sessions.set(normalized, {
        profileId: normalized,
        view: null,
        surfaceType: '',
        lastError: '',
        lastRequestedURL: '',
        lastRuntime: {},
        isLoading: false,
        debuggerConfigured: false,
        debuggerConfiguring: null,
      })
    }
    return this.sessions.get(normalized) || null
  }

  hasLiveSessionSurface(session) {
    return Boolean(session?.view && !session.view.webContents.isDestroyed())
  }

  getHostWindow() {
    const hostWindow = this.getMainWindow?.()
    if (!hostWindow || hostWindow.isDestroyed()) {
      throw new Error('Main window is not available')
    }
    return hostWindow
  }

  getSessionWebContents(session) {
    if (!this.hasLiveSessionSurface(session)) {
      return null
    }
    return session.view.webContents
  }

  supportsWebContentsViewSurface() {
    return typeof WebContentsView === 'function'
  }

  createSessionSurface(profileId) {
    const webPreferences = {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: `persist:kition-browser-${profileId}`,
    }
    // Prefer the modern WebContentsView overlay. BrowserView is deprecated and
    // can hold a live webContents (title/URL load) yet never paint over the
    // host window, leaving the embedded page invisible behind the React panel.
    if (this.supportsWebContentsViewSurface()) {
      return {
        surfaceType: 'webcontents_view',
        view: new WebContentsView({
          webPreferences,
        }),
      }
    }
    return {
      surfaceType: 'browser_view',
      view: new BrowserView({
        webPreferences,
      }),
    }
  }

  async configureSessionDebugger(profileId, webContents) {
    const session = this.getSession(profileId, true)
    if (!webContents || webContents.isDestroyed() || session.debuggerConfigured) {
      return
    }
    if (session.debuggerConfiguring) {
      return session.debuggerConfiguring
    }

    session.debuggerConfiguring = (async () => {
      webContents.setUserAgent(chromeDesktopUserAgent)
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach('1.3')
      }
      await webContents.debugger.sendCommand('DOM.enable')
      await webContents.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: chromeDesktopUserAgent,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'MacIntel',
        userAgentMetadata: chromeUserAgentMetadata,
      })
      session.debuggerConfigured = true
      session.lastRuntime = {
        ...(session.lastRuntime || {}),
        network: {
          driver: 'chrome_devtools_protocol',
          user_agent: chromeDesktopUserAgent,
        },
      }
    })().catch((error) => {
      session.debuggerConfigured = false
      session.lastError = String(error?.message || error || 'Browser CDP initialization failed')
      throw error
    }).finally(() => {
      session.debuggerConfiguring = null
      this.emitPanelState(profileId)
    })

    return session.debuggerConfiguring
  }

  async capturePageHTML(profileId, webContents) {
    await this.configureSessionDebugger(profileId, webContents)
    const { root } = await webContents.debugger.sendCommand('DOM.getDocument', {
      depth: 1,
      pierce: false,
    })
    const { outerHTML } = await webContents.debugger.sendCommand('DOM.getOuterHTML', {
      nodeId: root.nodeId,
    })
    return String(outerHTML || '')
  }

  async primePageForExtraction(profileId, webContents) {
    await this.configureSessionDebugger(profileId, webContents)
    if (!webContents || webContents.isDestroyed() || typeof webContents.executeJavaScript !== 'function') {
      return {
        primed: false,
        reason: 'unsupported',
      }
    }
    const script = buildExtractionPrimeScript()
    const result = await settleWithSoftTimeout(
      webContents.executeJavaScript(script, true),
      900,
    )
    if (result.status !== 'resolved') {
      return {
        primed: false,
        reason: result.status,
      }
    }
    return result.value && typeof result.value === 'object'
      ? result.value
      : { primed: false, reason: 'empty' }
  }

  baseStatus(profileId = this.activeProfileId) {
    const normalized = normalizeProfileId(profileId)
    const session = this.getSession(normalized)
    const webContents = this.getSessionWebContents(session)
    const pageURL = webContents?.getURL?.() || ''
    const pageTitle = webContents?.getTitle?.() || ''
    const navigationState = readNavigationState(webContents)
    const isLoading = webContents
      ? Boolean(session?.isLoading) || Boolean(webContents.isLoading?.())
      : false
    return {
      profile_id: normalized,
      supported: true,
      driver: session?.surfaceType === 'browser_view'
        ? 'electron_browserview'
        : 'electron_webcontentsview',
      available: true,
      window_open: Boolean(webContents),
      panel_visible: this.panelVisible && normalized === normalizeProfileId(this.activeProfileId),
      panel_width: this.panelVisible ? undefined : 0,
      logged_in: false,
      editor_ready: false,
      can_go_back: navigationState.canGoBack,
      can_go_forward: navigationState.canGoForward,
      is_loading: isLoading,
      page_url: pageURL,
      page_title: pageTitle,
      message: pageURL
        ? 'The built-in browser has opened the requested site. Login state must be confirmed in the page itself — keep working inside this window.'
        : 'The built-in browser window was created and is waiting to open the target page.',
      last_error: session?.lastError || '',
      runtime: {
        ...(session?.lastRuntime || {}),
        ...(session?.lastRequestedURL
          ? { last_requested_url: session.lastRequestedURL }
          : {}),
        user_agent: chromeDesktopUserAgent,
      },
    }
  }

  emitPanelState(profileId = this.activeProfileId) {
    const hostWindow = this.getMainWindow?.()
    if (!hostWindow || hostWindow.isDestroyed() || !hostWindow.webContents || hostWindow.webContents.isDestroyed()) {
      return
    }
    hostWindow.webContents.send(DESKTOP_BROWSER_SESSION_EVENT, {
      provider: 'generic-web',
      ...this.baseStatus(profileId),
    })
  }

  resolvePanelBounds(hostWindow = this.getHostWindow()) {
    const bounds = hostWindow.getContentBounds()
    const leftInset = Math.max(0, Math.min(this.hostLayout.leftInset || 0, Math.max(0, bounds.width - panelMinWidth)))
    const topInset = Math.max(0, Math.min(this.hostLayout.topInset || 0, Math.max(0, bounds.height - 160)))
    const rightInset = Math.max(0, Math.min(this.hostLayout.rightInset || 0, Math.max(0, bounds.width - leftInset - panelMinWidth)))
    return {
      x: leftInset,
      y: topInset,
      width: Math.max(panelMinWidth, bounds.width - leftInset - rightInset),
      height: Math.max(160, bounds.height - topInset),
    }
  }

  layoutPanel(profileId = this.activeProfileId) {
    const session = this.getSession(profileId)
    if (!this.hasLiveSessionSurface(session) || !this.panelVisible || normalizeProfileId(profileId) !== normalizeProfileId(this.activeProfileId)) {
      return
    }
    session.view.setBounds(this.resolvePanelBounds())
  }

  detachActivePanel() {
    const session = this.getSession(this.activeProfileId)
    if (!this.hasLiveSessionSurface(session)) {
      this.panelVisible = false
      return
    }
    const hostWindow = this.getMainWindow?.()
    if (hostWindow && !hostWindow.isDestroyed()) {
      if (session.surfaceType === 'browser_view') {
        if (typeof hostWindow.removeBrowserView === 'function') {
          try {
            hostWindow.removeBrowserView(session.view)
          } catch {
            // Ignore detach errors and continue resetting the panel state.
          }
        } else if (typeof hostWindow.setBrowserView === 'function') {
          hostWindow.setBrowserView(null)
        }
      } else if (hostWindow.contentView?.removeChildView) {
        hostWindow.contentView.removeChildView(session.view)
      }
    }
    this.panelVisible = false
    this.emitPanelState(session.profileId)
  }

  attachPanel(profileId) {
    const normalized = normalizeProfileId(profileId)
    const session = this.getSession(normalized)
    if (!this.hasLiveSessionSurface(session)) {
      return
    }
    if (this.panelVisible && normalizeProfileId(this.activeProfileId) === normalized) {
      this.layoutPanel(normalized)
      this.emitPanelState(normalized)
      return
    }
    if (normalizeProfileId(this.activeProfileId) !== normalized && this.panelVisible) {
      this.detachActivePanel()
    }
    const hostWindow = this.getHostWindow()
    session.view.setBounds(this.resolvePanelBounds(hostWindow))
    if (session.surfaceType === 'browser_view') {
      if (typeof hostWindow.addBrowserView === 'function') {
        const existingViews = typeof hostWindow.getBrowserViews === 'function'
          ? hostWindow.getBrowserViews()
          : []
        if (!existingViews.includes(session.view)) {
          hostWindow.addBrowserView(session.view)
        }
      } else if (typeof hostWindow.setBrowserView === 'function') {
        hostWindow.setBrowserView(session.view)
      }
      if (typeof hostWindow.setTopBrowserView === 'function') {
        hostWindow.setTopBrowserView(session.view)
      }
    } else {
      const existingChildren = hostWindow.contentView?.children || []
      if (!existingChildren.includes(session.view)) {
        hostWindow.contentView.addChildView(session.view)
      }
    }
    this.activeProfileId = normalized
    this.panelVisible = true
    this.layoutPanel(normalized)
    this.emitPanelState(normalized)
  }

  async ensureSession(profileId) {
    const normalized = normalizeProfileId(profileId)
    const session = this.getSession(normalized, true)
    if (this.hasLiveSessionSurface(session)) {
      return session
    }

    const surface = this.createSessionSurface(normalized)
    session.view = surface.view
    session.surfaceType = surface.surfaceType
    const surfaceWebContents = session.view.webContents
    await this.configureSession(surfaceWebContents.session)
    surfaceWebContents.setWindowOpenHandler(({ url }) => {
      // Keep target=_blank / window.open navigations inside the embedded
      // session so pages stay scrapable instead of escaping to the OS browser.
      if (/^https?:\/\//i.test(url)) {
        void surfaceWebContents.loadURL(url).catch(() => {})
      } else {
        try {
          void shell.openExternal(normalizeExternalURL(url))
        } catch {
          // Unsupported protocols are denied.
        }
      }
      return { action: 'deny' }
    })
    session.view.webContents.on('did-start-loading', () => {
      session.isLoading = true
      session.lastError = 'The built-in browser page is still loading; please wait.'
      session.lastRuntime = {
        ...(session.lastRuntime || {}),
        navigation: {
          stage: 'loading',
          page_url: session.view?.webContents?.getURL?.() || '',
        },
      }
      this.emitPanelState(normalized)
    })
    session.view.webContents.on('did-stop-loading', () => {
      session.isLoading = false
      this.emitPanelState(normalized)
    })
    session.view.webContents.on('page-title-updated', () => {
      this.recordVisit(normalized)
      this.emitPanelState(normalized)
    })
    session.view.webContents.on('page-favicon-updated', (_event, favicons) => {
      this.recordFavicon(normalized, favicons)
    })
    session.view.webContents.on('did-navigate', () => {
      session.lastError = ''
      session.lastRuntime = {
        ...(session.lastRuntime || {}),
        navigation: {
          stage: 'navigated',
          page_url: session.view?.webContents?.getURL?.() || '',
          page_title: session.view?.webContents?.getTitle?.() || '',
        },
      }
      this.recordVisit(normalized)
      this.emitPanelState(normalized)
    })
    session.view.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
      if (!isMainFrame) {
        return
      }
      session.lastError = ''
      session.lastRuntime = {
        ...(session.lastRuntime || {}),
        navigation: {
          stage: 'loaded',
          page_url: session.view?.webContents?.getURL?.() || '',
          page_title: session.view?.webContents?.getTitle?.() || '',
        },
      }
      this.recordVisit(normalized)
      this.emitPanelState(normalized)
    })
    session.view.webContents.on('destroyed', () => {
      session.view = null
      session.debuggerConfigured = false
      session.debuggerConfiguring = null
      if (normalizeProfileId(this.activeProfileId) === normalized) {
        this.panelVisible = false
        this.emitPanelState(normalized)
      }
    })
    // Browsing does not need the CDP debugger. Attaching it eagerly (and
    // enabling the Network domain) buffers every response and adds seconds to
    // each page load, so set only the desktop user agent now and defer CDP
    // until extraction actually requires it.
    if (typeof surfaceWebContents.setUserAgent === 'function') {
      surfaceWebContents.setUserAgent(chromeDesktopUserAgent)
    }
    return session
  }

  async status(request = {}) {
    return this.baseStatus(request.profile_id || request.profileId || this.activeProfileId)
  }

  async ensureWindow(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    const session = await this.ensureSession(profileId)
    this.attachPanel(profileId)
    const webContents = this.getSessionWebContents(session)
    const navigationTimeoutMs = Math.max(
      0,
      Number(request.navigation_timeout_ms) || this.navigationSoftTimeoutMs,
    )
    const isSearchRequest =
      String(request.command || '').trim().toLowerCase() === 'search'
      && Boolean(String(request.query || '').trim())
    const addressInput = String(request.address || '').trim()
    const addressURL = addressInput ? resolveAddressBarURL(addressInput) : ''
    const previousRequestedURL = session.lastRequestedURL
    const desiredURL = normalizeTargetURL(request, session.lastRequestedURL)
    const directSearchURL = isSearchRequest
      ? resolveDirectSearchResultsURL(request, webContents.getURL())
      : ''
    const effectiveDesiredURL = addressURL || directSearchURL || desiredURL
    const previousHost = resolveURLHost(previousRequestedURL || webContents.getURL())
    const desiredHost = resolveURLHost(effectiveDesiredURL)
    if (
      (!isSearchRequest && !String(request.command || '').trim() && !String(request.query || '').trim()) ||
      (desiredHost && previousHost && desiredHost !== previousHost)
    ) {
      resetSearchWorkflowRuntime(session)
    }
    let navigated = false
    if (effectiveDesiredURL && effectiveDesiredURL !== webContents.getURL()) {
      session.lastRequestedURL = effectiveDesiredURL
      session.lastError = 'The built-in browser page is still loading; please wait.'
      this.emitPanelState(profileId)
      try {
        const navigationResult = await settleWithSoftTimeout(
          webContents.loadURL(effectiveDesiredURL),
          navigationTimeoutMs,
        )
        if (navigationResult.status === 'resolved') {
          navigated = true
        } else if (navigationResult.status === 'timed_out') {
          session.lastError = ''
          session.lastRuntime = {
            ...(session.lastRuntime || {}),
            navigation: {
              stage: 'pending',
              requested_url: effectiveDesiredURL,
              current_url: webContents.getURL(),
            },
          }
          this.emitPanelState(profileId)
        } else {
          throw navigationResult.error
        }
      } catch (error) {
        session.lastError = String(error?.message || error || 'Failed to load the target page')
        this.emitPanelState(profileId)
      }
    } else {
      webContents.focus()
    }
    if (isSearchRequest) {
      session.lastRuntime = {
        ...(session.lastRuntime || {}),
        search_workflow: {
          stage: 'running',
          query: String(request.query || '').trim(),
          adapter: String(request.adapter || '').trim(),
          requested_url: effectiveDesiredURL,
          direct_url: directSearchURL,
          current_url: webContents.getURL(),
        },
      }
      try {
        const html = await this.capturePageHTML(profileId, webContents)
        const result = buildSearchWorkflowResultFromPage({
          pageURL: String(webContents.getURL?.() || ''),
          pageTitle: String(webContents.getTitle?.() || ''),
          html,
          directURL: directSearchURL,
        })
        session.lastRuntime = {
          ...(session.lastRuntime || {}),
          search_workflow: {
            stage: result?.applied ? 'submitted' : 'blocked',
            query: String(request.query || '').trim(),
            adapter: String(request.adapter || '').trim(),
            requested_url: effectiveDesiredURL,
            direct_url: directSearchURL,
            current_url: webContents.getURL(),
            ...(result && typeof result === 'object' ? result : {}),
          },
        }
        if (result?.applied) {
          session.lastError = ''
        } else if (result?.reason === 'search_url_unavailable') {
          session.lastError = 'This site does not yet support automatic search-result navigation. Please open the search results page manually and continue.'
        } else if (result?.reason && result.reason !== 'already_on_search_page') {
          session.lastError = navigated
            ? `Automatic search did not complete: ${String(result.reason)}`
            : `Automatic search did not start: ${String(result.reason)}`
        }
      } catch (error) {
        session.lastError = String(error?.message || error || 'In-site automatic search failed')
        session.lastRuntime = {
          ...(session.lastRuntime || {}),
          search_workflow: {
            stage: 'failed',
            query: String(request.query || '').trim(),
            adapter: String(request.adapter || '').trim(),
            requested_url: effectiveDesiredURL,
            direct_url: directSearchURL,
            current_url: webContents.getURL(),
            error: String(error?.message || error || 'In-site automatic search failed'),
          },
        }
      }
    }
    this.emitPanelState(profileId)
    return this.status({ profile_id: profileId })
  }

  async openHome(request = {}) {
    return this.ensureWindow(request)
  }

  async hidePanel(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    if (normalizeProfileId(this.activeProfileId) === profileId) {
      this.detachActivePanel()
    }
    return this.status({ profile_id: profileId })
  }

  async goBack(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    const webContents = this.getSessionWebContents(this.getSession(profileId))
    if (webContents && !webContents.isDestroyed()) {
      const history = webContents.navigationHistory
      if (typeof history?.goBack === 'function') {
        if (typeof history.canGoBack !== 'function' || history.canGoBack()) {
          history.goBack()
        }
      } else if (typeof webContents.goBack === 'function') {
        webContents.goBack()
      }
      this.emitPanelState(profileId)
    }
    return this.status({ profile_id: profileId })
  }

  async goForward(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    const webContents = this.getSessionWebContents(this.getSession(profileId))
    if (webContents && !webContents.isDestroyed()) {
      const history = webContents.navigationHistory
      if (typeof history?.goForward === 'function') {
        if (typeof history.canGoForward !== 'function' || history.canGoForward()) {
          history.goForward()
        }
      } else if (typeof webContents.goForward === 'function') {
        webContents.goForward()
      }
      this.emitPanelState(profileId)
    }
    return this.status({ profile_id: profileId })
  }

  async reload(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    const webContents = this.getSessionWebContents(this.getSession(profileId))
    if (webContents && !webContents.isDestroyed()) {
      webContents.reload()
      this.emitPanelState(profileId)
    }
    return this.status({ profile_id: profileId })
  }

  async stop(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    const session = this.getSession(profileId)
    const webContents = this.getSessionWebContents(session)
    if (webContents && !webContents.isDestroyed()) {
      webContents.stop()
      if (session) {
        session.isLoading = false
      }
      this.emitPanelState(profileId)
    }
    return this.status({ profile_id: profileId })
  }

  async setHostLayout(request = {}) {
    this.hostLayout = {
      leftInset: Math.max(0, Number(request.leftInset) || 0),
      topInset: Math.max(0, Number(request.topInset) || 0),
      rightInset: Math.max(0, Number(request.rightInset) || 0),
    }
    this.layoutPanel(this.activeProfileId)
    this.emitPanelState(this.activeProfileId)
    return this.status({ profile_id: normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId) })
  }

  async extractPageContext(request = {}) {
    const profileId = normalizeProfileId(request.profile_id || request.profileId || this.activeProfileId)
    const session = await this.ensureSession(profileId)
    const webContents = this.getSessionWebContents(session)
    if (!webContents || webContents.isDestroyed()) {
      throw new Error('The built-in browser is not open yet')
    }
    const primeResult = await this.primePageForExtraction(profileId, webContents).catch(() => ({
      primed: false,
      reason: 'failed',
    }))
    const html = await this.capturePageHTML(profileId, webContents)
    const payload = buildPageContextFromHTML({
      html,
      pageURL: String(webContents.getURL?.() || ''),
      pageTitle: String(webContents.getTitle?.() || ''),
      command: request.command,
      entityType: request.entity_type,
      query: request.query,
      maxPreviewLength: request.max_preview_length,
      maxContentLength: request.max_content_length,
      maxLinks: request.max_links,
    })
    return {
      profile_id: profileId,
      extraction_prime: primeResult,
      ...payload,
    }
  }

  partitionSession(profileId) {
    return session.fromPartition(`persist:kition-browser-${normalizeProfileId(profileId)}`)
  }

  recordVisit(profileId) {
    if (!this.siteRegistry) {
      return
    }
    const webContents = this.getSessionWebContents(this.getSession(profileId))
    const url = String(webContents?.getURL?.() || '')
    if (!/^https?:\/\//i.test(url)) {
      return
    }
    try {
      const record = this.siteRegistry.upsertVisit({
        url,
        title: String(webContents.getTitle?.() || ''),
        provider: this.providerKey,
        profileId,
      })
      if (record) {
        void this.refreshLoginStatusForHost(record.host, profileId)
      }
    } catch {
      // Visit tracking is best-effort and must never break navigation.
    }
  }

  recordFavicon(profileId, favicons = []) {
    if (!this.siteRegistry) {
      return
    }
    const webContents = this.getSessionWebContents(this.getSession(profileId))
    const host = resolveURLHost(String(webContents?.getURL?.() || ''))
    if (!host) {
      return
    }
    const favicon = (Array.isArray(favicons) ? favicons : []).find(
      (item) => /^https?:\/\//i.test(String(item || '')),
    )
    if (!favicon) {
      return
    }
    try {
      this.siteRegistry.setFavicon(host, profileId, favicon)
    } catch {
      // Favicon capture is best-effort.
    }
  }

  async probeLoginStatus(host, profileId) {
    const target = String(host || '').trim().toLowerCase().replace(/^www\./, '')
    if (!target) {
      return false
    }
    try {
      const cookies = await this.partitionSession(profileId).cookies.get({})
      return cookies.some((cookie) => cookieDomainMatchesHost(cookie.domain, target))
    } catch {
      return false
    }
  }

  async refreshLoginStatusForHost(host, profileId) {
    if (!this.siteRegistry) {
      return false
    }
    const loggedIn = await this.probeLoginStatus(host, profileId)
    try {
      this.siteRegistry.setLoginStatus(host, profileId, loggedIn)
    } catch {
      // Login status is best-effort metadata only.
    }
    return loggedIn
  }

  async clearSiteCookies(host, profileId) {
    const target = String(host || '').trim().toLowerCase().replace(/^www\./, '')
    if (!target) {
      return
    }
    const partitionSession = this.partitionSession(profileId)
    try {
      const cookies = await partitionSession.cookies.get({})
      await Promise.all(
        cookies
          .filter((cookie) => cookieDomainMatchesHost(cookie.domain, target))
          .map((cookie) => {
            const domain = String(cookie.domain || '').replace(/^\./, '')
            const cookieURL = `http${cookie.secure ? 's' : ''}://${domain}${cookie.path || '/'}`
            return partitionSession.cookies.remove(cookieURL, cookie.name).catch(() => {})
          }),
      )
    } catch {
      // Ignore cookie removal failures.
    }
    try {
      await partitionSession.clearStorageData({ origin: `https://${target}` })
    } catch {
      // Ignore storage clearing failures.
    }
  }

  async shutdown() {
    this.detachActivePanel()
    for (const session of this.sessions.values()) {
      if (this.hasLiveSessionSurface(session)) {
        try {
          session.view.webContents.close({ waitForBeforeUnload: false })
        } catch {
          // Ignore close errors during app shutdown.
        }
      }
      session.view = null
    }
    this.sessions.clear()
  }
}

export const __genericBrowserSessionTestUtils = {
  buildSearchWorkflowResultFromPage,
  buildPageContextFromHTML,
  detectSearchBlockingState,
  normalizeTargetURL,
  normalizeProfileId,
  looksLikeSearchResultsURL,
  resetSearchWorkflowRuntime,
  resolveAddressBarURL,
  resolveDirectSearchResultsURL,
  resolveURLHost,
}
