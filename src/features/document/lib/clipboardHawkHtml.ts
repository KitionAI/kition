const HAWK_LIST = 'ul.hk-bullet-list-node, ol.hk-ordered-list-node'

/** Hawk exports one list container per paragraph, with depth stored in attributes. */
function normalizeLists(root: HTMLElement) {
  const document = root.ownerDocument
  const parents = new Set(Array.from(root.querySelectorAll(HAWK_LIST)).map((list) => list.parentElement!))
  for (const parent of parents) {
    const counters = new Map<string, number>()
    let stack: Array<{ depth: number; list: HTMLElement; lastItem: HTMLElement; id: string }> = []
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue
      if (!(node instanceof HTMLElement) || !node.matches(HAWK_LIST)) {
        stack = []
        continue
      }
      // Already-semantic lists must not acquire another level on repeated parsing.
      if (Array.from(node.children).some((child) => child.tagName === 'LI')) {
        stack = []
        continue
      }
      const rawDepth = Number(node.getAttribute('data-hk-indent') || 0)
      const depth = Number.isInteger(rawDepth) && rawDepth >= 0 ? Math.min(rawDepth, 64) : 0
      const id = node.getAttribute('data-hk-list-id') || ''
      const counterKey = `${depth}:${id}`
      const ordered = node.tagName === 'OL'
      const rawStart = node.getAttribute('start') ?? node.getAttribute('data-hk-list-start')
      const start = rawStart !== null && /^\d+$/.test(rawStart) ? Number(rawStart) : undefined
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop()
      let current = stack[stack.length - 1]
      if (current?.depth === depth && (current.list.tagName !== node.tagName
        || (ordered && (current.id !== id || start !== undefined)))) {
        stack.pop()
        current = stack[stack.length - 1]
      }
      if (!current || current.depth !== depth) {
        const list = document.createElement(ordered ? 'ol' : 'ul')
        if (ordered) list.setAttribute('start', String(start ?? (id ? counters.get(counterKey) : undefined) ?? 1))
        if (current) current.lastItem.append(list)
        else parent.insertBefore(list, node)
        current = { depth, list, lastItem: document.createElement('li'), id }
        stack.push(current)
      }
      const item = document.createElement('li')
      item.append(...Array.from(node.childNodes))
      const paragraph = item.firstElementChild
      if (item.children.length === 1 && paragraph?.tagName === 'P') {
        paragraph.replaceWith(...Array.from(paragraph.childNodes))
      }
      current.list.append(item)
      current.lastItem = item
      if (ordered && id) counters.set(counterKey, Number(current.list.getAttribute('start')) + current.list.children.length)
      node.remove()
    }
  }
}

export function normalizeHawkClipboardHtml(root: HTMLElement) {
  const document = root.ownerDocument
  for (const block of Array.from(root.querySelectorAll('div.hk-code-block-node'))) {
    const lines = Array.from(block.children).map((line) => {
      const clone = line.cloneNode(true) as HTMLElement
      clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
      return (clone.textContent || '').replace(/\n$/, '')
    })
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    const language = block.getAttribute('data-hk-lang') || ''
    if (/^[\w+-]+$/.test(language)) code.className = `language-${language}`
    code.textContent = `${lines.length ? lines.join('\n') : block.textContent || ''}\n`
    pre.append(code)
    block.replaceWith(pre)
  }
  for (const heading of Array.from(root.querySelectorAll('h1[data-hk-heading], h2[data-hk-heading], h3[data-hk-heading], h4[data-hk-heading], h5[data-hk-heading], h6[data-hk-heading]'))) {
    for (const paragraph of Array.from(heading.querySelectorAll('p'))) {
      paragraph.replaceWith(...Array.from(paragraph.childNodes))
    }
  }
  const marks = { 'data-hk-font-bold': 'strong', 'data-hk-font-strike': 'del', 'data-hk-font-italic': 'em' }
  for (const [attribute, tag] of Object.entries(marks)) {
    for (const mark of Array.from(root.querySelectorAll(`[${attribute}="true"]`))) {
      const wrapper = document.createElement(tag)
      wrapper.append(...Array.from(mark.childNodes))
      mark.append(wrapper)
      mark.removeAttribute(attribute)
    }
  }
  normalizeLists(root)
}
