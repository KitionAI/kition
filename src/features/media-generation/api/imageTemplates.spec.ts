import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildImageTemplateCatalogURL,
  clearImageTemplateCatalogCache,
  listImageTemplates,
  getImageTemplate,
} from './imageTemplates'

afterEach(() => {
  clearImageTemplateCatalogCache()
  vi.restoreAllMocks()
})

describe('Kition Cloud image template catalog', () => {
  it('keeps list payloads bounded and excludes private prompt recipes', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/cloud/image-template-catalog.schema.json'),
      'utf8',
    ))
    const serialized = JSON.stringify(schema)

    expect(schema.$id).toBe('https://kition.ai/contracts/cloud/image-template-catalog.schema.json')
    expect(schema.properties.items.maxItems).toBe(100)
    expect(schema.$defs.template.properties.variables.maxItems).toBe(32)
    expect(serialized).not.toContain('prompt_recipe')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('access_token')
  })

  it('builds a server-search and cursor-pagination query', () => {
    const url = buildImageTemplateCatalogURL({
      cursor: 'page-2',
      endpoint: 'https://cloud.test/api/media/image-templates',
      hasReferenceImage: true,
      hasSelectionText: false,
      limit: 30,
      locale: 'zh-CN',
      operation: 'edit',
      query: 'product poster',
      surface: 'whiteboard',
    })

    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      cursor: 'page-2',
      has_reference_image: 'true',
      has_selection_text: 'false',
      limit: '30',
      locale: 'zh-CN',
      operation: 'edit',
      query: 'product poster',
      surface: 'whiteboard',
    })
  })

  it('uses account authorization and ETag revalidation', async () => {
    const catalog = {
      catalog_revision: 'catalog-1',
      total_count: 541,
      items: [template()],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { ETag: '"catalog-1"' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetchMock)
    const query = {
      accessToken: 'account-token',
      endpoint: 'https://cloud.test/api/media/image-templates',
      locale: 'en-US',
      surface: 'document' as const,
    }

    expect(await listImageTemplates(query)).toEqual(catalog)
    expect(await listImageTemplates(query)).toEqual(catalog)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer account-token',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'If-None-Match': '"catalog-1"',
    })
  })
  it('never reuses another account or anonymous ETag', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ catalog_revision: 'r1', items: [template()] }), {
      headers: { ETag: '"private-1"' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    for (const accessToken of ['account-a', 'account-b', undefined]) {
      await listImageTemplates({ locale: 'en-US', surface: 'table', accessToken })
    }
    for (const call of fetchMock.mock.calls) expect(call[1].headers['If-None-Match']).toBeUndefined()
  })

  it('honors no-store responses', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ catalog_revision: 'r1', items: [] }), {
      headers: { ETag: '"r1"', 'Cache-Control': 'no-store' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const query = { locale: 'en-US', surface: 'table' as const }
    await listImageTemplates(query)
    await listImageTemplates(query)
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBeUndefined()
  })

  it.each([
    { access: 'unlimited' }, { default_quality: 'invalid' },
    { thumbnail: { url: 'javascript:alert(1)', width: 0, height: 1 } },
    { variables: [{ key: 'subject', label: 'Subject' }] },
  ])('rejects malformed catalog values: %j', async (invalid) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ catalog_revision: 'r1', items: [{ ...template(), ...invalid }] }))))
    await expect(listImageTemplates({ locale: 'en-US', surface: 'document' })).rejects.toThrow('invalid response')
  })

  it('revalidates an immutable detail version and rejects version substitution', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(template())))
    vi.stubGlobal('fetch', fetchMock)
    expect(await getImageTemplate({ id: 'launch-poster', version: '1', locale: 'en-US' })).toMatchObject({ id: 'launch-poster', version: '1' })
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store')
    await expect(getImageTemplate({ id: 'launch-poster', version: '2', locale: 'en-US' })).rejects.toThrow('version does not match')
  })

})

function template() {
  return {
    id: 'launch-poster',
    version: '1',
    title: 'Launch poster',
    description: 'A focused product launch poster.',
    operation: 'generate',
    category: 'poster',
    thumbnail: {
      url: 'https://cloud.test/templates/launch-poster.webp',
      width: 480,
      height: 640,
    },
    default_aspect_ratio: '3:4',
    default_quality: 'medium',
    default_resolution: '1K',
    default_text_mode: 'no_text',
    requires_reference_image: false,
    access: 'public',
    variables: [],
    tags: ['poster'],
  }
}
