import path from 'node:path'

export function inferWorkspaceDocumentFormat(relativePath) {
  const extension = path.extname(String(relativePath || '')).toLowerCase()
  switch (extension) {
    case '.kitable':
      return 'data'
    case '.kiboard':
      return 'board'
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.docx':
      return 'docx'
    case '.xlsx':
    case '.xls':
      return 'xlsx'
    case '.pptx':
    case '.ppt':
      return 'pptx'
    case '.pdf':
      return 'pdf'
    case '.csv':
    case '.tsv':
      return 'csv'
    case '.json':
      return 'json'
    case '.txt':
      return 'text'
    case '.html':
    case '.htm':
      return 'html'
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.svg':
      return 'image'
    case '.mp4':
    case '.mov':
    case '.webm':
      return 'video'
    case '.mp3':
    case '.wav':
    case '.m4a':
      return 'audio'
    default:
      return 'binary'
  }
}

export function isEditableWorkspaceDocument(relativePath) {
  return /\.(md|markdown|kitable|kiboard)$/i.test(String(relativePath || ''))
}

export function isTextWorkspaceDocument(relativePath) {
  return /\.(md|markdown|kiboard|txt|csv|tsv|json|html|htm)$/i.test(String(relativePath || ''))
}

export function isSupportedWorkspaceDocument(relativePath) {
  return /\.(md|markdown|kitable|kiboard|txt|csv|tsv|json|html|htm|pdf|docx|xlsx|xls|pptx|ppt|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a)$/i.test(String(relativePath || ''))
}
