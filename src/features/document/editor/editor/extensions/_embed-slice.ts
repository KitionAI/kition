   
                     
  
                                                       
                                         
                
  
               
   

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/
const MAX_DEFAULT_LINES = 80
const BLOCK_CTX = 3

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function sliceForEmbed(
  content: string,
  heading: string | undefined,
  blockId: string | undefined,
): string {
  const lines = content.split(/\r?\n/)
  if (heading) {
    const target = heading.toLowerCase()
    let startIdx = -1
    let startLevel = 0
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(HEADING_RE)
      if (m && m[2].toLowerCase() === target) {
        startIdx = i
        startLevel = m[1].length
        break
      }
    }
    if (startIdx === -1) return ''
    let end = lines.length
    for (let i = startIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(HEADING_RE)
      if (m && m[1].length <= startLevel) {
        end = i
        break
      }
    }
    return lines.slice(startIdx, end).join('\n')
  }
  if (blockId) {
    const re = new RegExp(`\\s\\^${escapeRegExp(blockId)}\\s*$`)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const from = Math.max(0, i - BLOCK_CTX)
        const to = Math.min(lines.length, i + BLOCK_CTX + 1)
        return lines.slice(from, to).join('\n')
      }
    }
    return ''
  }
  return lines.slice(0, MAX_DEFAULT_LINES).join('\n')
}
