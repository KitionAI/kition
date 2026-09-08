import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ImageTemplateSummary } from '../lib/imageTemplateContract'

export function ImageTemplateThumbnail({ template, scrollRoot, priority = false }: {
  template: ImageTemplateSummary
  scrollRoot: RefObject<HTMLDivElement | null>
  priority?: boolean
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { root: scrollRoot.current, rootMargin: '160px 0px' })
    if (frame.current) observer.observe(frame.current)
    return () => observer.disconnect()
  }, [scrollRoot])

  return <div ref={frame} className="aspect-[4/3] w-full bg-muted">
    {visible ? <img src={template.thumbnail.url} alt={template.title}
      width={template.thumbnail.width} height={template.thumbnail.height}
      fetchPriority={priority ? 'high' : 'low'} decoding="async" referrerPolicy="no-referrer"
      className="h-full w-full object-cover" /> : null}
  </div>
}
