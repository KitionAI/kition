   
                                                      
                                      
                                                
                                            
   
import { getCurrentLocale } from '@/i18n'

export type PdfExportPageFormat = 'a4' | 'a3' | 'a5' | 'letter' | 'legal' | 'tabloid'

type BuildOptions = {
  title: string
  bodyHtml: string
  includeName: boolean
  pageFormat: PdfExportPageFormat
  landscape: boolean
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const pageSizeLabel: Record<PdfExportPageFormat, string> = {
  a4: 'A4',
  a3: 'A3',
  a5: 'A5',
  letter: 'Letter',
  legal: 'Legal',
  tabloid: 'Tabloid',
}

export function buildPdfExportHtml(options: BuildOptions): string {
  const size = pageSizeLabel[options.pageFormat]
  const sizeRule = `${size}${options.landscape ? ' landscape' : ''}`
  const titleHeading = options.includeName
    ? `<h1 class="export-title">${escapeHtml(options.title)}</h1>`
    : ''

  return `<!doctype html>
<html lang="${getCurrentLocale()}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(options.title || 'Kition Export')}</title>
<style>
@page { size: ${sizeRule}; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; color: #111827; }
body.print { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; }
.markdown-preview-view { padding: 18mm 16mm; }
.markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3,
.markdown-preview-view h4, .markdown-preview-view h5, .markdown-preview-view h6 {
  margin: 1.4em 0 0.55em; line-height: 1.25; font-weight: 700;
}
.markdown-preview-view h1 { font-size: 2rem; margin-top: 0; }
.markdown-preview-view h2 { font-size: 1.45rem; }
.markdown-preview-view h3 { font-size: 1.2rem; }
.markdown-preview-view p, .markdown-preview-view ul, .markdown-preview-view ol,
.markdown-preview-view blockquote, .markdown-preview-view pre, .markdown-preview-view table {
  margin: 0 0 1em;
}
.markdown-preview-view a { color: #2563eb; }
.markdown-preview-view img, .markdown-preview-view video { max-width: 100%; height: auto; border-radius: 6px; }
.markdown-preview-view blockquote { border-left: 4px solid #d1d5db; padding-left: 1em; color: #4b5563; }
.markdown-preview-view code { border-radius: 4px; background: #f3f4f6; padding: 0.15em 0.35em; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.92em; }
.markdown-preview-view pre { overflow-x: auto; border-radius: 6px; background: #f3f4f6; padding: 16px; }
.markdown-preview-view pre code { background: transparent; padding: 0; }
.markdown-preview-view table { width: 100%; border-collapse: collapse; }
.markdown-preview-view th, .markdown-preview-view td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
.markdown-preview-view th { background: #f9fafb; font-weight: 600; }
.export-title { margin: 0 0 1em; font-size: 2.2rem; font-weight: 700; }
</style>
</head>
<body class="print">
<div class="markdown-preview-view markdown-rendered kition-export">
${titleHeading}${options.bodyHtml}
</div>
</body>
</html>`
}
