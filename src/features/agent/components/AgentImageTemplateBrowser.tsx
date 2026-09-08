import { useEffect, useRef, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@/components/ui'
import { listImageTemplates } from '@/features/media-generation/api/imageTemplates'
import { ImageTemplateThumbnail } from '@/features/media-generation/components/ImageTemplateThumbnail'
import type { ImageTemplateCatalogResponse, ImageTemplateSummary } from '@/features/media-generation/lib/imageTemplateContract'
import type { AgentImageGenerationSurface } from '@/types/imageGeneration'

const PAGE_SIZE = 24

export function AgentImageTemplateBrowser({ active, surface, accessToken, hasReferenceImage, onSelect, onFreeform, onSettings, onClose }: {
  active: boolean
  surface: AgentImageGenerationSurface
  accessToken?: string
  hasReferenceImage: boolean
  onSelect: (template: ImageTemplateSummary) => void
  onFreeform: () => void
  onSettings: () => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('imageGeneration')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [page, setPage] = useState<ImageTemplateCatalogResponse>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const scrollArea = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => { if (active) searchInput.current?.focus({ preventScroll: true }) }, [active])
  const cursor = cursors[cursors.length - 1]
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query)
      setCursors([undefined])
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => { setCursors([undefined]) }, [surface, accessToken, hasReferenceImage, i18n.language])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    setPage(undefined)
    void listImageTemplates({
      locale: i18n.language, surface, accessToken, hasReferenceImage,
      query: search, cursor, limit: PAGE_SIZE, signal: controller.signal,
    }).then((response) => {
      if (!controller.signal.aborted) {
        setPage(response)
        if (scrollArea.current) scrollArea.current.scrollTop = 0
      }
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [accessToken, cursor, hasReferenceImage, i18n.language, retry, search, surface])

  return (
    <section className="agent-image-browser" hidden={!active} aria-label={t('chat.templates')} data-testid="agent-image-templates">
      <div className="agent-image-panel-header">
        <strong className="text-sm font-medium">{t('chat.templates')}</strong>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onFreeform}>{t('chat.withoutTemplate')}</Button>
          <button type="button" className="agent-composer-tool size-7 !p-0" aria-label={t('chat.closeSettings')}
            onClick={onClose}><X className="size-4" aria-hidden="true" /></button>
        </div>
      </div>
      <div className="relative mx-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input ref={searchInput} aria-label={t('chat.search')} placeholder={t('chat.search')} className="pl-9"
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div ref={scrollArea} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4" aria-busy={loading}>
        {loading ? <p role="status" className="text-sm text-muted-foreground">{t('chat.loading')}</p> : null}
        {failed ? <div role="status" className="space-y-3 text-sm text-muted-foreground">
          <p>{t('chat.catalogUnavailable')}</p>
          <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('chat.retry')}</Button>
        </div> : null}
        {!loading && page?.items.length === 0 ? <p role="status">{t('gallery.empty')}</p> : null}
        <div className="agent-image-template-grid">
          {page?.items.map((template, index) => (
            <button type="button" key={`${template.id}:${template.version}`}
              className="agent-image-template-card"
              onClick={() => onSelect(template)} data-testid={`agent-image-template-${template.id}`}>
              <ImageTemplateThumbnail template={template} scrollRoot={scrollArea} priority={index < 4} />
              <span className="block p-2 text-xs">
                <strong className="line-clamp-2" title={template.title}>{template.title}</strong>
                {template.requires_reference_image ? <span className="mt-1 block text-muted-foreground" title={t('chat.referenceRequired')}>
                  {t('templateMeta.edit')}
                </span> : null}
                {template.access !== 'public' ? <span className="mt-1 block text-muted-foreground">{t(`chat.access.${template.access}`)}</span> : null}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="agent-image-panel-footer">
        <button type="button" className="agent-composer-tool" onClick={onSettings}>
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />{t('chat.imageSettings')}
        </button>
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs tabular-nums text-muted-foreground" data-testid="agent-image-template-count">
            {page ? page.total_count !== undefined
              ? page.items.length === 0 ? t('gallery.templateCount', { count: page.total_count })
                : t('chat.catalogRange', { start: (cursors.length - 1) * PAGE_SIZE + 1, end: (cursors.length - 1) * PAGE_SIZE + page.items.length, total: page.total_count })
              : t('chat.catalogPage', { page: cursors.length }) : null}
          </span>
          <Button variant="secondary" size="sm" disabled={loading || cursors.length < 2}
            onClick={() => setCursors((values) => values.slice(0, -1))}>{t('chat.previous')}</Button>
          <Button variant="secondary" size="sm" disabled={loading || !page?.next_cursor || cursors.includes(page.next_cursor)}
            onClick={() => setCursors((values) => [...values, page?.next_cursor])}>{t('chat.next')}</Button>
        </div>
      </div>
    </section>
  )
}
