import { describe, it, expect, beforeEach } from 'vitest'
import { sanitizeEmbed } from './_embed-sanitize'

function mount(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

describe('sanitizeEmbed', () => {
  it('removes <script>, <iframe>, <object>, <embed>', () => {
    const el = mount('<p>ok</p><script>x</script><iframe></iframe><object></object><embed>')
    sanitizeEmbed(el)
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.querySelector('object')).toBeNull()
    expect(el.querySelector('embed')).toBeNull()
    expect(el.querySelector('p')?.textContent).toBe('ok')
  })

  it('sets tabindex=-1 on every <a href>', () => {
    const el = mount('<a href="https://x.com">x</a><a>no-href</a>')
    sanitizeEmbed(el)
    const links = el.querySelectorAll('a[href]')
    expect(links.length).toBe(1)
    expect(links[0].getAttribute('tabindex')).toBe('-1')
  })

  it('prevents default on click for sanitized <a href>', () => {
    const el = mount('<a href="https://x.com">x</a>')
    sanitizeEmbed(el)
    const a = el.querySelector('a')!
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })
})
