   
                   
  
                                    
                               
   

export type BlockIdParsed = {
                   
  blockId: string
                         
  from: number
  to: number
                      
  line: number
}

const BLOCK_ID_RE = /(?<=^|\s)\^([A-Za-z0-9_-]+)(?=\s|$)/gm

export function parseBlockIds(source: string): BlockIdParsed[] {
  const results: BlockIdParsed[] = []
  BLOCK_ID_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK_ID_RE.exec(source)) !== null) {
    const [raw, id] = match
    const from = match.index
    const to = from + raw.length
    const line = source.slice(0, from).split('\n').length - 1
    results.push({ blockId: id, from, to, line })
  }
  return results
}
