   
                         
  
                        
                                
               
                                   
  
                                             
   

export type FrontmatterField = {
  key: string
                                      
  value: string | string[]
                                        
  startLine: number
  endLine: number
}

export type FrontmatterParsed = {
                                                 
  from: number
  to: number
                       
  raw: string
  fields: FrontmatterField[]
}

const FENCE_RE = /^---\s*$/

export function parseFrontmatter(source: string): FrontmatterParsed | null {
                        
  const lines = source.split(/\r?\n/)
  if (lines.length === 0) return null
  if (!FENCE_RE.test(lines[0])) return null

  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return null

  const bodyLines = lines.slice(1, closeIdx)
  const fields: FrontmatterField[] = []
  let i = 0
  while (i < bodyLines.length) {
    const line = bodyLines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1
      continue
    }
                                                        
                                      
    const keyMatch = line.match(/^([^\s:#][^:]*?)\s*:\s*(.*)$/)
    if (!keyMatch) {
      i += 1
      continue
    }
    const key = keyMatch[1].trim()
    const rest = keyMatch[2]
    const startLine = i + 2 // +1 for fence, +1 for 1-based
    let endLine = startLine
    let value: string | string[]

    if (rest === '') {
               
      const items: string[] = []
      let j = i + 1
      while (j < bodyLines.length) {
        const bl = bodyLines[j]
        const m = bl.match(/^\s+-\s+(.+)$/)
        if (!m) break
        items.push(stripQuotes(m[1].trim()))
        j += 1
      }
      value = items
      endLine = j + 1
      i = j
    } else if (/^\[.*\]$/.test(rest.trim())) {
      const inner = rest.trim().slice(1, -1)
      value = inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean)
      i += 1
    } else {
      value = stripQuotes(rest.trim())
      i += 1
    }
    fields.push({ key, value, startLine, endLine })
  }

  const lineStarts = [0]
  for (const match of source.matchAll(/\r?\n/g)) {
    lineStarts.push((match.index ?? 0) + match[0].length)
  }
  const from = 0
  const to = lineStarts[closeIdx] + lines[closeIdx].length
  const raw = bodyLines.join('\n')
  return { from, to, raw, fields }
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1)
    }
  }
  return s
}
