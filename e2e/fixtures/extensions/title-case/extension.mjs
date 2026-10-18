// An example extension (KitExtensions 1.0): one command that puts every slide title of a Slides
// deck in title case, through the object model. It needs model.read and model.write, and nothing
// else: no network, no commands of the kit.

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

const TITLES = new Set(['title', 'ctrTitle'])

/** Title-cases every title placeholder's paragraphs; answers how many paragraphs changed. */
async function titleCaseDeck(document) {
  return document.run(async (context) => {
    const slides = context.root.slides
    slides.load()
    await context.sync()
    const shapes = []
    for (const slide of slides.items) {
      slide.shapes.load()
      await context.sync()
      for (const shape of slide.shapes.items) {
        shape.load(['props', 'body'])
        shapes.push(shape)
      }
    }
    await context.sync()
    const paragraphs = []
    for (const shape of shapes) {
      if (!TITLES.has(shape.props?.ph?.kind) || !shape.body) continue
      const body = context.object(shape.body, 'TextBody')
      body.paragraphs.load()
      await context.sync()
      for (const paragraph of body.paragraphs.items) {
        paragraph.load(['text'])
        paragraphs.push(paragraph)
      }
    }
    await context.sync()
    let changed = 0
    for (const paragraph of paragraphs) {
      const text = paragraph.text.toString()
      const next = titleCase(text)
      if (next === text) continue
      changed += 1
      // Positions count Unicode scalar values.
      const [before, after] = [[...text], [...next]]
      if (before.length !== after.length) {
        paragraph.text.set(next)
        continue
      }
      // Letter by letter, so each run keeps its marks (bold, size, colour): only the case changes.
      // The new letter goes in after the old one (inside its run), then the old one goes.
      for (let index = 0; index < before.length; index += 1) {
        if (before[index] === after[index]) continue
        paragraph.text.insert(index + 1, after[index])
        paragraph.text.delete(index, 1)
      }
    }
    await context.sync()
    return changed
  })
}

export function activate(ctx) {
  ctx.commands.register('titleCase.apply', async () => {
    const changed = await titleCaseDeck(ctx.document)
    ctx.notify(changed ? `Title-cased ${changed} title${changed === 1 ? '' : 's'}` : 'Every title is already in title case', { level: 'success' })
    return { changed }
  })
}
