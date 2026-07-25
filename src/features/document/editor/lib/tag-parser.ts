   
       
  
               
                                        
                       
                
                                                         
   

export type TagParsed = {
                                       
  name: string
                                        
  segments: string[]
  from: number
  to: number
  line: number
}

const TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu

export function parseTags(source: string): TagParsed[] {
  const results: TagParsed[] = []
  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(source)) !== null) {
    const [whole, prefix, name] = match
    if (!name) continue
    if (name.startsWith('/') || name.endsWith('/')) continue
    if (/^\d+$/.test(name)) continue
    const from = match.index + prefix.length
    const to = from + 1 + name.length
    const line = source.slice(0, from).split('\n').length - 1
    results.push({
      name,
      segments: name.split('/'),
      from,
      to,
      line,
    })
  }
  return results
}
