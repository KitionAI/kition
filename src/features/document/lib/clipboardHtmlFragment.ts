/**
 * The copied part of clipboard HTML, between the StartFragment/EndFragment
 * markers; CF_HTML producers may include context outside the selection.
 */
export function clipboardHtmlFragment(html: string) {
  const start = /<!--\s*StartFragment\s*-->/i.exec(html)
  const end = /<!--\s*EndFragment\s*-->/i.exec(html)
  return start && end && end.index > start.index
    ? html.slice(start.index + start[0].length, end.index)
    : html
}
