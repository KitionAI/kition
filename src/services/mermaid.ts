/**
 * Mermaid rendering service.
 *
 * The mermaid library is heavy (~800KB), so it is loaded on demand the first
 * time a diagram needs to be rendered.
 */

type MermaidModule = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidModule> | null = null
let renderCounter = 0

                                                      
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw ? `hsl(${raw})` : fallback
}

   
                                                               
                                                     
                                             
   
function applyTheme(mermaid: MermaidModule) {
  const isDark = typeof document !== 'undefined'
    && document.documentElement.classList.contains('dark')
  const nodeFill = cssVar('--card', isDark ? 'hsl(220 12% 15%)' : 'hsl(0 0% 100%)')
  const border = cssVar('--primary', 'hsl(247 63% 55%)')
  const text = cssVar('--foreground', isDark ? 'hsl(210 14% 94%)' : 'hsl(0 0% 10%)')
  const line = cssVar('--muted-foreground', 'hsl(220 8% 60%)')
  const bg = cssVar('--background', isDark ? 'hsl(220 13% 12%)' : 'hsl(0 0% 100%)')
  const clusterBorder = cssVar('--border', 'hsl(220 10% 23%)')

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'inherit',
    suppressErrorRendering: true,
    themeVariables: {
      darkMode: isDark,
      background: 'transparent',
      fontFamily: 'inherit',
      primaryColor: nodeFill,
      mainBkg: nodeFill,
      secondaryColor: nodeFill,
      tertiaryColor: nodeFill,
      primaryBorderColor: border,
      nodeBorder: border,
      primaryTextColor: text,
      nodeTextColor: text,
      textColor: text,
      titleColor: text,
      lineColor: line,
      edgeLabelBackground: bg,
      clusterBkg: nodeFill,
      clusterBorder,
    },
  } as Parameters<typeof mermaid.initialize>[0])
}

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default)
  }
  return mermaidPromise
}

export const MERMAID_PLACEHOLDER_CLASS = 'kition-mermaid'
export const MERMAID_SOURCE_ATTR = 'data-mermaid-source'

export function encodeMermaidSource(source: string): string {
  return btoa(encodeURIComponent(source))
}

export function decodeMermaidSource(encoded: string): string {
  try {
    return decodeURIComponent(atob(encoded))
  } catch {
    return ''
  }
}

export function buildMermaidPlaceholderHtml(source: string): string {
  const encoded = encodeMermaidSource(source)
  const escaped = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div class="${MERMAID_PLACEHOLDER_CLASS}" ${MERMAID_SOURCE_ATTR}="${encoded}"><pre><code class="language-mermaid">${escaped}</code></pre></div>`
}

export async function renderMermaid(source: string, id?: string): Promise<string> {
  const trimmed = source.trim()
  if (!trimmed) {
    throw new Error('Empty mermaid source')
  }
  const mermaid = await loadMermaid()
  applyTheme(mermaid)
  const renderId = id || `kition-mermaid-${++renderCounter}-${Date.now().toString(36)}`
  try {
    // Validate syntax first via parse() so partial/streaming source rejects
    // before render() is allowed to mutate the DOM.
    await mermaid.parse(trimmed)
    const { svg } = await mermaid.render(renderId, trimmed)
    return svg
  } finally {
    cleanupMermaidArtifacts(renderId)
  }
}

function cleanupMermaidArtifacts(renderId: string) {
  if (typeof document === 'undefined') return
  // mermaid leaves a render host div (and a sandbox iframe in strict mode)
  // attached to <body> if parsing or rendering throws. Sweep them out.
  for (const candidateId of [renderId, `d${renderId}`, `i${renderId}`]) {
    const el = document.getElementById(candidateId)
    if (el?.parentElement === document.body) {
      el.remove()
    }
  }
}

function findPlaceholders(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`.${MERMAID_PLACEHOLDER_CLASS}[${MERMAID_SOURCE_ATTR}]`),
  )
}

export async function hydrateMermaidBlocks(root: HTMLElement | null): Promise<void> {
  if (!root) return
  const placeholders = findPlaceholders(root)
  if (!placeholders.length) return

  await Promise.all(
    placeholders.map(async (el) => {
      if (el.dataset.mermaidRendered === 'true') return
      const source = decodeMermaidSource(el.getAttribute(MERMAID_SOURCE_ATTR) || '')
      if (!source) return
      try {
        const svg = await renderMermaid(source)
        el.innerHTML = svg
        el.dataset.mermaidRendered = 'true'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        el.dataset.mermaidError = message
      }
    }),
  )
}

export async function inlineMermaidBlocksInHtml(html: string): Promise<string> {
  if (!html || !html.includes(MERMAID_PLACEHOLDER_CLASS)) return html
  if (typeof DOMParser === 'undefined') return html

  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html')
  const root = doc.getElementById('__root')
  if (!root) return html

  await hydrateMermaidBlocks(root)
  return root.innerHTML
}
