import { imageTemplateCatalogSchema, imageTemplateSchema } from '../lib/imageTemplateValidation'
import type {
  ImageTemplateCatalogQuery,
  ImageTemplateCatalogResponse,
} from '../lib/imageTemplateContract'

export const KITION_CLOUD_IMAGE_TEMPLATE_CATALOG_URL =
  'https://kition.ai/api/media/image-templates'

type CachedCatalog = {
  etag?: string
  response: ImageTemplateCatalogResponse
}

const catalogCache = new Map<string, CachedCatalog>()
const MAX_CACHED_QUERIES = 20

export async function listImageTemplates(
  input: ImageTemplateCatalogQuery,
): Promise<ImageTemplateCatalogResponse> {
  const url = buildImageTemplateCatalogURL(input)
  const cacheKey = `${input.accessToken?.trim() || 'anonymous'}:${url}`
  const cached = catalogCache.get(cacheKey)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': input.locale,
  }
  if (input.accessToken?.trim()) {
    headers.Authorization = `Bearer ${input.accessToken.trim()}`
  }
  if (cached?.etag) headers['If-None-Match'] = cached.etag

  const response = await fetch(url, {
    headers,
    signal: input.signal,
  })
  if (response.status === 304 && cached) {
    if (/no-store/i.test(response.headers.get('cache-control') || '')) catalogCache.delete(cacheKey)
    return cached.response
  }
  if (!response.ok) {
    throw new Error(`Image template catalog request failed (${response.status})`)
  }

  const payload = await response.json() as unknown
  const catalog = readImageTemplateCatalogResponse(payload)
  if (!catalog) throw new Error('Image template catalog returned an invalid response')
  catalogCache.delete(cacheKey)
  if (!/no-store/i.test(response.headers.get('cache-control') || '')) catalogCache.set(cacheKey, {
    etag: response.headers.get('etag') || undefined,
    response: catalog,
  })
  pruneCatalogCache()
  return catalog
}

export function buildImageTemplateCatalogURL(input: ImageTemplateCatalogQuery) {
  const url = new URL(input.endpoint || KITION_CLOUD_IMAGE_TEMPLATE_CATALOG_URL)
  url.searchParams.set('locale', input.locale)
  url.searchParams.set('surface', input.surface)
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, input.limit || 24))))
  if (input.cursor) url.searchParams.set('cursor', input.cursor)
  if (input.query?.trim()) url.searchParams.set('query', input.query.trim())
  if (input.operation) url.searchParams.set('operation', input.operation)
  if (input.hasReferenceImage !== undefined) {
    url.searchParams.set('has_reference_image', String(input.hasReferenceImage))
  }
  if (input.hasSelectionText !== undefined) {
    url.searchParams.set('has_selection_text', String(input.hasSelectionText))
  }
  return url
}

export function clearImageTemplateCatalogCache() {
  catalogCache.clear()
}

function readImageTemplateCatalogResponse(value: unknown): ImageTemplateCatalogResponse | null {
  const unwrapped = value && typeof value === 'object' && 'data' in value
    ? (value as { data?: unknown }).data
    : value
  const parsed = imageTemplateCatalogSchema.safeParse(unwrapped)
  return parsed.success ? parsed.data : null
}

// Revalidate the pinned version before sending; entitlement is also enforced
// by the runtime when it resolves the server-owned recipe.
export async function getImageTemplate(
  input: Pick<ImageTemplateCatalogQuery, 'accessToken' | 'endpoint' | 'locale' | 'signal'>
    & { id: string; version: string },
) {
  const url = new URL(`${input.endpoint || KITION_CLOUD_IMAGE_TEMPLATE_CATALOG_URL}/${encodeURIComponent(input.id)}`)
  url.searchParams.set('version', input.version)
  url.searchParams.set('locale', input.locale)
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': input.locale,
      ...(input.accessToken?.trim() ? { Authorization: `Bearer ${input.accessToken.trim()}` } : {}),
    },
    cache: 'no-store',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`Image template unavailable (${response.status})`)
  const payload = await response.json()
  const template = imageTemplateSchema.parse(payload?.data ?? payload)
  if (template.id !== input.id || template.version !== input.version) {
    throw new Error('Image template version does not match the requested version')
  }
  return template
}

function pruneCatalogCache() {
  while (catalogCache.size > MAX_CACHED_QUERIES) {
    const oldest = catalogCache.keys().next().value
    if (!oldest) break
    catalogCache.delete(oldest)
  }
}
