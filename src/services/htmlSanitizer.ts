import DOMPurify from 'dompurify'

const SAFE_URL_PATTERN = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|kition-workspace|kition-bundled):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

export function sanitizeRenderedHtml(html: string): string {
  if (!html) return ''

  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: SAFE_URL_PATTERN,
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: true,
    FORBID_ATTR: ['srcdoc'],
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style'],
    RETURN_TRUSTED_TYPE: false,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    USE_PROFILES: { html: true },
  })
}
