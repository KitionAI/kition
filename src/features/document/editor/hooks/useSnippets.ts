   
                     
  
                                                          
                                               
  
                  
                               
                          
                            
                                 
   

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'kition.document.snippets'
const EVENT = 'kition:document:snippets-changed'

export type Snippet = {
  trigger: string
  expansion: string
}

function readRaw(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultSnippets()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
        .filter((it) => it && typeof it.trigger === 'string' && typeof it.expansion === 'string')
        .map((it) => ({ trigger: String(it.trigger), expansion: String(it.expansion) }))
    }
  } catch {
    /* ignore */
  }
  return defaultSnippets()
}

function defaultSnippets(): Snippet[] {
  return [
    { trigger: ':date', expansion: '{{date}}' },
    { trigger: ':time', expansion: '{{time}}' },
    { trigger: ':todo', expansion: '- [ ] {{cursor}}' },
    { trigger: ':sig', expansion: '— signed on {{date}}' },
  ]
}

function writeRaw(items: Snippet[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore */
  }
}

export function loadSnippets(): Snippet[] {
  return readRaw()
}

export function saveSnippets(items: Snippet[]) {
  const cleaned = items
    .map((it) => ({ trigger: it.trigger.trim(), expansion: it.expansion }))
    .filter((it) => it.trigger.length > 0)
  writeRaw(cleaned)
}

export function addSnippet(trigger: string, expansion: string) {
  const t = trigger.trim()
  if (!t) return
  const list = loadSnippets().filter((s) => s.trigger !== t)
  list.push({ trigger: t, expansion })
  writeRaw(list)
}

export function removeSnippet(trigger: string) {
  const next = loadSnippets().filter((s) => s.trigger !== trigger)
  writeRaw(next)
}

export function useSnippets(): Snippet[] {
  const [items, setItems] = useState<Snippet[]>(() => loadSnippets())
  useEffect(() => {
    const handler = () => setItems(loadSnippets())
    window.addEventListener(EVENT, handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener(EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [])
  return items
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export type ExpandContext = {
  title?: string
}

export function expandSnippet(
  expansion: string,
  ctx: ExpandContext = {},
): { text: string; cursorOffset: number } {
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  let body = expansion
    .replaceAll('{{date}}', date)
    .replaceAll('{{time}}', time)
    .replaceAll('{{title}}', ctx.title ?? '')
  const cursorIdx = body.indexOf('{{cursor}}')
  if (cursorIdx >= 0) {
    body = body.slice(0, cursorIdx) + body.slice(cursorIdx + '{{cursor}}'.length)
    return { text: body, cursorOffset: cursorIdx }
  }
  return { text: body, cursorOffset: body.length }
}

export function useSnippetsActions() {
  const set = useCallback((items: Snippet[]) => saveSnippets(items), [])
  const add = useCallback((trigger: string, expansion: string) => addSnippet(trigger, expansion), [])
  const remove = useCallback((trigger: string) => removeSnippet(trigger), [])
  return { set, add, remove }
}
