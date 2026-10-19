import { normalizeHawkClipboardHtml } from './clipboardHawkHtml'

/** Normalize explicit HTML editor and accessibility semantics before conversion. */
export function normalizeClipboardHtmlStructure(root: HTMLElement) {
  normalizeHawkClipboardHtml(root)
  function retag(element: Element, tag: string) {
    const replacement = root.ownerDocument.createElement(tag)
    for (const attribute of Array.from(element.attributes)) replacement.setAttribute(attribute.name, attribute.value)
    replacement.append(...Array.from(element.childNodes))
    element.replaceWith(replacement)
    return replacement
  }

  for (const heading of Array.from(root.querySelectorAll('[role="heading"][aria-level]'))) {
    const level = Number(heading.getAttribute('aria-level'))
    if (Number.isInteger(level) && level >= 1 && level <= 6) retag(heading, `h${level}`)
  }
  for (const list of Array.from(root.querySelectorAll('[role="list"]'))) {
    if (!['UL', 'OL'].includes(list.tagName)) retag(list, 'ul')
  }
  for (const item of Array.from(root.querySelectorAll('[role="listitem"]'))) {
    if (item.tagName !== 'LI' && item.parentElement?.matches('ul, ol')) retag(item, 'li')
  }
  for (const table of Array.from(root.querySelectorAll('[role="table"]'))) {
    for (const node of Array.from(table.querySelectorAll('[role]'))) {
      const tags: Record<string, string> = { rowgroup: 'tbody', row: 'tr', cell: 'td', columnheader: 'th', rowheader: 'th' }
      const tag = tags[node.getAttribute('role') || '']
      if (tag) retag(node, tag)
    }
    if (table.tagName !== 'TABLE') retag(table, 'table')
  }
  for (const image of Array.from(root.querySelectorAll('img'))) {
    if (!image.getAttribute('src') && image.getAttribute('data-src')) {
      image.setAttribute('src', image.getAttribute('data-src')!)
    }
  }
}
