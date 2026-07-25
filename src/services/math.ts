/**
 * KaTeX math rendering service.
 *
 * Lazy-loads the heavy KaTeX runtime + CSS only when the first formula needs
 * rendering. Used by the editor Live Preview extension to render $inline$ and
 * $$display$$ math blocks.
 */

type KatexModule = typeof import('katex').default

let katexPromise: Promise<KatexModule> | null = null
let cssInjected = false

async function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    katexPromise = import('katex').then((mod) => mod.default)
    if (!cssInjected && typeof document !== 'undefined') {
                                               
      void import('katex/dist/katex.min.css')
      cssInjected = true
    }
  }
  return katexPromise
}

export async function renderMath(source: string, displayMode: boolean): Promise<string> {
  const trimmed = source.trim()
  if (!trimmed) throw new Error('Empty math source')
  const katex = await loadKatex()
  return katex.renderToString(trimmed, {
    displayMode,
    throwOnError: false,
    output: 'html',
  })
}
