// An example extension (KitExtensions 1.0): one command that puts every heading of a note (the
// Note kit) in title case, through the object model, and a panel (panel.html) that lists the
// headings with a button that does the same. It needs model.read and model.write, and nothing else:
// no network, no commands of the kit.

/** Words that stay lower case inside a title. */
const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via'])

/** `text` in title case: each word capitalized, minor words lower case unless first or last. */
export function titleCase(text) {
  const words = [...text.matchAll(/[\p{L}\p{N}'’]+/gu)]
  let out = text
  words.forEach((match, index) => {
    const word = match[0]
    const lower = word.toLowerCase()
    const minor = MINOR.has(lower) && index > 0 && index < words.length - 1
    // Words with capitals past their first letter (iPhone, KPI, McKinsey) stay as written.
    const keep = word.slice(1) !== word.slice(1).toLowerCase()
    const next = keep ? word : minor ? lower : word[0].toUpperCase() + word.slice(1).toLowerCase()
    out = out.slice(0, match.index) + next + out.slice(match.index + word.length)
  })
  return out
}

/** A note's headings (`# Heading` lines outside fenced code), each with its level and where its text starts and ends, in Unicode scalar values. */
function headingsOf(body) {
  const headings = []
  let at = 0
  let fence = null
  for (const line of body.split('\n')) {
    const chars = [...line]
    const opened = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (opened && opened[1][0] === fence[0] && opened[1].length >= fence.length) fence = null
    } else if (opened) {
      fence = opened[1]
    } else {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*(?:[ \t]#+[ \t]*)?$/u.exec(line)
      if (heading && heading[2]) {
        const start = [...line.slice(0, line.indexOf(heading[2], heading[1].length))].length
        headings.push({ level: heading[1].length, text: heading[2], from: at + start, to: at + start + [...heading[2]].length })
      }
    }
    at += chars.length + 1
  }
  return headings
}

/** Every heading, as `{ level, text }`. */
async function readTitles(document) {
  return document.run(async (context) => {
    context.root.load(['body'])
    await context.sync()
    return headingsOf(context.root.body.toString()).map(({ level, text }) => ({ level, text }))
  })
}

/** Title-cases every heading; answers how many headings changed. */
async function titleCaseNote(document) {
  return document.run(async (context) => {
    const note = context.root
    note.load(['body'])
    await context.sync()
    let changed = 0
    for (const heading of headingsOf(note.body.toString())) {
      const next = titleCase(heading.text)
      if (next === heading.text) continue
      changed += 1
      // Positions count Unicode scalar values. Only the letters whose case changes are rewritten, so
      // the rest of the line (and anyone else's edits around it) stays as it is.
      const [before, after] = [[...heading.text], [...next]]
      for (let index = 0; index < before.length; index += 1) {
        if (before[index] === after[index]) continue
        note.body.insert(heading.from + index + 1, after[index])
        note.body.delete(heading.from + index, 1)
      }
    }
    await context.sync()
    return changed
  })
}

const summary = (changed) => (changed ? `Title-cased ${changed} heading${changed === 1 ? '' : 's'}` : 'Every heading is already in title case')

export function activate(ctx) {
  ctx.commands.register('titleCase.apply', async () => {
    const changed = await titleCaseNote(ctx.document)
    ctx.notify(summary(changed), { level: 'success' })
    return { changed }
  })

  // The panel asks for the headings and to title-case them; it hears new headings as the note changes.
  ctx.panels.register('titleCase.titles', (panel) => {
    panel.onRequest(async (message) => {
      if (message?.type === 'titles') return { titles: await readTitles(ctx.document) }
      if (message?.type === 'apply') {
        const changed = await titleCaseNote(ctx.document)
        return { changed, summary: summary(changed), titles: await readTitles(ctx.document) }
      }
      throw new Error(`unknown request ${JSON.stringify(message)}`)
    })
    let timer = null
    const stop = ctx.document.on('changed', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        readTitles(ctx.document).then(
          (titles) => panel.post({ type: 'titles', titles }),
          () => undefined,
        )
      }, 150)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  })
}
