   
         
  
                                               
                  
                                                            
                                          
  
                                 
   

import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

export type IframeSpan = {
                                  
  from: number
                                    
  to: number
                    
  src: string
}

export type AudioLinkSpan = {
                      
  from: number
                        
  to: number
                
  label: string
                    
  href: string
                        
  ext: string
}

const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac'])

function buildLineOffsets(source: string): number[] {
  const lines = source.split('\n')
  const offsets: number[] = []
  let off = 0
  for (const ln of lines) {
    offsets.push(off)
    off += ln.length + 1
  }
  return offsets
}

   
                                                    
                        
   
export function findIframeSpans(source: string): IframeSpan[] {
  const spans: IframeSpan[] = []
  const lines = source.split('\n')
  const lineFrom = buildLineOffsets(source)

                                           
  const inFence: boolean[] = new Array(lines.length).fill(false)
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      fence = !fence
      inFence[i] = true
      continue
    }
    inFence[i] = fence
  }

                                                      
  const re = /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const from = m.index
    const to = from + m[0].length
                                 
    let overlap = false
    const fromLine = findLineByOffset(lineFrom, from)
    const toLine = findLineByOffset(lineFrom, to - 1)
    for (let li = fromLine; li <= toLine; li++) {
      if (inFence[li]) {
        overlap = true
        break
      }
    }
    if (overlap) continue
    const srcMatch = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(m[0])
    spans.push({ from, to, src: srcMatch?.[1] ?? '' })
  }
  return spans
}

function findLineByOffset(lineFrom: number[], offset: number): number {
       
  let lo = 0
  let hi = lineFrom.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineFrom[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

   
                                           
                                  
   
export function findAudioLinks(source: string): AudioLinkSpan[] {
  const spans: AudioLinkSpan[] = []
  const lines = source.split('\n')
  const lineFrom = buildLineOffsets(source)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
             
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const re = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const href = m[2]
      const dot = href.lastIndexOf('.')
      if (dot === -1) continue
      const ext = href.slice(dot + 1).toLowerCase().replace(/[?#].*$/, '')
      if (!AUDIO_EXTS.has(ext)) continue
      spans.push({
        from: lineFrom[i] + m.index,
        to: lineFrom[i] + m.index + m[0].length,
        label: m[1],
        href,
        ext,
      })
    }
  }
  return spans
}

class IframeHintWidget extends WidgetType {
  constructor(private readonly src: string) {
    super()
  }
  eq(other: IframeHintWidget): boolean {
    return other.src === this.src
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-document-iframe-hint'
    el.textContent = '⧉ iframe'
    el.title = this.src ? `iframe src=${this.src}` : 'iframe'
    el.style.cssText = [
      'display:inline-block',
      'margin-left:0.4em',
      'padding:0 0.4em',
      'font-size:0.85em',
      'color:#777',
      'background:rgba(120,120,120,0.12)',
      'border-radius:3px',
      'pointer-events:none',
    ].join(';')
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

class AudioPlayWidget extends WidgetType {
  constructor(private readonly href: string) {
    super()
  }
  eq(other: AudioPlayWidget): boolean {
    return other.href === this.href
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-document-audio-play'
    el.textContent = ' ▶'
    el.title = `play ${this.href}`
    el.style.cssText = [
      'cursor:pointer',
      'color:#5a8',
      'margin-left:0.2em',
      'font-size:0.9em',
    ].join(';')
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      try {
        const a = document.createElement('audio')
        a.src = this.href
        a.controls = false
        a.autoplay = true
        a.style.display = 'none'
        document.body.appendChild(a)
        a.addEventListener('ended', () => a.remove())
        a.play().catch(() => {
          a.remove()
        })
      } catch {
        // best-effort
      }
    })
    return el
  }
  ignoreEvent(): boolean {
                       
    return false
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const items: { pos: number; deco: Decoration }[] = []
  const source = view.state.doc.toString()
  for (const iframe of findIframeSpans(source)) {
    items.push({
      pos: iframe.to,
      deco: Decoration.widget({ widget: new IframeHintWidget(iframe.src), side: 1 }),
    })
  }
  for (const audio of findAudioLinks(source)) {
    items.push({
      pos: audio.to,
      deco: Decoration.widget({ widget: new AudioPlayWidget(audio.href), side: 1 }),
    })
  }
  items.sort((a, b) => a.pos - b.pos)
  for (const { pos, deco } of items) {
    builder.add(pos, pos, deco)
  }
  return builder.finish()
}

export function mediaDecoExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = buildDecorations(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
}
