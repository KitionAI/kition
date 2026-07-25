   
                  
  
                 
               
                       
                       
                         
                                        
  
                                                  
   

export type WikilinkParsed = {
                              
  raw: string
                     
  embed: boolean
                           
  target: string
                     
  heading?: string
                      
  blockId?: string
                   
  display?: string
                                     
  from: number
  to: number
}

const WIKILINK_RE = /(!?)\[\[([^\]\n]+)\]\]/g

export function parseWikilinks(source: string): WikilinkParsed[] {
  const results: WikilinkParsed[] = []
  WIKILINK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_RE.exec(source)) !== null) {
    const [raw, bang, inner] = match
    const parsed = parseWikilinkInner(inner)
    results.push({
      raw,
      embed: bang === '!',
      target: parsed.target,
      heading: parsed.heading,
      blockId: parsed.blockId,
      display: parsed.display,
      from: match.index,
      to: match.index + raw.length,
    })
  }
  return results
}

export function parseWikilinkInner(inner: string): {
  target: string
  heading?: string
  blockId?: string
  display?: string
} {
  let main = inner
  let display: string | undefined

  const pipeIdx = main.indexOf('|')
  if (pipeIdx >= 0) {
    display = main.slice(pipeIdx + 1).trim()
    main = main.slice(0, pipeIdx)
  }

  let heading: string | undefined
  let blockId: string | undefined

  const hashIdx = main.indexOf('#')
  if (hashIdx >= 0) {
    const tail = main.slice(hashIdx + 1)
    main = main.slice(0, hashIdx)
    if (tail.startsWith('^')) {
      blockId = tail.slice(1).trim()
    } else {
      heading = tail.trim()
    }
  }

  return {
    target: main.trim(),
    heading,
    blockId,
    display,
  }
}
