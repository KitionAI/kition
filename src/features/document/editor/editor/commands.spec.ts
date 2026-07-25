import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import {
  applySmartArrows,
  applySmartTypography,
  collapseInnerSpaces,
  compressBlankLines,
  convertLinkUnderCursor,
  convertSelectionToCallout,
  convertSpacesToTabs,
  convertTabsToSpaces,
  cycleListType,
  decodeHtmlEntities,
  dedupSelectedLines,
  deleteCurrentLine,
  duplicateLine,
  ensureBlockIdAtCursor,
  ensureFrontmatter,
  ensureReferencesSection,
  generateTOC,
  getBlockIdAtCursor,
  getDocumentStats,
  getHeadingAtCursor,
  insertCallout,
  insertDataviewField,
  insertFootnote,
  insertAsQuote,
  insertTodayLink,
  insertTomorrowLink,
  insertYesterdayLink,
  joinLines,
  jumpFootnote,
  jumpToNextHeading,
  jumpToPrevHeading,
  moveSectionDown,
  moveSectionUp,
  normalizeBulletMarkers,
  removeEmptyLines,
  renumberFootnotes,
  renumberOrderedLists,
  reverseLines,
  selectCurrentParagraph,
  selectCurrentSection,
  sortTasks,
  splitSentencesToLines,
  swapLineDown,
  swapLineUp,
  toggleAllTasksInSelection,
  tableAddColumnLeft,
  tableAddColumnRight,
  tableAddRowAbove,
  tableAddRowBelow,
  tableAlignColumn,
  tableDeleteColumn,
  tableDeleteRow,
  tableFormat,
  tableMoveColumnLeft,
  tableMoveColumnRight,
  tableMoveRowDown,
  tableMoveRowUp,
  tableSortByColumn,
  insertCodeBlock,
  insertImage,
  insertLink,
  insertTable,
  insertTOC,
  promoteHeading,
  demoteHeading,
  setLineHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleTaskCheckbox,
  toggleTodoList,
  transformCase,
  trimTrailingWhitespace,
  unwrapLink,
  wrapAsCodeBlock,
  wrapAsSpoiler,
  wrapAsTag,
  wrapAsWikilink,
  splitMarkdownSlides,
  jumpToSlide,
  jumpToNextSlide,
  jumpToPrevSlide,
  insertSlideBreak,
  getCodeBlockAtCursor,
  copyCodeBlockAtCursor,
  changeCodeBlockLang,
  shiftAllHeadings,
  parseCsv,
  csvToMarkdownTable,
  markdownTableToCsv,
  stripMarkdownToPlain,
  replaceWithPlain,
  convertCsvSelectionToTable,
  convertTableSelectionToCsv,
  markAllTasks,
  archiveDoneTasks,
  renameDocumentTag,
  markdownOutlineToOpml,
  opmlToMarkdownOutline,
  convertOutlineSelectionToOpml,
  convertOpmlSelectionToOutline,
  promoteListItem,
  demoteListItem,
  convertBulletListToOrdered,
  convertOrderedListToBullet,
  insertUuid,
  sortFrontmatterKeys,
  reverseCase,
  tableDedupRowsByFirstColumn,
  tableRotateColumnsLeft,
  tableRotateColumnsRight,
  tableTranspose,
  escapeMarkdownText,
  unescapeMarkdownText,
  escapeMarkdownSelection,
  unescapeMarkdownSelection,
  wrapAsDetails,
  convertHeadingsToList,
  convertBulletsToHeadings,
  capitalizeSentencesText,
  capitalizeEachWordText,
  capitalizeSentences,
  capitalizeEachWord,
  straightToCurlyQuotesText,
  curlyToStraightQuotesText,
  straightToCurlyQuotes,
  curlyToStraightQuotes,
  sortListBlock,
  uniqueListBlock,
  shuffleListBlock,
  moveSectionToTop,
  moveSectionToBottom,
  buildSectionLinkText,
  toggleInlineMath,
  insertHorizontalRuleAtCursor,
  bulletsToCsvText,
  csvToBulletsText,
  bulletsToCsvLine,
  csvToBulletsLine,
  hardWrapText,
  unwrapParagraphsText,
  toMarkdownHardBreaksText,
  fromMarkdownHardBreaksText,
  hardWrapSelection,
  unwrapParagraphs,
  toMarkdownHardBreaks,
  fromMarkdownHardBreaks,
  increaseQuoteLevel,
  decreaseQuoteLevel,
  sortSelectedLinesDesc,
  sortSelectedLinesByLengthAsc,
  sortSelectedLinesByLengthDesc,
  sortSelectedLinesNumericAsc,
  sortSelectedLinesNumericDesc,
  sortSelectedLinesNatural,
  exportOutlineToText,
  trimSectionBlanks,
  insertAuthorAndDateFrontmatter,
  expandSelectionToParagraph,
  selectToNextHeading,
  duplicateCurrentSection,
  getSelectionStats,
  mergeAdjacentBlockquotesText,
  mergeAdjacentBlockquotes,
  lowercaseHeadingsText,
  uppercaseHeadingsText,
  lowercaseAllHeadings,
  uppercaseAllHeadings,
  expandTemplateVariables,
  insertTemplateText,
  getNoteProperties,
  setNotePropertyText,
  setNoteProperty,
  insertImageEmbedWithSize,
  convertImagesToWikilinksText,
  convertImageWikilinksToMarkdownText,
  convertImagesToWikilinks,
  convertImageWikilinksToMarkdown,
  safeEvalArithmetic,
  evalInlineMathInLinesText,
  cycleTaskStateChar,
  archiveDoneTasksText,
  stripHighlightsText,
  stripBoldText,
  stripItalicText,
  ensureUpdatedFrontmatterText,
  hardBreaksToSpaceText,
  bulletPairsToDefinitionListText,
  sortFrontmatterAliasesText,
  blockquoteLinesText,
  unblockquoteLinesText,
  injectTopTOCText,
  renameInlineDataviewFieldText,
  numberCodeBlockLinesText,
  stripHtmlCommentsText,
  purgeDoneTasksUnderTasksHeadingText,
  swapLinkTextWithUrlText,
  frontmatterFieldInlineToBlockText,
  frontmatterFieldBlockToInlineText,
  stampLinesWithDateText,
  unwrapDetailsBlocksText,
  collapseExcessiveBlankLinesText,
  singleSpaceAfterListMarkerText,
  ensureBlankAroundHeadingsText,
  ensureSingleTrailingNewlineText,
  sortFrontmatterTopKeysText,
  normalizeEmphasisToAsteriskText,
  normalizeEmphasisToUnderscoreText,
  normalizeStrongToAsteriskText,
  trimTrailingNonBreakWhitespaceText,
  flattenNestedListsText,
  indentLinesBySpacesText,
  dedentLinesBySpacesText,
  plainUrlToAutolinkText,
  applyFrontmatterTemplateText,
  shiftHeadingsUpOneLevelText,
  shiftHeadingsDownOneLevelText,
  brTagsToHardBreaksText,
  convertLinksToFootnotesText,
  headingsToOutlineText,
  surroundEachLineWithTagText,
  htmlSupToCaretText,
  htmlSubToTildeText,
  calloutsToHeadingsText,
  countHashtagsText,
  collectAllLinkTargets,
  findDuplicateHeadings,
  lowercaseAllTagsText,
  uppercaseAllTagsText,
  paragraphsToHtmlBreaksText,
  convertMarkdownImagesToWikiEmbedsText,
  convertDocumentEmbedToMdImageText,
  setImageWidthForEmbedsText,
  injectHtmlAnchorsBeforeHeadingsText,
  abbreviateLinksToHostText,
  relativeMdLinksToWikilinksText,
  defaultCalloutTitlesText,
} from './commands'

function makeView(doc: string, selection: { anchor: number; head?: number }): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(selection.anchor, selection.head ?? selection.anchor),
  })
  const view = new EditorView({ state, parent: document.createElement('div') })
  view.focus = () => {}
  return view
}

function read(view: EditorView): string {
  return view.state.doc.toString()
}

function cursor(view: EditorView): [number, number] {
  const r = view.state.selection.main
  return [r.from, r.to]
}

describe('toggleBold', () => {
  it('wraps a selection with **', () => {
    const view = makeView('hello world', { anchor: 0, head: 5 })
    toggleBold(view)
    expect(read(view)).toBe('**hello** world')
    expect(cursor(view)).toEqual([2, 7])
  })

  it('unwraps a previously bolded selection', () => {
    const view = makeView('**hello** world', { anchor: 2, head: 7 })
    toggleBold(view)
    expect(read(view)).toBe('hello world')
    expect(cursor(view)).toEqual([0, 5])
  })

  it('inserts marker pair at cursor when no selection', () => {
    const view = makeView('hi', { anchor: 2 })
    toggleBold(view)
    expect(read(view)).toBe('hi****')
    expect(cursor(view)).toEqual([4, 4])
  })
})

describe('toggleItalic / toggleStrike / toggleInlineCode', () => {
  it('italic wraps with single *', () => {
    const view = makeView('abc', { anchor: 0, head: 3 })
    toggleItalic(view)
    expect(read(view)).toBe('*abc*')
  })

  it('strike wraps with ~~', () => {
    const view = makeView('abc', { anchor: 0, head: 3 })
    toggleStrike(view)
    expect(read(view)).toBe('~~abc~~')
  })

  it('inline code wraps with backtick', () => {
    const view = makeView('abc', { anchor: 0, head: 3 })
    toggleInlineCode(view)
    expect(read(view)).toBe('`abc`')
  })
})

describe('setLineHeading', () => {
  it('adds # prefix to current line', () => {
    const view = makeView('hello', { anchor: 0 })
    setLineHeading(1)(view)
    expect(read(view)).toBe('# hello')
  })

  it('replaces existing heading level', () => {
    const view = makeView('## hello', { anchor: 0 })
    setLineHeading(3)(view)
    expect(read(view)).toBe('### hello')
  })

  it('strips heading when level=0', () => {
    const view = makeView('### hello', { anchor: 0 })
    setLineHeading(0)(view)
    expect(read(view)).toBe('hello')
  })

  it('applies to all lines in selection', () => {
    const view = makeView('one\ntwo\nthree', { anchor: 0, head: 13 })
    setLineHeading(2)(view)
    expect(read(view)).toBe('## one\n## two\n## three')
  })
})

describe('toggleBulletList / toggleQuote / toggleTodoList', () => {
  it('bullet adds "- " prefix', () => {
    const view = makeView('a\nb', { anchor: 0, head: 3 })
    toggleBulletList(view)
    expect(read(view)).toBe('- a\n- b')
  })

  it('bullet removes prefix when all lines already prefixed', () => {
    const view = makeView('- a\n- b', { anchor: 0, head: 7 })
    toggleBulletList(view)
    expect(read(view)).toBe('a\nb')
  })

  it('quote adds "> "', () => {
    const view = makeView('a', { anchor: 0 })
    toggleQuote(view)
    expect(read(view)).toBe('> a')
  })

  it('todo adds "- [ ] "', () => {
    const view = makeView('do it', { anchor: 0 })
    toggleTodoList(view)
    expect(read(view)).toBe('- [ ] do it')
  })
})

describe('toggleOrderedList', () => {
  it('numbers lines starting from 1', () => {
    const view = makeView('a\nb\nc', { anchor: 0, head: 5 })
    toggleOrderedList(view)
    expect(read(view)).toBe('1. a\n2. b\n3. c')
  })

  it('removes numbering when all lines already numbered', () => {
    const view = makeView('1. a\n2. b', { anchor: 0, head: 9 })
    toggleOrderedList(view)
    expect(read(view)).toBe('a\nb')
  })
})

describe('insertCodeBlock / insertTable / insertCallout / insertTOC', () => {
  it('insertCodeBlock inserts triple-backtick block with cursor inside', () => {
    const view = makeView('', { anchor: 0 })
    insertCodeBlock('ts')(view)
    expect(read(view)).toBe('```ts\n\n```')
  })

  it('insertTable lays out header + separator + rows', () => {
    const view = makeView('', { anchor: 0 })
    insertTable(2, 2)(view)
    const out = read(view)
    expect(out).toContain('| Col 1 | Col 2 |')
    expect(out).toContain('| --- | --- |')
  })

  it('insertCallout writes a note block', () => {
    const view = makeView('', { anchor: 0 })
    insertCallout('warning')(view)
    expect(read(view)).toBe('> [!warning]\n> ')
  })

  it('insertTOC writes [TOC] placeholder', () => {
    const view = makeView('', { anchor: 0 })
    insertTOC()(view)
    expect(read(view)).toBe('[TOC]')
  })
})

describe('insertLink / insertImage', () => {
  it('insertLink with empty url uses placeholder text', () => {
    const view = makeView('', { anchor: 0 })
    insertLink()(view)
    expect(read(view)).toBe('[link text]()')
  })

  it('insertLink wraps a selection as link text', () => {
    const view = makeView('click me', { anchor: 0, head: 8 })
    insertLink('https://x.com')(view)
    expect(read(view)).toBe('[click me](https://x.com)')
  })

  it('insertImage inserts ![alt](url)', () => {
    const view = makeView('', { anchor: 0 })
    insertImage('https://x.com/a.png', 'alt')(view)
    expect(read(view)).toBe('![alt](https://x.com/a.png)')
  })
})

describe('shiftHeadingLevel', () => {
  it('promoteHeading turns H2 into H1', () => {
    const view = makeView('## Hello', { anchor: 0 })
    promoteHeading(view)
    expect(read(view)).toBe('# Hello')
  })

  it('demoteHeading on plain text creates H1', () => {
    const view = makeView('Hello', { anchor: 0 })
    demoteHeading(view)
    expect(read(view)).toBe('# Hello')
  })

  it('promoteHeading on plain text stays at 0', () => {
    const view = makeView('Hello', { anchor: 0 })
    promoteHeading(view)
    expect(read(view)).toBe('Hello')
  })

  it('demoteHeading clamps at H6', () => {
    const view = makeView('###### Hello', { anchor: 0 })
    demoteHeading(view)
    expect(read(view)).toBe('###### Hello')
  })
})

describe('toggleTaskCheckbox', () => {
  it('adds checkbox to plain line', () => {
    const view = makeView('foo', { anchor: 0 })
    toggleTaskCheckbox(view)
    expect(read(view)).toBe('- [ ] foo')
  })

  it('adds checkbox to existing bullet', () => {
    const view = makeView('- foo', { anchor: 0 })
    toggleTaskCheckbox(view)
    expect(read(view)).toBe('- [ ] foo')
  })

  it('checks unchecked task', () => {
    const view = makeView('- [ ] foo', { anchor: 0 })
    toggleTaskCheckbox(view)
    expect(read(view)).toBe('- [x] foo')
  })

  it('unchecks checked task', () => {
    const view = makeView('- [x] foo', { anchor: 0 })
    toggleTaskCheckbox(view)
    expect(read(view)).toBe('- [ ] foo')
  })

  it('handles mixed selection — checks all when not all checked', () => {
    const view = makeView('- [ ] a\n- [x] b', { anchor: 0, head: 15 })
    toggleTaskCheckbox(view)
    expect(read(view)).toBe('- [x] a\n- [x] b')
  })
})

describe('cycleListType', () => {
  it('plain → bullet', () => {
    const view = makeView('foo', { anchor: 0 })
    cycleListType(view)
    expect(read(view)).toBe('- foo')
  })

  it('bullet → ordered', () => {
    const view = makeView('- foo', { anchor: 0 })
    cycleListType(view)
    expect(read(view)).toBe('1. foo')
  })

  it('ordered → todo', () => {
    const view = makeView('1. foo', { anchor: 0 })
    cycleListType(view)
    expect(read(view)).toBe('- [ ] foo')
  })

  it('todo → plain', () => {
    const view = makeView('- [ ] foo', { anchor: 0 })
    cycleListType(view)
    expect(read(view)).toBe('foo')
  })

  it('multi-line auto-numbers when cycling to ordered', () => {
    const view = makeView('- a\n- b\n- c', { anchor: 0, head: 11 })
    cycleListType(view)
    expect(read(view)).toBe('1. a\n2. b\n3. c')
  })

  it('preserves indentation', () => {
    const view = makeView('  - foo', { anchor: 0 })
    cycleListType(view)
    expect(read(view)).toBe('  1. foo')
  })
})

describe('convertLinkUnderCursor', () => {
  it('wikilink → markdown link', () => {
    const view = makeView('see [[Foo]] now', { anchor: 5 })
    convertLinkUnderCursor(view)
    expect(read(view)).toBe('see [Foo](Foo.md) now')
  })

  it('aliased wikilink → markdown link with display text', () => {
    const view = makeView('see [[Foo|bar]] now', { anchor: 5 })
    convertLinkUnderCursor(view)
    expect(read(view)).toBe('see [bar](Foo.md) now')
  })

  it('markdown link → wikilink (basename)', () => {
    const view = makeView('see [Foo](Foo.md) now', { anchor: 5 })
    convertLinkUnderCursor(view)
    expect(read(view)).toBe('see [[Foo]] now')
  })

  it('markdown link with custom text → aliased wikilink', () => {
    const view = makeView('see [bar](Foo.md) now', { anchor: 5 })
    convertLinkUnderCursor(view)
    expect(read(view)).toBe('see [[Foo|bar]] now')
  })

  it('skips external http link', () => {
    const view = makeView('see [Google](https://google.com) now', { anchor: 5 })
    const ok = convertLinkUnderCursor(view)
    expect(ok).toBe(false)
    expect(read(view)).toBe('see [Google](https://google.com) now')
  })

  it('skips embed wikilink', () => {
    const view = makeView('see ![[Foo]] now', { anchor: 5 })
    const ok = convertLinkUnderCursor(view)
    expect(ok).toBe(false)
  })
})

describe('block id / heading helpers', () => {
  it('ensureBlockIdAtCursor returns existing id when present', () => {
    const view = makeView('hello world ^abc123', { anchor: 0 })
    const id = ensureBlockIdAtCursor(view)
    expect(id).toBe('abc123')
    expect(read(view)).toBe('hello world ^abc123')
  })

  it('ensureBlockIdAtCursor appends new id when missing', () => {
    const view = makeView('hello world', { anchor: 0 })
    const id = ensureBlockIdAtCursor(view)
    expect(id).toMatch(/^[a-z0-9]{6}$/)
    expect(read(view)).toBe(`hello world ^${id}`)
  })

  it('getBlockIdAtCursor returns id from tail or null', () => {
    const v1 = makeView('hello ^foo-1', { anchor: 0 })
    expect(getBlockIdAtCursor(v1)).toBe('foo-1')
    const v2 = makeView('hello world', { anchor: 0 })
    expect(getBlockIdAtCursor(v2)).toBeNull()
  })

  it('getHeadingAtCursor returns heading text without # marks', () => {
    const v1 = makeView('## Intro to thing', { anchor: 0 })
    expect(getHeadingAtCursor(v1)).toBe('Intro to thing')
    const v2 = makeView('not a heading', { anchor: 0 })
    expect(getHeadingAtCursor(v2)).toBeNull()
  })
})

describe('moveSection', () => {
  it('moveSectionDown swaps two sibling H2 sections', () => {
    const doc = '## A\nbody a\n## B\nbody b\n'
    const view = makeView(doc, { anchor: 0 })
    moveSectionDown(view)
    expect(read(view)).toBe('## B\nbody b\n## A\nbody a\n')
  })

  it('moveSectionUp swaps with previous sibling', () => {
    const doc = '## A\nbody a\n## B\nbody b'
    // place cursor in section B
    const view = makeView(doc, { anchor: doc.indexOf('## B') })
    moveSectionUp(view)
    expect(read(view)).toBe('## B\nbody b\n## A\nbody a')
  })

  it('moveSectionDown returns false when no next sibling', () => {
    const view = makeView('## A\nx\n## B\ny', { anchor: 5 })
    // cursor in section A's body
    // first call moves A down → 'B y A x'
    moveSectionDown(view)
    expect(read(view).split('\n')[0]).toBe('## B')
    // now there is no next sibling for A → false
    const ok = moveSectionDown(view)
    expect(ok).toBe(false)
  })

  it('moves entire section including children', () => {
    const doc = '# A\n## A1\nx\n## A2\ny\n# B\nz'
    const view = makeView(doc, { anchor: 0 })
    moveSectionDown(view)
    // entire A section (with A1, A2) moves below B
    expect(read(view)).toBe('# B\nz\n# A\n## A1\nx\n## A2\ny')
  })
})

describe('table edit commands', () => {
  const baseTable = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  it('tableAddColumnRight inserts after cursor column', () => {
    // cursor at column "a" (col 0)
    const view = makeView(baseTable, { anchor: 2 })
    const ok = tableAddColumnRight(view)
    expect(ok).toBe(true)
    expect(read(view)).toBe(
      '| a |   | b |\n| --- | --- | --- |\n| 1 |   | 2 |\n| 3 |   | 4 |',
    )
  })

  it('tableAddColumnLeft inserts before cursor column', () => {
    const view = makeView(baseTable, { anchor: 6 }) // col 1 (b)
    tableAddColumnLeft(view)
    expect(read(view)).toBe(
      '| a |   | b |\n| --- | --- | --- |\n| 1 |   | 2 |\n| 3 |   | 4 |',
    )
  })

  it('tableDeleteColumn removes a column', () => {
    const view = makeView(baseTable, { anchor: 2 }) // col 0 (a)
    tableDeleteColumn(view)
    expect(read(view)).toBe('| b |\n| --- |\n| 2 |\n| 4 |')
  })

  it('tableDeleteColumn refuses when only one column left', () => {
    const onecol = '| a |\n| --- |\n| 1 |'
    const view = makeView(onecol, { anchor: 0 })
    const ok = tableDeleteColumn(view)
    expect(ok).toBe(false)
  })

  it('tableAddRowBelow inserts after current row', () => {
    // cursor at the "1" body row
    const view = makeView(baseTable, { anchor: baseTable.indexOf('1') })
    tableAddRowBelow(view)
    expect(read(view)).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n|   |   |\n| 3 | 4 |',
    )
  })

  it('tableAddRowAbove refuses when on header', () => {
    const view = makeView(baseTable, { anchor: 0 })
    const ok = tableAddRowAbove(view)
    expect(ok).toBe(false)
  })

  it('tableDeleteRow removes a body row', () => {
    const view = makeView(baseTable, { anchor: baseTable.indexOf('1') })
    tableDeleteRow(view)
    expect(read(view)).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |')
  })

  it('tableDeleteRow refuses when only one body row', () => {
    const minimal = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const view = makeView(minimal, { anchor: minimal.indexOf('1') })
    const ok = tableDeleteRow(view)
    expect(ok).toBe(false)
  })

  it('tableAlignColumn(center) sets separator alignment', () => {
    const view = makeView(baseTable, { anchor: 2 }) // col 0
    tableAlignColumn('center')(view)
    expect(read(view)).toBe(
      '| a | b |\n| :---: | --- |\n| 1 | 2 |\n| 3 | 4 |',
    )
  })

  it('returns false when cursor is not in a table', () => {
    const view = makeView('plain text', { anchor: 0 })
    expect(tableAddColumnRight(view)).toBe(false)
  })
})

describe('tableFormat', () => {
  it('pads columns to widest cell and rebuilds separator', () => {
    const doc = '|name|age|\n|---|---|\n|Alice|30|\n|Bob|5|'
    const view = makeView(doc, { anchor: 2 })
    const ok = tableFormat(view)
    expect(ok).toBe(true)
    expect(read(view)).toBe(
      '| name  | age |\n| ----- | --- |\n| Alice | 30  |\n| Bob   | 5   |',
    )
  })

  it('preserves alignment markers from separator', () => {
    const doc = '| a | b |\n| :--- | ---: |\n| hi | x |'
    const view = makeView(doc, { anchor: 0 })
    tableFormat(view)
    expect(read(view)).toBe(
      '| a    |    b |\n| :--- | ---: |\n| hi   |    x |',
    )
  })

  it('returns false when cursor is not in a table', () => {
    const view = makeView('not a table', { anchor: 0 })
    expect(tableFormat(view)).toBe(false)
  })
})

describe('tableSortByColumn', () => {
  it('sorts body rows ascending by string', () => {
    const doc = '| name | age |\n| --- | --- |\n| Charlie | 30 |\n| Alice | 5 |\n| Bob | 25 |'
    // Cursor in first column
    const view = makeView(doc, { anchor: 3 })
    const ok = tableSortByColumn('asc')(view)
    expect(ok).toBe(true)
    expect(read(view)).toContain('| Alice | 5 |\n| Bob | 25 |\n| Charlie | 30 |')
  })

  it('sorts body rows by number when all numeric', () => {
    const doc = '| name | age |\n| --- | --- |\n| C | 30 |\n| A | 5 |\n| B | 25 |'
    // Cursor in second column (age)
    const view = makeView(doc, { anchor: 9 })
    tableSortByColumn('asc')(view)
    expect(read(view)).toContain('| A | 5 |\n| B | 25 |\n| C | 30 |')
  })

  it('descending reverses sort', () => {
    const doc = '| name | age |\n| --- | --- |\n| C | 30 |\n| A | 5 |\n| B | 25 |'
    const view = makeView(doc, { anchor: 9 })
    tableSortByColumn('desc')(view)
    expect(read(view)).toContain('| C | 30 |\n| B | 25 |\n| A | 5 |')
  })

  it('returns false on a 1-row table', () => {
    const doc = '| h |\n| --- |\n'
    const view = makeView(doc, { anchor: 0 })
    expect(tableSortByColumn('asc')(view)).toBe(false)
  })
})

describe('insertFootnote', () => {
  it('inserts [^1] at cursor and appends definition at doc end on first call', () => {
    const view = makeView('hello', { anchor: 5 })
    insertFootnote(view)
    expect(read(view)).toBe('hello[^1]\n\n[^1]: ')
  })

  it('increments id when prior footnote exists', () => {
    const view = makeView('a [^1] b\n\n[^1]: first\n', { anchor: 8 })
    insertFootnote(view)
    expect(read(view)).toBe('a [^1] b[^2]\n\n[^1]: first\n[^2]: ')
  })

  it('puts cursor at the end (ready to type definition body)', () => {
    const view = makeView('hi', { anchor: 2 })
    insertFootnote(view)
    const [from, to] = cursor(view)
    expect(from).toBe(read(view).length)
    expect(to).toBe(read(view).length)
  })
})

describe('jumpFootnote', () => {
  it('jumps from ref to def', () => {
    const doc = 'see [^1] now\n\n[^1]: detail'
    const view = makeView(doc, { anchor: doc.indexOf('[^1]') + 1 })
    const ok = jumpFootnote(view)
    expect(ok).toBe(true)
    const [from] = cursor(view)
    expect(from).toBe(doc.indexOf('[^1]:'))
  })

  it('jumps from def to first ref', () => {
    const doc = 'see [^2] and again [^2]\n\n[^2]: detail'
    const defStart = doc.indexOf('[^2]:')
    const view = makeView(doc, { anchor: defStart })
    const ok = jumpFootnote(view)
    expect(ok).toBe(true)
    const [from] = cursor(view)
    expect(from).toBe(doc.indexOf('[^2]'))
  })

  it('returns false when cursor not on footnote', () => {
    const view = makeView('plain text', { anchor: 2 })
    expect(jumpFootnote(view)).toBe(false)
  })
})

describe('renumberFootnotes', () => {
  it('compacts [^3] [^5] → [^1] [^2]', () => {
    const doc = 'see [^3] and [^5]\n\n[^3]: a\n[^5]: b'
    const view = makeView(doc, { anchor: 0 })
    const ok = renumberFootnotes(view)
    expect(ok).toBe(true)
    expect(read(view)).toBe('see [^1] and [^2]\n\n[^1]: a\n[^2]: b')
  })

  it('preserves order of first occurrence', () => {
    const doc = 'see [^5] then [^2]\n\n[^5]: x\n[^2]: y'
    const view = makeView(doc, { anchor: 0 })
    renumberFootnotes(view)
    // [^5] (1st) → [^1], [^2] (2nd) → [^2]
    expect(read(view)).toBe('see [^1] then [^2]\n\n[^1]: x\n[^2]: y')
  })

  it('returns false when already compact', () => {
    const doc = 'a [^1] b [^2]\n\n[^1]: x\n[^2]: y'
    const view = makeView(doc, { anchor: 0 })
    expect(renumberFootnotes(view)).toBe(false)
  })

  it('returns false when no footnotes', () => {
    const view = makeView('plain text', { anchor: 0 })
    expect(renumberFootnotes(view)).toBe(false)
  })
})

describe('wrapAsWikilink', () => {
  it('wraps selection as [[…]]', () => {
    const view = makeView('see Alpha now', { anchor: 4, head: 9 })
    const ok = wrapAsWikilink(view)
    expect(ok).toBe(true)
    expect(read(view)).toBe('see [[Alpha]] now')
  })

  it('inserts placeholder when no selection', () => {
    const view = makeView('hi ', { anchor: 3 })
    wrapAsWikilink(view)
    expect(read(view)).toBe('hi [[]]')
  })

  it('refuses multi-line selection', () => {
    const view = makeView('a\nb', { anchor: 0, head: 3 })
    expect(wrapAsWikilink(view)).toBe(false)
  })
})

describe('wrapAsTag', () => {
  it('wraps selection as #tag, normalizing punctuation', () => {
    const view = makeView('about Web Design Notes', { anchor: 6, head: 22 })
    wrapAsTag(view)
    expect(read(view)).toBe('about #Web-Design-Notes')
  })

  it('with no selection, picks the word under cursor', () => {
    const view = makeView('hello world', { anchor: 7 })
    wrapAsTag(view)
    expect(read(view)).toBe('hello #world')
  })

  it('refuses if already tagged', () => {
    const view = makeView('#foo', { anchor: 0, head: 4 })
    expect(wrapAsTag(view)).toBe(false)
  })
})

describe('convertSelectionToCallout', () => {
  it('wraps current line as note callout', () => {
    const view = makeView('hello world', { anchor: 0 })
    convertSelectionToCallout('note')(view)
    expect(read(view)).toBe('> [!note]\n> hello world')
  })

  it('wraps multiple lines preserving each line', () => {
    const doc = 'one\ntwo\nthree'
    const view = makeView(doc, { anchor: 0, head: doc.length })
    convertSelectionToCallout('warning')(view)
    expect(read(view)).toBe('> [!warning]\n> one\n> two\n> three')
  })
})

describe('unwrapLink', () => {
  it('strips markdown link to its text', () => {
    const view = makeView('see [Foo](Foo.md) now', { anchor: 0 })
    const ok = unwrapLink(view)
    expect(ok).toBe(true)
    expect(read(view)).toBe('see Foo now')
  })

  it('strips wikilink to target', () => {
    const view = makeView('see [[Foo]] now', { anchor: 0 })
    unwrapLink(view)
    expect(read(view)).toBe('see Foo now')
  })

  it('strips aliased wikilink to alias', () => {
    const view = makeView('see [[Foo|bar]] now', { anchor: 0 })
    unwrapLink(view)
    expect(read(view)).toBe('see bar now')
  })

  it('strips embed wikilink to target', () => {
    const view = makeView('![[Foo]]', { anchor: 0 })
    unwrapLink(view)
    expect(read(view)).toBe('Foo')
  })

  it('returns false on plain text', () => {
    const view = makeView('plain text', { anchor: 0 })
    expect(unwrapLink(view)).toBe(false)
  })
})

describe('selectCurrentSection', () => {
  it('selects from heading through end of section', () => {
    const doc = '## A\nbody a\n## B\nbody b'
    const view = makeView(doc, { anchor: 0 })
    const ok = selectCurrentSection(view)
    expect(ok).toBe(true)
    const sel = view.state.selection.main
    expect(doc.slice(sel.from, sel.to)).toBe('## A\nbody a')
  })

  it('selects deeper section including children', () => {
    const doc = '# Top\n## A\nbody\n## B\nx'
    const view = makeView(doc, { anchor: 0 })
    selectCurrentSection(view)
    const sel = view.state.selection.main
    expect(doc.slice(sel.from, sel.to)).toBe(doc)
  })

  it('returns false when no heading found', () => {
    const view = makeView('plain', { anchor: 0 })
    expect(selectCurrentSection(view)).toBe(false)
  })
})

describe('trimTrailingWhitespace', () => {
  it('strips trailing spaces on each line', () => {
    const view = makeView('hello   \nworld\t\nok', { anchor: 0 })
    const ok = trimTrailingWhitespace(view)
    expect(ok).toBe(true)
    expect(read(view)).toBe('hello\nworld\nok')
  })

  it('removes trailing blank lines', () => {
    const view = makeView('a\n\n\n', { anchor: 0 })
    trimTrailingWhitespace(view)
    expect(read(view)).toBe('a\n')
  })

  it('returns false when already clean', () => {
    const view = makeView('clean', { anchor: 0 })
    expect(trimTrailingWhitespace(view)).toBe(false)
  })
})

describe('insertAsQuote', () => {
  it('wraps each selected line with > ', () => {
    const view = makeView('one\ntwo', { anchor: 0, head: 7 })
    insertAsQuote(view)
    expect(read(view)).toBe('> one\n> two')
  })

  it('returns false on empty selection', () => {
    const view = makeView('hi', { anchor: 0 })
    expect(insertAsQuote(view)).toBe(false)
  })
})

describe('wrapAsCodeBlock', () => {
  it('wraps selection without a language', () => {
    const view = makeView('let x = 1', { anchor: 0, head: 9 })
    wrapAsCodeBlock()(view)
    expect(read(view)).toBe('```\nlet x = 1\n```')
  })

  it('wraps selection with a language', () => {
    const view = makeView('const x = 1', { anchor: 0, head: 11 })
    wrapAsCodeBlock('ts')(view)
    expect(read(view)).toBe('```ts\nconst x = 1\n```')
  })

  it('returns false on empty selection', () => {
    const view = makeView('hi', { anchor: 0 })
    expect(wrapAsCodeBlock()(view)).toBe(false)
  })
})

describe('duplicateLine', () => {
  it('duplicates current line below', () => {
    const view = makeView('hello\nworld', { anchor: 1 })
    duplicateLine(view)
    expect(read(view)).toBe('hello\nhello\nworld')
  })

  it('duplicates a multi-line selection block', () => {
    const view = makeView('a\nb\nc', { anchor: 0, head: 3 })
    duplicateLine(view)
    expect(read(view)).toBe('a\nb\na\nb\nc')
  })
})

describe('joinLines', () => {
  it('joins selected lines with single space', () => {
    const view = makeView('hello\nworld', { anchor: 0, head: 11 })
    joinLines(view)
    expect(read(view)).toBe('hello world')
  })

  it('drops leading whitespace on subsequent lines', () => {
    const view = makeView('foo\n   bar\n   baz', { anchor: 0, head: 17 })
    joinLines(view)
    expect(read(view)).toBe('foo bar baz')
  })

  it('returns false when selection covers single line', () => {
    const view = makeView('only', { anchor: 0, head: 4 })
    expect(joinLines(view)).toBe(false)
  })
})

describe('splitSentencesToLines', () => {
  it('splits on . ! ?', () => {
    const view = makeView('Hi. How are you? I am fine!', { anchor: 0, head: 27 })
    splitSentencesToLines(view)
    expect(read(view)).toBe('Hi.\nHow are you?\nI am fine!')
  })

  it('splits on Chinese full stops', () => {
    const source = String.fromCodePoint(0x4f60, 0x597d, 0x3002, 0x20, 0x4eca, 0x5929, 0x597d, 0x5417, 0xff1f, 0x20, 0x6211, 0x5f88, 0x597d, 0xff01)
    const view = makeView(source, { anchor: 0, head: source.length })
    splitSentencesToLines(view)
    expect(read(view)).toBe(String.fromCodePoint(0x4f60, 0x597d, 0x3002, 0x0a, 0x4eca, 0x5929, 0x597d, 0x5417, 0xff1f, 0x0a, 0x6211, 0x5f88, 0x597d, 0xff01))
  })
})

describe('applySmartTypography', () => {
  it('replaces ASCII shortcuts with typographic chars', () => {
    const view = makeView('Hello -- world ... (c) (R) (tm) +-', { anchor: 0 })
    applySmartTypography(view)
    expect(read(view)).toBe('Hello — world … © ® ™ ±')
  })

  it('replaces inside selection only', () => {
    const view = makeView('keep -- and -- here', { anchor: 5, head: 11 })
    applySmartTypography(view)
    expect(read(view)).toBe('keep — and -- here')
  })

  it('returns false when nothing to replace', () => {
    const view = makeView('plain text', { anchor: 0 })
    expect(applySmartTypography(view)).toBe(false)
  })
})

describe('deleteCurrentLine', () => {
  it('removes the line at cursor', () => {
    const view = makeView('one\ntwo\nthree', { anchor: 5 })
    deleteCurrentLine(view)
    expect(read(view)).toBe('one\nthree')
  })

  it('removes all lines covered by selection', () => {
    const view = makeView('a\nb\nc\nd', { anchor: 2, head: 5 })
    deleteCurrentLine(view)
    expect(read(view)).toBe('a\nd')
  })
})

describe('compressBlankLines', () => {
  it('collapses 3+ blank lines into a single blank', () => {
    const view = makeView('a\n\n\n\nb', { anchor: 0 })
    compressBlankLines(view)
    expect(read(view)).toBe('a\n\nb')
  })

  it('returns false when no compression needed', () => {
    const view = makeView('a\n\nb', { anchor: 0 })
    expect(compressBlankLines(view)).toBe(false)
  })
})

describe('sortTasks', () => {
  it('moves checked tasks below unchecked', () => {
    const src = '- [x] done a\n- [ ] open b\n- [x] done c\n- [ ] open d'
    const view = makeView(src, { anchor: 0, head: src.length })
    sortTasks(view)
    expect(read(view)).toBe('- [ ] open b\n- [ ] open d\n- [x] done a\n- [x] done c')
  })

  it('keeps non-task lines in place', () => {
    const src = '# Heading\n- [x] done a\n- [ ] open b'
    const view = makeView(src, { anchor: 0, head: src.length })
    sortTasks(view)
    expect(read(view)).toBe('# Heading\n- [ ] open b\n- [x] done a')
  })

  it('returns false when only one task', () => {
    const src = '- [ ] only'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(sortTasks(view)).toBe(false)
  })
})

describe('ensureFrontmatter', () => {
  it('inserts an empty frontmatter block when missing', () => {
    const view = makeView('# Hi', { anchor: 0 })
    ensureFrontmatter(view)
    expect(read(view).startsWith('---\ntitle: \ntags: []\n---\n\n')).toBe(true)
    expect(read(view).endsWith('# Hi')).toBe(true)
  })

  it('does nothing when frontmatter exists', () => {
    const view = makeView('---\nx: 1\n---\nbody', { anchor: 0 })
    expect(ensureFrontmatter(view)).toBe(false)
  })
})

describe('toggleAllTasksInSelection', () => {
  it('flips every task within the selection', () => {
    const src = '- [ ] a\n- [x] b\n- [ ] c'
    const view = makeView(src, { anchor: 0, head: src.length })
    toggleAllTasksInSelection(view)
    expect(read(view)).toBe('- [x] a\n- [ ] b\n- [x] c')
  })

  it('returns false when selection has no task lines', () => {
    const view = makeView('plain paragraph', { anchor: 0, head: 14 })
    expect(toggleAllTasksInSelection(view)).toBe(false)
  })
})

describe('applySmartArrows', () => {
  it('replaces ASCII arrows with unicode', () => {
    const view = makeView('a -> b, c <- d, e => f, g <= h, i <-> j, k <=> l', { anchor: 0 })
    applySmartArrows(view)
    expect(read(view)).toBe('a → b, c ← d, e ⇒ f, g ⇐ h, i ↔ j, k ⇔ l')
  })

  it('returns false when no arrows present', () => {
    const view = makeView('no arrows here', { anchor: 0 })
    expect(applySmartArrows(view)).toBe(false)
  })
})

describe('insertDataviewField', () => {
  it('inserts a new line with key:: prefix', () => {
    const view = makeView('# Title\nhello', { anchor: 13 })
    insertDataviewField('status')(view)
    expect(read(view)).toBe('# Title\nhello\nstatus:: ')
  })

  it('reuses empty line if cursor is on empty line at end', () => {
    const view = makeView('hello\n', { anchor: 6 })
    insertDataviewField('tag')(view)
    expect(read(view)).toBe('hello\ntag:: ')
  })
})

describe('jumpToNextHeading', () => {
  it('jumps from H1 to next H2', () => {
    const src = '# A\nbody\n## B\nmore'
    const view = makeView(src, { anchor: 0 })
    jumpToNextHeading(view)
    const pos = view.state.selection.main.head
    const lineNo = view.state.doc.lineAt(pos).number
    expect(lineNo).toBe(3)
  })

  it('jumps to end-of-doc when no later heading', () => {
    const src = '# A\nbody'
    const view = makeView(src, { anchor: 0 })
    jumpToNextHeading(view)
    expect(view.state.selection.main.head).toBe(src.length)
  })

  it('skips headings inside fenced code blocks', () => {
    const src = '# A\n```\n# fake\n```\n## Real'
    const view = makeView(src, { anchor: 0 })
    jumpToNextHeading(view)
    const lineNo = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(lineNo).toBe(5)
  })
})

describe('jumpToPrevHeading', () => {
  it('jumps back from inside body to previous heading', () => {
    const src = '# A\nbody\n## B\nmore'
    const startBody = src.indexOf('more')
    const view = makeView(src, { anchor: startBody })
    jumpToPrevHeading(view)
    const lineNo = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(lineNo).toBe(3)
  })

  it('jumps to doc start when no earlier heading', () => {
    const src = 'paragraph\nmore'
    const view = makeView(src, { anchor: src.length })
    jumpToPrevHeading(view)
    expect(view.state.selection.main.head).toBe(0)
  })
})

describe('tableMoveColumnLeft / Right', () => {
  const table = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'

  it('moves the middle column to the left', () => {
    const view = makeView(table, { anchor: table.indexOf(' b ') + 1 })
    expect(tableMoveColumnLeft(view)).toBe(true)
    expect(read(view)).toContain('| b | a | c |')
    expect(read(view)).toContain('| 2 | 1 | 3 |')
  })

  it('refuses to move leftmost column further left', () => {
    const view = makeView(table, { anchor: table.indexOf('a') })
    expect(tableMoveColumnLeft(view)).toBe(false)
  })

  it('moves the middle column to the right', () => {
    const view = makeView(table, { anchor: table.indexOf(' b ') + 1 })
    expect(tableMoveColumnRight(view)).toBe(true)
    expect(read(view)).toContain('| a | c | b |')
  })

  it('refuses to move rightmost column further right', () => {
    const view = makeView(table, { anchor: table.indexOf(' c ') + 1 })
    expect(tableMoveColumnRight(view)).toBe(false)
  })
})

describe('tableMoveRowUp / Down', () => {
  const table = '| h |\n| --- |\n| a |\n| b |\n| c |'

  it('swaps current body row with the row above it', () => {
    const view = makeView(table, { anchor: table.indexOf('b') })
    expect(tableMoveRowUp(view)).toBe(true)
    expect(read(view)).toContain('| b |\n| a |')
  })

  it('refuses to move the first body row upward', () => {
    const view = makeView(table, { anchor: table.indexOf('a') })
    expect(tableMoveRowUp(view)).toBe(false)
  })

  it('swaps current body row with the row below it', () => {
    const view = makeView(table, { anchor: table.indexOf('a') })
    expect(tableMoveRowDown(view)).toBe(true)
    expect(read(view)).toContain('| b |\n| a |')
  })

  it('refuses to move the last body row downward', () => {
    const view = makeView(table, { anchor: table.indexOf('c') })
    expect(tableMoveRowDown(view)).toBe(false)
  })
})

describe('swapLineUp / swapLineDown', () => {
  it('swaps line with previous and follows cursor', () => {
    const view = makeView('one\ntwo\nthree', { anchor: 4 })
    expect(swapLineUp(view)).toBe(true)
    expect(read(view)).toBe('two\none\nthree')
    expect(view.state.selection.main.head).toBe(0)
  })

  it('returns false on first line', () => {
    const view = makeView('one\ntwo', { anchor: 0 })
    expect(swapLineUp(view)).toBe(false)
  })

  it('swaps line with next and follows cursor', () => {
    const view = makeView('one\ntwo\nthree', { anchor: 4 })
    expect(swapLineDown(view)).toBe(true)
    expect(read(view)).toBe('one\nthree\ntwo\n'.slice(0, -1))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
  })

  it('returns false on last line', () => {
    const src = 'one\ntwo'
    const view = makeView(src, { anchor: src.length })
    expect(swapLineDown(view)).toBe(false)
  })
})

describe('normalizeBulletMarkers', () => {
  it('rewrites * / + bullets to -', () => {
    const view = makeView('* a\n+ b\n- c', { anchor: 0 })
    expect(normalizeBulletMarkers(view)).toBe(true)
    expect(read(view)).toBe('- a\n- b\n- c')
  })

  it('skips lines inside fenced code blocks', () => {
    const view = makeView('```\n* keep\n```\n* change', { anchor: 0 })
    normalizeBulletMarkers(view)
    expect(read(view)).toBe('```\n* keep\n```\n- change')
  })
})

describe('renumberOrderedLists', () => {
  it('fixes broken ordered list numbering at same indent', () => {
    const view = makeView('1. a\n5. b\n9. c', { anchor: 0 })
    expect(renumberOrderedLists(view)).toBe(true)
    expect(read(view)).toBe('1. a\n2. b\n3. c')
  })

  it('restarts after blank line', () => {
    const view = makeView('1. a\n5. b\n\n9. c\n7. d', { anchor: 0 })
    renumberOrderedLists(view)
    expect(read(view)).toBe('1. a\n2. b\n\n1. c\n2. d')
  })

  it('returns false when already numbered correctly', () => {
    const view = makeView('1. a\n2. b\n3. c', { anchor: 0 })
    expect(renumberOrderedLists(view)).toBe(false)
  })
})

describe('selectCurrentParagraph', () => {
  it('expands to paragraph boundaries', () => {
    const src = 'p1 line a\np1 line b\n\np2 line a'
    const view = makeView(src, { anchor: 5 })
    expect(selectCurrentParagraph(view)).toBe(true)
    const r = view.state.selection.main
    expect(r.from).toBe(0)
    expect(src.slice(r.from, r.to)).toBe('p1 line a\np1 line b')
  })

  it('returns false when already at full paragraph selection', () => {
    const src = 'one paragraph\nstill in it'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(selectCurrentParagraph(view)).toBe(false)
  })
})

describe('ensureReferencesSection', () => {
  it('appends a References section when missing', () => {
    const view = makeView('# Title\n', { anchor: 8 })
    expect(ensureReferencesSection(view)).toBe(true)
    expect(read(view)).toContain('## References')
  })

  it('returns false when the section already exists', () => {
    const view = makeView('# T\n\n## References\n\n', { anchor: 0 })
    expect(ensureReferencesSection(view)).toBe(false)
  })
})

describe('transformCase sentence', () => {
  it('sentence-cases an all-caps run', () => {
    const view = makeView('HELLO WORLD. HOW ARE YOU? FINE!', { anchor: 0, head: 31 })
    transformCase('sentence')(view)
    expect(read(view)).toBe('Hello world. How are you? Fine!')
  })

  it('keeps after CJK punctuation correctly', () => {
    const src = `hello${String.fromCodePoint(0x3002)} hello${String.fromCodePoint(0xff01)}`
    const view = makeView(src, { anchor: 0, head: src.length })
    transformCase('sentence')(view)
    expect(read(view)).toBe(`Hello${String.fromCodePoint(0x3002)} Hello${String.fromCodePoint(0xff01)}`)
  })
})

describe('reverseLines', () => {
  it('reverses selected line order', () => {
    const src = 'a\nb\nc'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(reverseLines(view)).toBe(true)
    expect(read(view)).toBe('c\nb\na')
  })

  it('returns false on single-line selection', () => {
    const view = makeView('only', { anchor: 0, head: 4 })
    expect(reverseLines(view)).toBe(false)
  })
})

describe('dedupSelectedLines', () => {
  it('removes duplicate lines preserving first occurrence', () => {
    const src = 'a\nb\na\nc\nb'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(dedupSelectedLines(view)).toBe(true)
    expect(read(view)).toBe('a\nb\nc')
  })

  it('returns false when no duplicates', () => {
    const src = 'a\nb\nc'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(dedupSelectedLines(view)).toBe(false)
  })
})

describe('removeEmptyLines', () => {
  it('removes blank lines from selection', () => {
    const src = 'a\n\nb\n\n\nc'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(removeEmptyLines(view)).toBe(true)
    expect(read(view)).toBe('a\nb\nc')
  })

  it('returns false when no blank lines', () => {
    const src = 'a\nb\nc'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(removeEmptyLines(view)).toBe(false)
  })
})

describe('collapseInnerSpaces', () => {
  it('collapses runs of inner spaces to one', () => {
    const src = 'a    b      c'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(collapseInnerSpaces(view)).toBe(true)
    expect(read(view)).toBe('a b c')
  })

  it('keeps leading indent untouched', () => {
    const src = '    a   b'
    const view = makeView(src, { anchor: 0, head: src.length })
    collapseInnerSpaces(view)
    expect(read(view)).toBe('    a b')
  })
})

describe('decodeHtmlEntities', () => {
  it('decodes common entities in selection', () => {
    const src = '&amp; &lt; &gt; &quot; &#39; &nbsp;X'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(decodeHtmlEntities(view)).toBe(true)
    expect(read(view)).toBe('& < > " \'  X')
  })

  it('returns false when nothing to decode', () => {
    const src = 'plain text'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(decodeHtmlEntities(view)).toBe(false)
  })
})

describe('getDocumentStats', () => {
  it('counts english words separately from CJK chars', () => {
    const source = `Hello world ${String.fromCodePoint(0x4f60, 0x597d)} ${String.fromCodePoint(0x4e16, 0x754c)}`
    const view = makeView(source, { anchor: 0 })
    const s = getDocumentStats(view)
    expect(s.words).toBe(2 + 4)
    expect(s.chars).toBe(source.length)
    expect(s.readingMinutes).toBeGreaterThanOrEqual(1)
  })

  it('reports line count from CM doc', () => {
    const view = makeView('a\nb\nc\nd', { anchor: 0 })
    expect(getDocumentStats(view).lines).toBe(4)
  })
})

describe('insertTodayLink / insertYesterdayLink / insertTomorrowLink', () => {
  const DATE_LINK_RE = /^\[\[\d{4}-\d{2}-\d{2}\]\]/

  it('inserts a wikilink for today', () => {
    const view = makeView('intro ', { anchor: 6 })
    insertTodayLink(view)
    expect(view.state.doc.sliceString(6, view.state.selection.main.head)).toMatch(DATE_LINK_RE)
  })

  it('inserts a wikilink for yesterday', () => {
    const view = makeView('', { anchor: 0 })
    insertYesterdayLink(view)
    expect(view.state.doc.toString()).toMatch(DATE_LINK_RE)
  })

  it('inserts a wikilink for tomorrow', () => {
    const view = makeView('', { anchor: 0 })
    insertTomorrowLink(view)
    expect(view.state.doc.toString()).toMatch(DATE_LINK_RE)
  })

  it('yesterday and tomorrow date strings differ', () => {
    const v1 = makeView('', { anchor: 0 })
    const v2 = makeView('', { anchor: 0 })
    insertYesterdayLink(v1)
    insertTomorrowLink(v2)
    expect(v1.state.doc.toString()).not.toBe(v2.state.doc.toString())
  })
})

describe('convertTabsToSpaces / convertSpacesToTabs', () => {
  it('replaces \\t with N spaces inside selection', () => {
    const src = 'before\n\tindented\tagain\nafter'
    const view = makeView(src, { anchor: 7, head: 24 })
    convertTabsToSpaces(2)(view)
    expect(view.state.doc.toString()).toBe('before\n  indented  again\nafter')
  })

  it('returns false when selection has no tab', () => {
    const view = makeView('plain text', { anchor: 0, head: 10 })
    expect(convertTabsToSpaces(2)(view)).toBe(false)
  })

  it('converts leading spaces back to tabs', () => {
    const view = makeView('    code\n  text', { anchor: 0, head: 15 })
    expect(convertSpacesToTabs(2)(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('\t\tcode\n\ttext')
  })

  it('keeps remainder spaces when not divisible', () => {
    const view = makeView('   item', { anchor: 0, head: 7 })
    convertSpacesToTabs(2)(view)
    expect(view.state.doc.toString()).toBe('\t item')
  })
})

describe('generateTOC', () => {
  it('produces a flat list when only one heading level', () => {
    const view = makeView('# A\n# B\n# C\n[TOC]', { anchor: 12 })
    expect(generateTOC(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out).toContain('- [A](#a)')
    expect(out).toContain('- [B](#b)')
    expect(out).toContain('- [C](#c)')
  })

  it('indents deeper levels relative to the shallowest', () => {
    const view = makeView('## A\n### B\n## C', { anchor: 0 })
    generateTOC(view)
    expect(view.state.doc.toString()).toContain('  - [B](#b)')
  })

  it('returns false when there are no headings', () => {
    const view = makeView('plain text', { anchor: 0 })
    expect(generateTOC(view)).toBe(false)
  })
})

describe('wrapAsSpoiler', () => {
  it('wraps selection in <details> block', () => {
    const view = makeView('secret stuff', { anchor: 0, head: 12 })
    wrapAsSpoiler()(view)
    const out = view.state.doc.toString()
    expect(out.startsWith('<details>')).toBe(true)
    expect(out).toContain('secret stuff')
    expect(out.endsWith('</details>')).toBe(true)
  })

  it('uses custom summary text', () => {
    const view = makeView('hidden', { anchor: 0, head: 6 })
    wrapAsSpoiler('Spoiler warning')(view)
    expect(view.state.doc.toString()).toContain('<summary>Spoiler warning</summary>')
  })
})

describe('splitMarkdownSlides', () => {
  it('returns single slide when no breaks', () => {
    const r = splitMarkdownSlides('one\ntwo\nthree')
    expect(r).toHaveLength(1)
    expect(r[0].content).toBe('one\ntwo\nthree')
    expect(r[0].startLine).toBe(1)
  })

  it('splits on solo --- lines', () => {
    const r = splitMarkdownSlides('a\n---\nb\n---\nc')
    expect(r).toHaveLength(3)
    expect(r.map((s) => s.content)).toEqual(['a', 'b', 'c'])
  })

  it('skips frontmatter when counting slides', () => {
    const src = '---\ntitle: x\n---\n# slide 1\n---\n# slide 2'
    const r = splitMarkdownSlides(src)
    expect(r).toHaveLength(2)
    expect(r[0].content).toBe('# slide 1')
    expect(r[1].content).toBe('# slide 2')
  })

  it('treats --- inside fenced code as content, not break', () => {
    const src = 'a\n```\n---\n```\nb'
    const r = splitMarkdownSlides(src)
    expect(r).toHaveLength(1)
  })

  it('skips empty slides', () => {
    const r = splitMarkdownSlides('a\n---\n\n---\nb')
    expect(r).toHaveLength(2)
    expect(r.map((s) => s.content)).toEqual(['a', 'b'])
  })

  it('reports start line numbers (1-based)', () => {
    const r = splitMarkdownSlides('a\n---\nb\nc\n---\nd')
    expect(r[0].startLine).toBe(1)
    expect(r[1].startLine).toBe(3)
    expect(r[2].startLine).toBe(6)
  })
})

describe('jumpToSlide', () => {
  it('moves cursor to slide N start', () => {
    const view = makeView('a\n---\nb\n---\nc', { anchor: 0 })
    expect(jumpToSlide(view, 2)).toBe(true)
    const head = view.state.selection.main.head
    expect(view.state.doc.lineAt(head).text).toBe('b')
  })

  it('clamps to last slide when N exceeds count', () => {
    const view = makeView('a\n---\nb', { anchor: 0 })
    jumpToSlide(view, 99)
    const head = view.state.selection.main.head
    expect(view.state.doc.lineAt(head).text).toBe('b')
  })

  it('returns false when no slides', () => {
    const view = makeView('', { anchor: 0 })
    expect(jumpToSlide(view, 1)).toBe(false)
  })
})

describe('jumpToNextSlide / jumpToPrevSlide', () => {
  it('advances to the next slide', () => {
    const view = makeView('a\n---\nb\n---\nc', { anchor: 0 })
    expect(jumpToNextSlide(view)).toBe(true)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('b')
  })

  it('returns false when already on the last slide', () => {
    const src = 'a\n---\nb'
    const view = makeView(src, { anchor: src.indexOf('b') })
    expect(jumpToNextSlide(view)).toBe(false)
  })

  it('returns to previous slide', () => {
    const src = 'a\n---\nb\n---\nc'
    const view = makeView(src, { anchor: src.indexOf('c') })
    expect(jumpToPrevSlide(view)).toBe(true)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('b')
  })

  it('returns false when already on first slide', () => {
    const view = makeView('a\n---\nb', { anchor: 0 })
    expect(jumpToPrevSlide(view)).toBe(false)
  })
})

describe('insertSlideBreak', () => {
  it('inserts --- after current line', () => {
    const view = makeView('hello', { anchor: 5 })
    insertSlideBreak(view)
    expect(view.state.doc.toString()).toContain('hello\n---')
  })

  it('produces well-formed split that increases slide count', () => {
    const view = makeView('hello', { anchor: 5 })
    insertSlideBreak(view)
    const slides = splitMarkdownSlides(view.state.doc.toString())
    expect(slides.length).toBeGreaterThanOrEqual(1)
  })
})

describe('getCodeBlockAtCursor', () => {
  it('returns null when cursor is outside fence', () => {
    const view = makeView('hello world', { anchor: 0 })
    expect(getCodeBlockAtCursor(view)).toBeNull()
  })

  it('finds enclosing fence with language', () => {
    const src = 'before\n```ts\nconst x = 1\n```\nafter'
    const cursorAt = src.indexOf('const')
    const view = makeView(src, { anchor: cursorAt })
    const info = getCodeBlockAtCursor(view)
    expect(info).not.toBeNull()
    expect(info!.lang).toBe('ts')
    expect(info!.body).toBe('const x = 1')
  })

  it('returns null when cursor is on the fence opening line', () => {
    const src = '```ts\nfoo\n```'
    const view = makeView(src, { anchor: 0 })
    expect(getCodeBlockAtCursor(view)).toBeNull()
  })
})

describe('changeCodeBlockLang', () => {
  it('replaces the language of enclosing fence', () => {
    const src = '```ts\nfoo\n```'
    const view = makeView(src, { anchor: src.indexOf('foo') })
    changeCodeBlockLang('python')(view)
    expect(view.state.doc.toString().startsWith('```python\n')).toBe(true)
  })

  it('clears language when given empty string', () => {
    const src = '```ts\nfoo\n```'
    const view = makeView(src, { anchor: src.indexOf('foo') })
    changeCodeBlockLang('')(view)
    expect(view.state.doc.toString().split('\n')[0]).toBe('```')
  })

  it('returns false when no fence at cursor', () => {
    const view = makeView('no fence here', { anchor: 0 })
    expect(changeCodeBlockLang('ts')(view)).toBe(false)
  })
})

describe('shiftAllHeadings', () => {
  it('promotes all headings (delta = -1)', () => {
    const view = makeView('## a\n### b\n# c', { anchor: 0 })
    shiftAllHeadings(-1)(view)
    expect(view.state.doc.toString()).toBe('# a\n## b\n# c')
  })

  it('demotes all headings (delta = +1)', () => {
    const view = makeView('# a\n## b', { anchor: 0 })
    shiftAllHeadings(1)(view)
    expect(view.state.doc.toString()).toBe('## a\n### b')
  })

  it('clamps at H6 / H1', () => {
    const view = makeView('###### a\n# b', { anchor: 0 })
    shiftAllHeadings(1)(view)
    expect(view.state.doc.toString()).toBe('###### a\n## b')
  })

  it('ignores headings inside fenced code', () => {
    const src = '```\n# fake\n```\n## real'
    const view = makeView(src, { anchor: 0 })
    shiftAllHeadings(1)(view)
    expect(view.state.doc.toString()).toBe('```\n# fake\n```\n### real')
  })

  it('returns false when delta is zero', () => {
    const view = makeView('# a', { anchor: 0 })
    expect(shiftAllHeadings(0)(view)).toBe(false)
  })
})

describe('parseCsv', () => {
  it('parses simple comma rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('handles quoted fields with commas', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('handles escaped quotes ""', () => {
    expect(parseCsv('a,"b""c",d')).toEqual([['a', 'b"c', 'd']])
  })

  it('strips trailing blank line', () => {
    expect(parseCsv('a,b\n\n')).toEqual([['a', 'b']])
  })

  it('supports custom delimiter', () => {
    expect(parseCsv('a;b;c', ';')).toEqual([['a', 'b', 'c']])
  })
})

describe('csvToMarkdownTable', () => {
  it('produces an aligned table with sep row', () => {
    const md = csvToMarkdownTable('name,age\nalice,30\nbob,25')
    const lines = md.split('\n')
    expect(lines[0].startsWith('| name')).toBe(true)
    expect(lines[1].includes('---')).toBe(true)
    expect(lines.length).toBe(4)
  })

  it('returns empty for empty csv', () => {
    expect(csvToMarkdownTable('')).toBe('')
  })
})

describe('markdownTableToCsv', () => {
  it('reverses a simple table', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(markdownTableToCsv(md)).toBe('a,b\n1,2')
  })

  it('quotes fields containing commas', () => {
    const md = '| a | b |\n| --- | --- |\n| x,y | z |'
    expect(markdownTableToCsv(md)).toBe('a,b\n"x,y",z')
  })

  it('skips separator row even with alignment colons', () => {
    const md = '| a | b |\n| :--- | ---: |\n| 1 | 2 |'
    expect(markdownTableToCsv(md)).toBe('a,b\n1,2')
  })
})

describe('stripMarkdownToPlain', () => {
  it('removes heading markers', () => {
    expect(stripMarkdownToPlain('# Hello\n## World')).toBe('Hello\nWorld')
  })

  it('removes bold/italic/strike', () => {
    expect(stripMarkdownToPlain('**bold** *ital* ~~del~~')).toBe('bold ital del')
  })

  it('keeps wikilink alias', () => {
    expect(stripMarkdownToPlain('see [[Note|the note]] yes')).toBe('see the note yes')
  })

  it('keeps wikilink target when no alias', () => {
    expect(stripMarkdownToPlain('[[MyNote]]')).toBe('MyNote')
  })

  it('keeps link text, drops url', () => {
    expect(stripMarkdownToPlain('[click](https://x.com)')).toBe('click')
  })

  it('keeps image alt', () => {
    expect(stripMarkdownToPlain('![alt](url)')).toBe('alt')
  })

  it('strips list markers', () => {
    expect(stripMarkdownToPlain('- a\n- b\n1. c')).toBe('a\nb\nc')
  })

  it('strips blockquote markers', () => {
    expect(stripMarkdownToPlain('> note\n>> deep')).toBe('note\ndeep')
  })

  it('collapses 3+ blank lines', () => {
    expect(stripMarkdownToPlain('a\n\n\n\n\nb')).toBe('a\n\nb')
  })
})

describe('replaceWithPlain', () => {
  it('replaces selection in place', () => {
    const src = '# Title text'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(replaceWithPlain(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Title text')
  })

  it('returns false when no selection', () => {
    const view = makeView('# x', { anchor: 0 })
    expect(replaceWithPlain(view)).toBe(false)
  })
})

describe('convertCsvSelectionToTable / convertTableSelectionToCsv', () => {
  it('converts CSV selection to markdown table', () => {
    const src = 'a,b\n1,2'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(convertCsvSelectionToTable()(view)).toBe(true)
    expect(view.state.doc.toString()).toMatch(/^\| a/)
  })

  it('converts markdown-table selection to CSV', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(convertTableSelectionToCsv()(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a,b\n1,2')
  })
})

describe('markAllTasks', () => {
  it('marks every unchecked task done', () => {
    const view = makeView('- [ ] a\n- [ ] b\n- text', { anchor: 0 })
    expect(markAllTasks('done')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- [x] a\n- [x] b\n- text')
  })

  it('marks every checked task undone', () => {
    const view = makeView('- [x] a\n- [X] b', { anchor: 0 })
    markAllTasks('undone')(view)
    expect(view.state.doc.toString()).toBe('- [ ] a\n- [ ] b')
  })

  it('returns false when nothing to change', () => {
    const view = makeView('- [x] a', { anchor: 0 })
    expect(markAllTasks('done')(view)).toBe(false)
  })

  it('ignores tasks inside fenced code', () => {
    const src = '```\n- [ ] code\n```\n- [ ] real'
    const view = makeView(src, { anchor: 0 })
    markAllTasks('done')(view)
    expect(view.state.doc.toString()).toBe('```\n- [ ] code\n```\n- [x] real')
  })
})

describe('archiveDoneTasks', () => {
  it('moves done tasks to a new Archived section', () => {
    const src = '- [x] a\n- [ ] b\n- [x] c'
    const view = makeView(src, { anchor: 0 })
    expect(archiveDoneTasks(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out).toContain('## Archived')
    expect(out.indexOf('- [ ] b')).toBeGreaterThan(-1)
    expect(out.indexOf('- [x] a')).toBeGreaterThan(out.indexOf('## Archived'))
  })

  it('appends under existing Archived heading', () => {
    const src = '- [x] new\n\n## Archived\n- [x] old'
    const view = makeView(src, { anchor: 0 })
    archiveDoneTasks(view)
    const out = view.state.doc.toString()
                              
    expect(out.indexOf('- [x] new')).toBeGreaterThan(out.indexOf('## Archived'))
  })

  it('returns false when no done tasks', () => {
    const view = makeView('- [ ] only undone', { anchor: 0 })
    expect(archiveDoneTasks(view)).toBe(false)
  })
})

describe('renameDocumentTag', () => {
  it('renames all occurrences', () => {
    const view = makeView('hello #foo and #foo here', { anchor: 0 })
    renameDocumentTag('foo', 'bar')(view)
    expect(view.state.doc.toString()).toBe('hello #bar and #bar here')
  })

  it('does not touch partial-match tags', () => {
    const view = makeView('#foobar stays #foo changes', { anchor: 0 })
    renameDocumentTag('foo', 'baz')(view)
    expect(view.state.doc.toString()).toBe('#foobar stays #baz changes')
  })

  it('renames hierarchical tags', () => {
    const view = makeView('#project/alpha is the one', { anchor: 0 })
    renameDocumentTag('project/alpha', 'project/beta')(view)
    expect(view.state.doc.toString()).toBe('#project/beta is the one')
  })

  it('skips tags in fenced code', () => {
    const src = '```\n#foo\n```\n#foo'
    const view = makeView(src, { anchor: 0 })
    renameDocumentTag('foo', 'bar')(view)
    expect(view.state.doc.toString()).toBe('```\n#foo\n```\n#bar')
  })

  it('returns false when nothing changes', () => {
    const view = makeView('hello world', { anchor: 0 })
    expect(renameDocumentTag('foo', 'bar')(view)).toBe(false)
  })
})

describe('markdownOutlineToOpml / opmlToMarkdownOutline', () => {
  it('round-trips a flat list', () => {
    const md = '- one\n- two\n- three'
    const opml = markdownOutlineToOpml(md)
    expect(opml).toContain('<outline text="one"/>')
    expect(opmlToMarkdownOutline(opml)).toBe(md)
  })

  it('round-trips a nested list', () => {
    const md = '- a\n  - a1\n  - a2\n- b'
    const opml = markdownOutlineToOpml(md)
    expect(opml).toContain('<outline text="a">')
    expect(opmlToMarkdownOutline(opml)).toBe(md)
  })

  it('escapes special chars', () => {
    expect(markdownOutlineToOpml('- a < b & c')).toContain('a &lt; b &amp; c')
  })
})

describe('convertOutlineSelectionToOpml / convertOpmlSelectionToOutline', () => {
  it('converts md outline selection to OPML', () => {
    const src = '- a\n- b'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(convertOutlineSelectionToOpml(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('<opml')
  })

  it('converts OPML selection back to markdown', () => {
    const opml = '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head/>\n  <body>\n    <outline text="x"/>\n    <outline text="y"/>\n  </body>\n</opml>'
    const view = makeView(opml, { anchor: 0, head: opml.length })
    expect(convertOpmlSelectionToOutline(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- x\n- y')
  })
})

describe('promoteListItem / demoteListItem', () => {
  it('demotes a single bullet (adds 2 spaces)', () => {
    const view = makeView('- foo', { anchor: 0 })
    expect(demoteListItem(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  - foo')
  })

  it('demotes item with sublist together', () => {
    const src = '- a\n  - a1'
    const view = makeView(src, { anchor: 0 })
    demoteListItem(view)
    expect(view.state.doc.toString()).toBe('  - a\n    - a1')
  })

  it('promotes by removing 2 leading spaces', () => {
    const view = makeView('  - foo', { anchor: 2 })
    expect(promoteListItem(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- foo')
  })

  it('returns false when promoting from no-indent', () => {
    const view = makeView('- foo', { anchor: 0 })
    expect(promoteListItem(view)).toBe(false)
  })

  it('returns false when cursor is not on a list line', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(demoteListItem(view)).toBe(false)
    expect(promoteListItem(view)).toBe(false)
  })
})

describe('convertBulletListToOrdered', () => {
  it('converts a consecutive bullet block to 1..N', () => {
    const src = '- a\n- b\n- c'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(convertBulletListToOrdered(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. c')
  })

  it('preserves indentation', () => {
    const src = '  - x\n  - y'
    const view = makeView(src, { anchor: 0, head: src.length })
    convertBulletListToOrdered(view)
    expect(view.state.doc.toString()).toBe('  1. x\n  2. y')
  })

  it('returns false on plain text', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(convertBulletListToOrdered(view)).toBe(false)
  })

  it('restarts numbering after a non-list line', () => {
    const src = '- a\nx\n- b'
    const view = makeView(src, { anchor: 0, head: src.length })
    convertBulletListToOrdered(view)
    expect(view.state.doc.toString()).toBe('1. a\nx\n1. b')
  })
})

describe('convertOrderedListToBullet', () => {
  it('replaces 1. with -', () => {
    const src = '1. a\n2. b'
    const view = makeView(src, { anchor: 0, head: src.length })
    expect(convertOrderedListToBullet(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- a\n- b')
  })

  it('returns false if no ordered lines', () => {
    const view = makeView('- a', { anchor: 0 })
    expect(convertOrderedListToBullet(view)).toBe(false)
  })
})

describe('insertUuid', () => {
  it('inserts a UUID at the cursor', () => {
    const view = makeView('', { anchor: 0 })
    expect(insertUuid(view)).toBe(true)
    expect(view.state.doc.toString()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[14][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('replaces selection', () => {
    const view = makeView('hello', { anchor: 0, head: 5 })
    insertUuid(view)
    expect(view.state.doc.toString().length).toBe(36)
  })
})

describe('sortFrontmatterKeys', () => {
  it('sorts top-level keys alphabetically', () => {
    const src = '---\nz: 1\nb: 2\na: 3\n---\nbody'
    const view = makeView(src, { anchor: 0 })
    expect(sortFrontmatterKeys(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('---\na: 3\nb: 2\nz: 1\n---\nbody')
  })

  it('keeps indented lines attached to their parent key', () => {
    const src = '---\nb: x\na:\n  - one\n  - two\n---'
    const view = makeView(src, { anchor: 0 })
    sortFrontmatterKeys(view)
    expect(view.state.doc.toString()).toBe('---\na:\n  - one\n  - two\nb: x\n---')
  })

  it('returns false when there is no frontmatter', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(sortFrontmatterKeys(view)).toBe(false)
  })

  it('returns false when already sorted', () => {
    const view = makeView('---\na: 1\nb: 2\n---', { anchor: 0 })
    expect(sortFrontmatterKeys(view)).toBe(false)
  })
})

describe('reverseCase', () => {
  it('swaps case for ASCII letters in the selection', () => {
    const view = makeView('Hello World', { anchor: 0, head: 11 })
    expect(reverseCase(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hELLO wORLD')
  })

  it('leaves non-letters alone', () => {
    const view = makeView('a1B', { anchor: 0, head: 3 })
    reverseCase(view)
    expect(view.state.doc.toString()).toBe('A1b')
  })

  it('returns false on empty selection', () => {
    const view = makeView('abc', { anchor: 1 })
    expect(reverseCase(view)).toBe(false)
  })
})

describe('table rotate / transpose / dedup', () => {
  const TABLE = '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'

  it('rotates columns left', () => {
    const view = makeView(TABLE, { anchor: 2 })
    expect(tableRotateColumnsLeft(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out).toContain('| b | c | a |')
    expect(out).toContain('| 2 | 3 | 1 |')
    expect(out).toContain('| 5 | 6 | 4 |')
  })

  it('rotates columns right', () => {
    const view = makeView(TABLE, { anchor: 2 })
    expect(tableRotateColumnsRight(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out).toContain('| c | a | b |')
    expect(out).toContain('| 3 | 1 | 2 |')
    expect(out).toContain('| 6 | 4 | 5 |')
  })

  it('transposes a table', () => {
    const view = makeView(TABLE, { anchor: 2 })
    expect(tableTranspose(view)).toBe(true)
    const lines = view.state.doc.toString().split('\n')
    expect(lines[0]).toContain('| a | 1 | 4 |')
    expect(lines[2]).toContain('| b | 2 | 5 |')
    expect(lines[3]).toContain('| c | 3 | 6 |')
  })

  it('dedups body rows by first column', () => {
    const src = '| k | v |\n| - | - |\n| a | 1 |\n| a | 2 |\n| b | 3 |'
    const view = makeView(src, { anchor: 2 })
    expect(tableDedupRowsByFirstColumn(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out).toContain('| a | 1 |')
    expect(out).not.toContain('| a | 2 |')
    expect(out).toContain('| b | 3 |')
  })

  it('returns false when dedup has nothing to do', () => {
    const src = '| k | v |\n| - | - |\n| a | 1 |\n| b | 2 |'
    const view = makeView(src, { anchor: 2 })
    expect(tableDedupRowsByFirstColumn(view)).toBe(false)
  })

  it('returns false when not on a table', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(tableTranspose(view)).toBe(false)
    expect(tableRotateColumnsLeft(view)).toBe(false)
    expect(tableRotateColumnsRight(view)).toBe(false)
  })
})

describe('escapeMarkdownText / unescapeMarkdownText', () => {
  it('escapes common control characters', () => {
    expect(escapeMarkdownText('*hello* [link](x)')).toBe('\\*hello\\* \\[link\\]\\(x\\)')
  })

  it('escapes backslash itself', () => {
    expect(escapeMarkdownText('a\\b')).toBe('a\\\\b')
  })

  it('roundtrips', () => {
    const src = '*x* _y_ `z` [w](u) <v> #h - 1.'
    expect(unescapeMarkdownText(escapeMarkdownText(src))).toBe(src)
  })
})

describe('escapeMarkdownSelection / unescapeMarkdownSelection', () => {
  it('escapes selection in place', () => {
    const view = makeView('hello *world*', { anchor: 6, head: 13 })
    expect(escapeMarkdownSelection(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hello \\*world\\*')
  })

  it('returns false on empty selection', () => {
    const view = makeView('abc', { anchor: 0 })
    expect(escapeMarkdownSelection(view)).toBe(false)
    expect(unescapeMarkdownSelection(view)).toBe(false)
  })

  it('unescapes selection', () => {
    const view = makeView('hello \\*x\\*', { anchor: 6, head: 11 })
    expect(unescapeMarkdownSelection(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hello *x*')
  })

  it('returns false when text has no markdown specials', () => {
    const view = makeView('abc xyz', { anchor: 0, head: 7 })
    expect(escapeMarkdownSelection(view)).toBe(false)
  })
})

describe('wrapAsDetails', () => {
  it('wraps the selection in <details>', () => {
    const view = makeView('hello world', { anchor: 0, head: 5 })
    expect(wrapAsDetails('Expand')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<details>\n<summary>Expand</summary>\n\nhello\n\n</details> world')
  })

  it('inserts an empty body when selection is empty', () => {
    const view = makeView('', { anchor: 0 })
    wrapAsDetails()(view)
    expect(view.state.doc.toString()).toContain('<details>')
    expect(view.state.doc.toString()).toContain('<summary>Details</summary>')
  })
})

describe('convertHeadingsToList', () => {
  it('turns H1/H2/H3 into nested bullets', () => {
    const view = makeView('# A\n## B\n### C', { anchor: 0 })
    expect(convertHeadingsToList(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- A\n  - B\n    - C')
  })

  it('returns false when no headings present', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(convertHeadingsToList(view)).toBe(false)
  })

  it('preserves fenced code', () => {
    const src = '# real\n```\n# fake\n```'
    const view = makeView(src, { anchor: 0 })
    convertHeadingsToList(view)
    expect(view.state.doc.toString()).toBe('- real\n```\n# fake\n```')
  })
})

describe('convertBulletsToHeadings', () => {
  it('converts bullets at depth 0/2/4 to H1/H2/H3', () => {
    const view = makeView('- A\n  - B\n    - C', { anchor: 0 })
    expect(convertBulletsToHeadings(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('# A\n## B\n### C')
  })

  it('caps depth at H6', () => {
    const view = makeView('            - X', { anchor: 0 })
    convertBulletsToHeadings(view)
    expect(view.state.doc.toString()).toBe('####### X'.slice(0, 0) + '#'.repeat(6) + ' X')
  })

  it('returns false on plain text', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(convertBulletsToHeadings(view)).toBe(false)
  })
})

describe('capitalizeSentencesText', () => {
  it('capitalizes first letter of each sentence', () => {
    expect(capitalizeSentencesText('hello world. how are you? fine!')).toBe('Hello world. How are you? Fine!')
  })

  it('handles already-capitalized text', () => {
    expect(capitalizeSentencesText('Hello. World.')).toBe('Hello. World.')
  })

  it('treats numbered list periods as sentence endings (acceptable)', () => {
    expect(capitalizeSentencesText('1. one. 2. two.')).toBe('1. One. 2. Two.')
  })
})

describe('capitalizeEachWordText', () => {
  it('capitalizes each word', () => {
    expect(capitalizeEachWordText('hello world')).toBe('Hello World')
  })

  it('preserves uppercase letters in middle', () => {
    expect(capitalizeEachWordText('iPhone is here')).toBe('IPhone Is Here')
  })

  it('handles punctuation boundaries', () => {
    expect(capitalizeEachWordText('foo-bar.baz')).toBe('Foo-Bar.Baz')
  })
})

describe('capitalizeSentences / capitalizeEachWord commands', () => {
  it('capitalizeSentences updates selection in place', () => {
    const view = makeView('hello. world.', { anchor: 0, head: 13 })
    expect(capitalizeSentences(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Hello. World.')
  })

  it('returns false on empty selection', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(capitalizeSentences(view)).toBe(false)
    expect(capitalizeEachWord(view)).toBe(false)
  })

  it('capitalizeEachWord updates selection', () => {
    const view = makeView('hello world', { anchor: 0, head: 11 })
    expect(capitalizeEachWord(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Hello World')
  })
})

describe('straightToCurlyQuotesText / curlyToStraightQuotesText', () => {
  it('converts paired ASCII quotes to curly', () => {
    expect(straightToCurlyQuotesText('"hello"')).toBe('“hello”')
  })

  it('handles single quotes', () => {
    expect(straightToCurlyQuotesText("'hi'")).toBe('‘hi’')
  })

  it('treats post-word quotes as closing', () => {
    expect(straightToCurlyQuotesText("isn't")).toBe('isn’t')
  })

  it('roundtrips', () => {
    expect(curlyToStraightQuotesText('“hello” ‘world’')).toBe('"hello" \'world\'')
  })
})

describe('straightToCurlyQuotes / curlyToStraightQuotes commands', () => {
  it('converts the whole doc when no selection', () => {
    const view = makeView('say "hi"', { anchor: 0 })
    expect(straightToCurlyQuotes(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('say “hi”')
  })

  it('converts only the selection', () => {
    const view = makeView('a "x" b "y"', { anchor: 0, head: 5 })
    straightToCurlyQuotes(view)
    expect(view.state.doc.toString()).toBe('a “x” b "y"')
  })

  it('curlyToStraightQuotes returns false when nothing to do', () => {
    const view = makeView('plain', { anchor: 0 })
    expect(curlyToStraightQuotes(view)).toBe(false)
  })
})

describe('sortListBlock / uniqueListBlock / shuffleListBlock', () => {
  it('sorts a consecutive bullet block alphabetically', () => {
    const src = '- charlie\n- alpha\n- bravo'
    const view = makeView(src, { anchor: 0 })
    expect(sortListBlock(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- alpha\n- bravo\n- charlie')
  })

  it('returns false when list block already sorted', () => {
    const view = makeView('- a\n- b\n- c', { anchor: 0 })
    expect(sortListBlock(view)).toBe(false)
  })

  it('returns false when not on a list line', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(sortListBlock(view)).toBe(false)
    expect(uniqueListBlock(view)).toBe(false)
    expect(shuffleListBlock(view)).toBe(false)
  })

  it('dedupes consecutive bullet items', () => {
    const src = '- a\n- a\n- b'
    const view = makeView(src, { anchor: 0 })
    expect(uniqueListBlock(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- a\n- b')
  })

  it('renumbers ordered list after sort', () => {
    const src = '1. zebra\n2. apple\n3. mango'
    const view = makeView(src, { anchor: 0 })
    sortListBlock(view)
    expect(view.state.doc.toString()).toBe('1. apple\n2. mango\n3. zebra')
  })

  it('shuffle returns true and preserves item set', () => {
    const items = ['1', '2', '3', '4', '5']
    const src = items.map((s) => `- ${s}`).join('\n')
    const view = makeView(src, { anchor: 0 })
    expect(shuffleListBlock(view)).toBe(true)
    const got = view.state.doc.toString().split('\n').map((l) => l.replace(/^- /, ''))
    expect(got.sort()).toEqual([...items].sort())
  })
})

describe('moveSectionToTop / moveSectionToBottom', () => {
  it('moves the current section to the top of the document', () => {
    const src = '# A\nbody-a\n\n# B\nbody-b\n\n# C\nbody-c'
    // place cursor on the # C heading line
    const view = makeView(src, { anchor: src.indexOf('# C') })
    expect(moveSectionToTop(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out.indexOf('# C')).toBeLessThan(out.indexOf('# A'))
    expect(out.indexOf('# A')).toBeLessThan(out.indexOf('# B'))
  })

  it('returns false when section already at top', () => {
    const src = '# A\nbody'
    const view = makeView(src, { anchor: 0 })
    expect(moveSectionToTop(view)).toBe(false)
  })

  it('moves to the bottom', () => {
    const src = '# A\nbody-a\n\n# B\nbody-b\n\n# C\nbody-c'
    const view = makeView(src, { anchor: src.indexOf('# A') })
    expect(moveSectionToBottom(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out.indexOf('# B')).toBeLessThan(out.indexOf('# C'))
    expect(out.indexOf('# C')).toBeLessThan(out.indexOf('# A'))
  })

  it('returns false when section is the last in the document', () => {
    const src = '# A\n# B'
    const view = makeView(src, { anchor: src.indexOf('# B') })
    expect(moveSectionToBottom(view)).toBe(false)
  })
})

describe('buildSectionLinkText', () => {
  it('produces a wikilink with section heading', () => {
    const src = '# A\n## Sub\nbody'
    const view = makeView(src, { anchor: src.indexOf('Sub') })
    expect(buildSectionLinkText(view, 'mydoc')).toBe('[[mydoc#Sub]]')
  })

  it('falls back to bare anchor when no documentBase', () => {
    const src = '# Heading\nbody'
    const view = makeView(src, { anchor: 0 })
    expect(buildSectionLinkText(view, '')).toBe('[[#Heading]]')
  })

  it('returns null when not under a heading', () => {
    const view = makeView('hello world', { anchor: 0 })
    expect(buildSectionLinkText(view, 'doc')).toBeNull()
  })
})

describe('toggleInlineMath', () => {
  it('wraps selection with $..$', () => {
    const view = makeView('e=mc2', { anchor: 0, head: 5 })
    expect(toggleInlineMath(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('$e=mc2$')
  })

  it('unwraps already-wrapped selection', () => {
    const view = makeView('$x$', { anchor: 0, head: 3 })
    toggleInlineMath(view)
    expect(view.state.doc.toString()).toBe('x')
  })

  it('inserts empty $$ when no selection', () => {
    const view = makeView('', { anchor: 0 })
    toggleInlineMath(view)
    expect(view.state.doc.toString()).toBe('$$')
  })
})

describe('insertHorizontalRuleAtCursor', () => {
  it('inserts --- below current line', () => {
    const view = makeView('hello', { anchor: 0 })
    insertHorizontalRuleAtCursor(view)
    expect(view.state.doc.toString()).toBe('hello\n\n---\n')
  })

  it('inserts at top when current line is empty', () => {
    const view = makeView('', { anchor: 0 })
    insertHorizontalRuleAtCursor(view)
    expect(view.state.doc.toString()).toBe('\n---\n')
  })
})

describe('bulletsToCsvText / csvToBulletsText', () => {
  it('flattens bullets into csv', () => {
    expect(bulletsToCsvText('- a\n- b\n- c')).toBe('a, b, c')
  })

  it('roundtrips', () => {
    expect(csvToBulletsText('a, b, c')).toBe('- a\n- b\n- c')
  })

  it('splits on semicolons too', () => {
    expect(csvToBulletsText('a;b;c')).toBe('- a\n- b\n- c')
  })
})

describe('bulletsToCsvLine / csvToBulletsLine', () => {
  it('collapses consecutive bullet block on cursor line into one csv line', () => {
    const view = makeView('- a\n- b\n- c', { anchor: 0 })
    expect(bulletsToCsvLine(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a, b, c')
  })

  it('explodes csv line into bullets', () => {
    const view = makeView('a, b, c', { anchor: 0 })
    expect(csvToBulletsLine(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- a\n- b\n- c')
  })

  it('returns false when not applicable', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(bulletsToCsvLine(view)).toBe(false)
    expect(csvToBulletsLine(view)).toBe(false)
  })
})

describe('hardWrapText', () => {
  it('wraps a long paragraph at width', () => {
    const text = 'the quick brown fox jumps over the lazy dog and keeps running'
    const wrapped = hardWrapText(text, 20)
    expect(wrapped.split('\n').every((l) => l.length <= 20)).toBe(true)
  })

  it('preserves paragraph separators', () => {
    const text = 'first paragraph here\n\nsecond paragraph here'
    const out = hardWrapText(text, 80)
    expect(out.split('\n\n').length).toBe(2)
  })

  it('passes through if everything fits', () => {
    expect(hardWrapText('short', 80)).toBe('short')
  })
})

describe('unwrapParagraphsText', () => {
  it('joins lines within a paragraph', () => {
    expect(unwrapParagraphsText('a\nb\nc')).toBe('a b c')
  })

  it('preserves blank-line separators between paragraphs', () => {
    expect(unwrapParagraphsText('a\nb\n\nc\nd')).toBe('a b\n\nc d')
  })

  it('leaves fenced code blocks alone (best-effort)', () => {
    const src = '```ts\nfoo()\nbar()\n```'
    expect(unwrapParagraphsText(src)).toBe(src)
  })
})

describe('toMarkdownHardBreaksText / fromMarkdownHardBreaksText', () => {
  it('adds two-space hard breaks within paragraphs', () => {
    const src = 'a\nb\nc'
    expect(toMarkdownHardBreaksText(src)).toBe('a  \nb  \nc')
  })

  it('round-trips: strip then add gives back', () => {
    const src = 'a\nb\nc'
    expect(fromMarkdownHardBreaksText(toMarkdownHardBreaksText(src))).toBe(src)
  })

  it('preserves paragraph boundary', () => {
    expect(toMarkdownHardBreaksText('a\nb\n\nc\nd')).toBe('a  \nb\n\nc  \nd')
  })
})

describe('hardWrapSelection / unwrapParagraphs / toMarkdownHardBreaks / fromMarkdownHardBreaks', () => {
  it('hardWrap applies to selection if present', () => {
    const text = 'aaa bbb ccc ddd eee fff ggg hhh'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(hardWrapSelection(10)(view)).toBe(true)
    const wrapped = view.state.doc.toString()
    expect(wrapped.split('\n').every((l) => l.length <= 10)).toBe(true)
  })

  it('unwrapParagraphs joins lines in selection', () => {
    const text = 'a\nb\nc'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(unwrapParagraphs(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a b c')
  })

  it('toMarkdownHardBreaks then fromMarkdownHardBreaks restores', () => {
    const text = 'a\nb\nc'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(toMarkdownHardBreaks(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a  \nb  \nc')
    expect(fromMarkdownHardBreaks(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a\nb\nc')
  })
})

describe('increaseQuoteLevel / decreaseQuoteLevel', () => {
  it('adds `> ` prefix to all selected lines', () => {
    const text = 'a\nb\nc'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(increaseQuoteLevel(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('> a\n> b\n> c')
  })

  it('nests quotes when applied twice', () => {
    const text = '> a\n> b'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(increaseQuoteLevel(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('> > a\n> > b')
  })

  it('strips one `> ` per line', () => {
    const text = '> > a\n> b\nc'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(decreaseQuoteLevel(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('> a\nb\nc')
  })
})

describe('sort variants', () => {
  it('sortSelectedLinesDesc sorts in reverse order', () => {
    const text = 'banana\napple\ncherry'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesDesc(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('cherry\nbanana\napple')
  })

  it('sortSelectedLinesByLengthAsc sorts shortest first', () => {
    const text = 'banana\nabc\nhippopotamus'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesByLengthAsc(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('abc\nbanana\nhippopotamus')
  })

  it('sortSelectedLinesByLengthDesc sorts longest first', () => {
    const text = 'abc\nhippopotamus\nbanana'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesByLengthDesc(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hippopotamus\nbanana\nabc')
  })

  it('sortSelectedLinesNumericAsc sorts by leading number', () => {
    const text = '10 apples\n2 oranges\n5 grapes'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesNumericAsc(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('2 oranges\n5 grapes\n10 apples')
  })

  it('sortSelectedLinesNumericDesc sorts by leading number desc', () => {
    const text = '2 a\n10 b\n5 c'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesNumericDesc(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('10 b\n5 c\n2 a')
  })

  it('sortSelectedLinesNatural handles "file1, file2, file10"', () => {
    const text = 'file10\nfile2\nfile1'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesNatural(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('file1\nfile2\nfile10')
  })

  it('returns false when already sorted', () => {
    const text = 'a\nb\nc'
    const view = makeView(text, { anchor: 0, head: text.length })
    expect(sortSelectedLinesNatural(view)).toBe(false)
  })
})

describe('exportOutlineToText', () => {
  it('outputs indented list of headings', () => {
    const md = '# A\n## B\n### C\n## D'
    expect(exportOutlineToText(md)).toBe('- A\n  - B\n    - C\n  - D')
  })

  it('skips headings inside fenced code', () => {
    const md = '# A\n```\n# fake heading\n```\n# B'
    expect(exportOutlineToText(md)).toBe('- A\n- B')
  })

  it('strips trailing # marks (closed atx headers)', () => {
    expect(exportOutlineToText('# Title #')).toBe('- Title')
  })
})

describe('trimSectionBlanks', () => {
  it('removes blank padding inside current section body', () => {
    const text = '# H\n\n\nhello\n\n\n# H2\nbye'
    const view = makeView(text, { anchor: 4 }) // inside H section
    expect(trimSectionBlanks(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('# H\nhello\n# H2\nbye')
  })

  it('returns false when no section', () => {
    const view = makeView('no heading here', { anchor: 0 })
    expect(trimSectionBlanks(view)).toBe(false)
  })
})

describe('insertAuthorAndDateFrontmatter', () => {
  it('creates a new frontmatter when none exists', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(insertAuthorAndDateFrontmatter(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out.startsWith('---\nauthor:')).toBe(true)
    expect(out).toMatch(/date: \d{4}-\d{2}-\d{2}/)
  })

  it('adds missing keys when frontmatter exists', () => {
    const text = '---\ntitle: foo\n---\nbody'
    const view = makeView(text, { anchor: 0 })
    expect(insertAuthorAndDateFrontmatter(view)).toBe(true)
    expect(view.state.doc.toString()).toMatch(/author:/)
    expect(view.state.doc.toString()).toMatch(/date: \d{4}-\d{2}-\d{2}/)
  })
})

describe('expandSelectionToParagraph', () => {
  it('extends to paragraph bounds', () => {
    const text = 'a\nb\nc\n\nd\ne'
    const view = makeView(text, { anchor: 2, head: 2 }) // on line 'b'
    expect(expandSelectionToParagraph(view)).toBe(true)
    const { from, to } = view.state.selection.main
    expect(view.state.doc.sliceString(from, to)).toBe('a\nb\nc')
  })

  it('returns false on blank line', () => {
    const text = 'a\n\nb'
    const view = makeView(text, { anchor: 2 }) // on the blank line
    expect(expandSelectionToParagraph(view)).toBe(false)
  })
})

describe('selectToNextHeading', () => {
  it('selects up to (but not including) next heading line', () => {
    const text = '# A\nfoo\nbar\n## B\nbaz'
    const view = makeView(text, { anchor: 4 }) // beginning of 'foo'
    expect(selectToNextHeading(view)).toBe(true)
    const { from, to } = view.state.selection.main
    expect(view.state.doc.sliceString(from, to)).toBe('foo\nbar')
  })

  it('extends to end of document when no further heading', () => {
    const text = '# A\nfoo\nbar'
    const view = makeView(text, { anchor: 4 })
    expect(selectToNextHeading(view)).toBe(true)
    expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe('foo\nbar')
  })
})



describe('duplicateCurrentSection', () => {
  it('clones current heading section right after itself', () => {
    const text = '# A\nbody\n# B\n'
    const view = makeView(text, { anchor: 4 }) // inside A
    expect(duplicateCurrentSection(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out.split('# A').length).toBe(3) // appears twice
  })

  it('returns false when no heading section', () => {
    const view = makeView('no heading', { anchor: 0 })
    expect(duplicateCurrentSection(view)).toBe(false)
  })
})

describe('getSelectionStats', () => {
  it('falls back to full document on empty selection', () => {
    const view = makeView('a b c', { anchor: 0 })
    expect(getSelectionStats(view).chars).toBe(5)
  })

  it('counts only selected range', () => {
    const view = makeView('hello world', { anchor: 0, head: 5 })
    const s = getSelectionStats(view)
    expect(s.chars).toBe(5)
    expect(s.words).toBe(1)
  })
})

describe('mergeAdjacentBlockquotesText', () => {
  it('merges quotes separated by single blank line', () => {
    expect(mergeAdjacentBlockquotesText('> a\n> b\n\n> c')).toBe('> a\n> b\n> c')
  })

  it('leaves non-quote separated by blank alone', () => {
    expect(mergeAdjacentBlockquotesText('hello\n\nworld')).toBe('hello\n\nworld')
  })
})

describe('mergeAdjacentBlockquotes (Command)', () => {
  it('applies on full document when no selection', () => {
    const view = makeView('> a\n\n> b', { anchor: 0 })
    expect(mergeAdjacentBlockquotes(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('> a\n> b')
  })
})

describe('lowercaseHeadingsText / uppercaseHeadingsText', () => {
  it('lowercases heading bodies preserving #', () => {
    expect(lowercaseHeadingsText('# HELLO\n## World\nbody')).toBe('# hello\n## world\nbody')
  })

  it('uppercases heading bodies', () => {
    expect(uppercaseHeadingsText('# hello\nbody')).toBe('# HELLO\nbody')
  })
})

describe('lowercaseAllHeadings / uppercaseAllHeadings (Commands)', () => {
  it('lowercases all headings in document', () => {
    const view = makeView('# HEY\nworld', { anchor: 0 })
    expect(lowercaseAllHeadings(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('# hey\nworld')
  })

  it('uppercases all headings in document', () => {
    const view = makeView('# hey\nworld', { anchor: 0 })
    expect(uppercaseAllHeadings(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('# HEY\nworld')
  })
})

describe('expandTemplateVariables', () => {
  const fixed = new Date('2026-03-14T15:30:00')
  it('replaces date/time/title with defaults', () => {
    const out = expandTemplateVariables('{{date}} {{time}} {{title}}', {
      now: fixed,
      title: 'Hello',
    })
    expect(out).toBe('2026-03-14 15:30 Hello')
  })

  it('supports custom date pattern', () => {
    expect(
      expandTemplateVariables('{{date:YY/MM/DD}}', { now: fixed }),
    ).toBe('26/03/14')
  })

  it('preserves {{cursor}} so callers can use it', () => {
    expect(expandTemplateVariables('a{{cursor}}b')).toBe('a{{cursor}}b')
  })

  it('falls back to ctx.vars and leaves unknown alone', () => {
    expect(
      expandTemplateVariables('{{name}} {{unknown}}', { vars: { name: 'Bob' } }),
    ).toBe('Bob {{unknown}}')
  })
})

describe('insertTemplateText', () => {
  it('inserts template and places cursor at {{cursor}}', () => {
    const view = makeView('start', { anchor: 5 })
    expect(insertTemplateText(view, 'hi {{cursor}} there')).toBe(true)
    expect(view.state.doc.toString()).toBe('starthi  there')
    expect(view.state.selection.main.from).toBe(8) // start(5) + 'hi ' = 8
  })

  it('inserts at end when no {{cursor}}', () => {
    const view = makeView('', { anchor: 0 })
    expect(insertTemplateText(view, 'hello')).toBe(true)
    expect(view.state.selection.main.from).toBe(5)
  })
})

describe('getNoteProperties / setNotePropertyText', () => {
  it('parses frontmatter into key/value map', () => {
    const src = '---\ntitle: foo\ntags: a, b\n---\nbody'
    const { keys, map } = getNoteProperties(src)
    expect(keys).toEqual(['title', 'tags'])
    expect(map.title).toBe('foo')
    expect(map.tags).toBe('a, b')
  })

  it('returns empty when no frontmatter', () => {
    expect(getNoteProperties('hello').keys).toEqual([])
  })

  it('adds a property if missing', () => {
    const src = '---\ntitle: foo\n---\nbody'
    const next = setNotePropertyText(src, 'date', '2026-06-06')
    expect(next).toContain('date: 2026-06-06')
  })

  it('updates an existing property', () => {
    const src = '---\ntitle: foo\n---\nbody'
    expect(setNotePropertyText(src, 'title', 'bar')).toContain('title: bar')
  })

  it('deletes when value is null', () => {
    const src = '---\ntitle: foo\ndate: x\n---\nbody'
    const next = setNotePropertyText(src, 'title', null)
    expect(next).not.toContain('title:')
    expect(next).toContain('date: x')
  })

  it('creates frontmatter when none exists', () => {
    const next = setNotePropertyText('hello', 'title', 'foo')
    expect(next.startsWith('---\ntitle: foo\n---\n')).toBe(true)
  })
})

describe('setNoteProperty (Command)', () => {
  it('updates frontmatter through view', () => {
    const view = makeView('---\ntitle: foo\n---\nbody', { anchor: 0 })
    expect(setNoteProperty(view, 'title', 'bar')).toBe(true)
    expect(view.state.doc.toString()).toContain('title: bar')
  })
})

describe('insertImageEmbedWithSize', () => {
  it('inserts ![[file|W]] at cursor', () => {
    const view = makeView('', { anchor: 0 })
    expect(insertImageEmbedWithSize('img.png', 300)(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('![[img.png|300]]')
  })
})

describe('convertImagesToWikilinksText / convertImageWikilinksToMarkdownText', () => {
  it('converts markdown image to wikilink', () => {
    expect(convertImagesToWikilinksText('![alt](x.png)')).toBe('![[x.png|alt]]')
  })

  it('leaves http urls alone', () => {
    expect(convertImagesToWikilinksText('![](https://x.com/a.png)')).toBe('![](https://x.com/a.png)')
  })

  it('converts wikilink image to markdown', () => {
    expect(convertImageWikilinksToMarkdownText('![[x.png]]')).toBe('![](x.png)')
  })

  it('drops size info on wikilink → markdown roundtrip', () => {
    expect(convertImageWikilinksToMarkdownText('![[x.png|200]]')).toBe('![](x.png)')
  })
})

describe('convertImagesToWikilinks / convertImageWikilinksToMarkdown (Commands)', () => {
  it('converts all images in document', () => {
    const view = makeView('![a](x.png)\n![b](y.jpg)', { anchor: 0 })
    expect(convertImagesToWikilinks(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('![[x.png|a]]\n![[y.jpg|b]]')
  })

  it('reverse converts all', () => {
    const view = makeView('![[x.png]]\n![[y.jpg|200]]', { anchor: 0 })
    expect(convertImageWikilinksToMarkdown(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('![](x.png)\n![](y.jpg)')
  })
})

import {
  surroundSelection,
  pasteUrlAsLink,
  cleanupZeroWidthCharsText,
  cleanupZeroWidthChars,
  normalizeUnicodeNFC,
  normalizeUnicodeNFD,
  toggleHighlight,
  transformToSentenceCaseText,
  transformToSentenceCase,
} from './commands'

describe('surroundSelection', () => {
  it('wraps selection with provided strings', () => {
    const view = makeView('hello', { anchor: 0, head: 5 })
    expect(surroundSelection('<', '>')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<hello>')
  })

  it('inserts pair and places cursor in middle on empty selection', () => {
    const view = makeView('', { anchor: 0 })
    expect(surroundSelection('(', ')')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('()')
    expect(view.state.selection.main.from).toBe(1)
  })
})

describe('pasteUrlAsLink', () => {
  it('wraps selection as [text](url)', () => {
    const view = makeView('hello world', { anchor: 0, head: 5 })
    expect(pasteUrlAsLink('https://x.com')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('[hello](https://x.com) world')
  })

  it('inserts <url> when no selection', () => {
    const view = makeView('', { anchor: 0 })
    expect(pasteUrlAsLink('https://x.com')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<https://x.com>')
  })
})

describe('cleanupZeroWidthChars', () => {
  it('removes ZWSP / ZWJ / ZWNJ / BOM', () => {
    const dirty = 'a​b‌c‍d﻿e'
    expect(cleanupZeroWidthCharsText(dirty)).toBe('abcde')
  })

  it('Command applies on selection or full doc', () => {
    const view = makeView('a​b', { anchor: 0 })
    expect(cleanupZeroWidthChars(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('ab')
  })
})

describe('normalizeUnicodeNFC / NFD', () => {
  it('NFC merges combining characters', () => {
    const view = makeView('é', { anchor: 0 }) // e + combining acute
    expect(normalizeUnicodeNFC(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('é') // é precomposed
  })

  it('NFD decomposes precomposed', () => {
    const view = makeView('é', { anchor: 0 })
    expect(normalizeUnicodeNFD(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('é')
  })
})

describe('toggleHighlight', () => {
  it('wraps selection with ==', () => {
    const view = makeView('abc', { anchor: 0, head: 3 })
    expect(toggleHighlight(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('==abc==')
  })

  it('unwraps highlighted selection', () => {
    const view = makeView('==abc==', { anchor: 0, head: 7 })
    expect(toggleHighlight(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('abc')
  })

  it('inserts empty pair on no selection', () => {
    const view = makeView('', { anchor: 0 })
    expect(toggleHighlight(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('====')
    expect(view.state.selection.main.from).toBe(2)
  })
})

describe('transformToSentenceCase', () => {
  it('lowercases all then capitalises first', () => {
    expect(transformToSentenceCaseText('HELLO WORLD')).toBe('Hello world')
  })

  it('Command leaves identical text alone', () => {
    const view = makeView('Hello world', { anchor: 0, head: 11 })
    expect(transformToSentenceCase(view)).toBe(false)
  })

  it('Command applies on selection', () => {
    const view = makeView('foo BAR baz', { anchor: 0, head: 11 })
    expect(transformToSentenceCase(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Foo bar baz')
  })
})

import {
  extractAllLinks,
  extractAllImages,
  unwrapAllLinksToPlainText,
  unwrapAllLinksToPlainTextText,
  surroundCurrentLineWith,
  insertSeparatorComment,
  insertLinksSummary,
  insertImagesSummary,
} from './commands'

describe('extractAllLinks / extractAllImages', () => {
  it('extracts plain markdown links', () => {
    const src = '[a](https://a.com) text [b](https://b.com)'
    expect(extractAllLinks(src)).toEqual([
      { label: 'a', url: 'https://a.com' },
      { label: 'b', url: 'https://b.com' },
    ])
  })

  it('skips images in link list', () => {
    expect(extractAllLinks('![](x.png) [t](y.com)')).toEqual([
      { label: 't', url: 'y.com' },
    ])
  })

  it('extracts images', () => {
    expect(extractAllImages('![cat](cat.png) ![](nameless.jpg)')).toEqual([
      { label: 'cat', url: 'cat.png' },
      { label: '', url: 'nameless.jpg' },
    ])
  })

  it('skips fenced code', () => {
    const src = '```\n[fake](x)\n```\n[real](y)'
    expect(extractAllLinks(src)).toEqual([{ label: 'real', url: 'y' }])
  })
})

describe('unwrapAllLinksToPlainText', () => {
  it('strips link syntax leaving text', () => {
    expect(unwrapAllLinksToPlainTextText('hi [there](url) friend')).toBe('hi there friend')
  })

  it('leaves images alone', () => {
    expect(unwrapAllLinksToPlainTextText('![](x.png) [a](b)')).toBe('![](x.png) a')
  })

  it('Command applies to whole document', () => {
    const view = makeView('[x](y)', { anchor: 0 })
    expect(unwrapAllLinksToPlainText(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('x')
  })
})

describe('surroundCurrentLineWith', () => {
  it('wraps the cursor line on both sides', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(surroundCurrentLineWith('< ', ' >')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('< hello >')
  })
})

describe('insertSeparatorComment', () => {
  it('inserts an html comment line after current line', () => {
    const view = makeView('hello', { anchor: 0 })
    expect(insertSeparatorComment('section')(view)).toBe(true)
    const out = view.state.doc.toString()
    expect(out).toContain('hello\n<!-- ===== section ===== -->\n')
  })

  it('falls back to === when no title', () => {
    const view = makeView('', { anchor: 0 })
    expect(insertSeparatorComment()(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('===')
  })
})

describe('insertLinksSummary / insertImagesSummary', () => {
  it('adds Links section', () => {
    const view = makeView('## Title\n[a](url1)\n', { anchor: 0 })
    expect(insertLinksSummary(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('## Links')
    expect(view.state.doc.toString()).toContain('a — url1')
  })

  it('returns false when no links', () => {
    const view = makeView('plain text', { anchor: 0 })
    expect(insertLinksSummary(view)).toBe(false)
  })

  it('adds Images section', () => {
    const view = makeView('![alt](x.png)', { anchor: 0 })
    expect(insertImagesSummary(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('## Images')
  })
})

import {
  jumpToNextCodeBlock,
  jumpToPrevCodeBlock,
  jumpToNextTask,
  jumpToPrevTask,
  tableToBulletsText,
  bulletsToTableText,
  tableToBulletList,
  bulletListToTable,
} from './commands'

describe('jumpToNextCodeBlock / jumpToPrevCodeBlock', () => {
  it('jumps forward to next fence', () => {
    const doc = 'a\n```ts\ncode\n```\nb\n```js\nx\n```\n'
    const view = makeView(doc, { anchor: 0 })
    expect(jumpToNextCodeBlock(view)).toBe(true)
    const headLine = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(headLine).toBe(2)
  })

  it('jumps to second block on second call', () => {
    const doc = 'a\n```ts\ncode\n```\nb\n```js\nx\n```\n'
    const view = makeView(doc, { anchor: 0 })
    jumpToNextCodeBlock(view)
    expect(jumpToNextCodeBlock(view)).toBe(true)
    const headLine = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(headLine).toBe(6)
  })

  it('returns false with no fences', () => {
    const view = makeView('plain text\nmore', { anchor: 0 })
    expect(jumpToNextCodeBlock(view)).toBe(false)
    expect(jumpToPrevCodeBlock(view)).toBe(false)
  })

  it('jumps backward to previous fence', () => {
    const doc = 'a\n```ts\ncode\n```\nb\n```js\nx\n```\n'
    const view = makeView(doc, { anchor: doc.length - 1 })
    expect(jumpToPrevCodeBlock(view)).toBe(true)
    const headLine = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(headLine).toBe(6)
  })
})

describe('jumpToNextTask / jumpToPrevTask', () => {
  it('jumps to next task line', () => {
    const doc = 'note\n- [ ] one\nmore\n- [x] two\n'
    const view = makeView(doc, { anchor: 0 })
    expect(jumpToNextTask(view)).toBe(true)
    const headLine = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(headLine).toBe(2)
  })

  it('returns false when no tasks ahead', () => {
    const view = makeView('plain\nstill plain', { anchor: 0 })
    expect(jumpToNextTask(view)).toBe(false)
  })

  it('jumps backward', () => {
    const doc = '- [ ] a\nmid\n- [ ] b\nend\n'
    const view = makeView(doc, { anchor: doc.length - 1 })
    expect(jumpToPrevTask(view)).toBe(true)
    const headLine = view.state.doc.lineAt(view.state.selection.main.head).number
    expect(headLine).toBe(3)
  })
})

describe('tableToBulletsText', () => {
  it('converts a simple table', () => {
    const src = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
    const out = tableToBulletsText(src)
    expect(out).toContain('- A: 1, B: 2')
    expect(out).toContain('- A: 3, B: 4')
  })

  it('passes through non-table lines', () => {
    const src = 'pre\n| A | B |\n| --- | --- |\n| 1 | 2 |\npost'
    const out = tableToBulletsText(src)
    expect(out.startsWith('pre')).toBe(true)
    expect(out.trimEnd().endsWith('post')).toBe(true)
  })

  it('tableToBulletList Command applies to whole doc', () => {
    const view = makeView('| A | B |\n| --- | --- |\n| 1 | 2 |\n', { anchor: 0 })
    expect(tableToBulletList(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('- A: 1, B: 2')
  })
})

describe('bulletsToTableText', () => {
  it('uses first row as header', () => {
    const src = '- A | B | C\n- 1 | 2 | 3\n- 4 | 5 | 6'
    const out = bulletsToTableText(src)
    expect(out).toContain('| A | B | C |')
    expect(out).toContain('| --- | --- | --- |')
    expect(out).toContain('| 1 | 2 | 3 |')
    expect(out).toContain('| 4 | 5 | 6 |')
  })

  it('passes through plain lines', () => {
    const src = 'note\n- A | B\n- 1 | 2\nend'
    const out = bulletsToTableText(src)
    expect(out.startsWith('note')).toBe(true)
    expect(out.trimEnd().endsWith('end')).toBe(true)
  })

  it('bulletListToTable Command applies to whole doc', () => {
    const view = makeView('- A | B\n- 1 | 2', { anchor: 0 })
    expect(bulletListToTable(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('| A | B |')
  })
})

import {
  toggleFrontmatterKeyText,
  renameFrontmatterKeyText,
  sortFrontmatterValuesText,
  slugifyHeadingsText,
  headingSlug,
  stripMarkdownToPlainText,
} from './commands'

describe('toggleFrontmatterKeyText', () => {
  it('adds a missing key', () => {
    const out = toggleFrontmatterKeyText('---\ntitle: a\n---\nbody', 'pin', 'true')
    expect(out).toContain('pin: true')
  })

  it('removes an existing key', () => {
    const src = '---\ntitle: a\npin: true\n---\nbody'
    const out = toggleFrontmatterKeyText(src, 'pin')
    expect(out).not.toContain('pin: true')
    expect(out).toContain('title: a')
  })

  it('creates frontmatter if missing', () => {
    const out = toggleFrontmatterKeyText('body only', 'pin', 'true')
    expect(out.startsWith('---\npin: true\n---')).toBe(true)
  })
})

describe('renameFrontmatterKeyText', () => {
  it('renames a key', () => {
    const src = '---\ntitle: a\ntag: x\n---\nbody'
    const out = renameFrontmatterKeyText(src, 'tag', 'tags')
    expect(out).toContain('tags: x')
    expect(out).not.toContain('tag: x')
  })

  it('returns source unchanged when key missing', () => {
    const src = '---\ntitle: a\n---\nbody'
    expect(renameFrontmatterKeyText(src, 'missing', 'other')).toBe(src)
  })
})

describe('sortFrontmatterValuesText', () => {
  it('sorts inline list', () => {
    const src = '---\ntags: [b, a, c]\n---\nbody'
    expect(sortFrontmatterValuesText(src, 'tags')).toContain('tags: [a, b, c]')
  })

  it('sorts dash list', () => {
    const src = '---\ntags:\n  - c\n  - a\n  - b\n---\nbody'
    const out = sortFrontmatterValuesText(src, 'tags')
    expect(out.indexOf('- a')).toBeLessThan(out.indexOf('- b'))
    expect(out.indexOf('- b')).toBeLessThan(out.indexOf('- c'))
  })
})

describe('headingSlug + slugifyHeadingsText', () => {
  it('slugifies basic text', () => {
    expect(headingSlug('Hello World')).toBe('hello-world')
  })

  it('appends ^slug to plain headings', () => {
    const src = '# Hello World\nbody'
    expect(slugifyHeadingsText(src)).toContain('# Hello World ^hello-world')
  })

  it('skips headings already with slug', () => {
    const src = '# A ^a\n# B'
    const out = slugifyHeadingsText(src)
    expect(out).toContain('# A ^a')
    expect(out).toContain('# B ^b')
  })

  it('deduplicates slugs', () => {
    const out = slugifyHeadingsText('# Same\n# Same')
    expect(out).toContain('^same')
    expect(out).toContain('^same-2')
  })
})

describe('stripMarkdownToPlainText', () => {
  it('strips headings, lists, bold, links', () => {
    const src = '# Title\n- **bold** item [a](b) `code`'
    const out = stripMarkdownToPlainText(src)
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).not.toContain('`')
    expect(out).toContain('bold')
    expect(out).toContain('a')
  })

  it('extracts wikilink display text', () => {
    expect(stripMarkdownToPlainText('[[foo|Foo Bar]]')).toBe('Foo Bar')
    expect(stripMarkdownToPlainText('[[foo]]')).toBe('foo')
  })
})

import {
  selectionToBulletListText,
  selectionToOrderedListText,
  selectionToTaskListText,
  unwrapCommentText,
  wrapSelectionAsComment,
  selectionToBulletList,
} from './commands'

describe('selectionToBulletListText / selectionToOrderedListText / selectionToTaskListText', () => {
  it('bullet list from lines', () => {
    expect(selectionToBulletListText('one\ntwo')).toBe('- one\n- two')
  })

  it('ordered list numbers', () => {
    expect(selectionToOrderedListText('a\nb\nc')).toBe('1. a\n2. b\n3. c')
  })

  it('task list adds checkbox', () => {
    expect(selectionToTaskListText('a\nb')).toBe('- [ ] a\n- [ ] b')
  })

  it('selectionToBulletList Command applies to whole doc', () => {
    const view = makeView('one\ntwo', { anchor: 0 })
    expect(selectionToBulletList(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- one\n- two')
  })
})

describe('unwrapCommentText', () => {
  it('removes %% wrappers', () => {
    expect(unwrapCommentText('a %%note%% b')).toBe('a note b')
  })
})

describe('wrapSelectionAsComment', () => {
  it('wraps selection in %% %%', () => {
    const view = makeView('abc', { anchor: 0, head: 3 })
    expect(wrapSelectionAsComment(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('%%abc%%')
  })

  it('inserts %%comment%% at cursor when empty', () => {
    const view = makeView('xy', { anchor: 1 })
    expect(wrapSelectionAsComment(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('x%%comment%%y')
  })
})

import {
  swapAdjacentParagraphs,
  getDocumentSizeBytes,
  formatBytes,
  convertOrderedToBulletText,
  convertBulletToOrderedText,
  addBlockquoteAuthor,
  stripBlockquoteAuthor,
} from './commands'

describe('swapAdjacentParagraphs', () => {
  it('swaps with next paragraph', () => {
    const doc = 'p1 line1\np1 line2\n\np2 line1\n'
    const view = makeView(doc, { anchor: 0 })
    expect(swapAdjacentParagraphs('down')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('p2 line1\n\np1 line1\np1 line2\n')
  })

  it('returns false on last paragraph', () => {
    const view = makeView('only', { anchor: 0 })
    expect(swapAdjacentParagraphs('down')(view)).toBe(false)
  })

  it('swaps with previous', () => {
    const doc = 'p1\n\np2'
    const view = makeView(doc, { anchor: 4 })
    expect(swapAdjacentParagraphs('up')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('p2\n\np1')
  })
})

describe('formatBytes / getDocumentSizeBytes', () => {
  it('formatBytes basics', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  it('counts utf-8 bytes', () => {
    const view = makeView(`a${String.fromCodePoint(0x4f60)}`, { anchor: 0 })
    expect(getDocumentSizeBytes(view.state)).toBe(4)                    
  })
})

describe('convertOrderedToBulletText / convertBulletToOrderedText', () => {
  it('ordered → bullet', () => {
    expect(convertOrderedToBulletText('1. a\n2. b\n3. c')).toBe('- a\n- b\n- c')
  })

  it('bullet → ordered', () => {
    expect(convertBulletToOrderedText('- a\n- b\n- c')).toBe('1. a\n2. b\n3. c')
  })

  it('bullet → ordered resets across blank line', () => {
    expect(convertBulletToOrderedText('- a\n- b\n\n- c')).toBe('1. a\n2. b\n\n1. c')
  })

  it('preserves indent in ol → ul', () => {
    expect(convertOrderedToBulletText('  1. inner')).toBe('  - inner')
  })
})

describe('addBlockquoteAuthor / stripBlockquoteAuthor', () => {
  it('appends author', () => {
    const view = makeView('> "hi"', { anchor: 0 })
    expect(addBlockquoteAuthor('A')(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('> "hi" — A')
  })

  it('is idempotent', () => {
    const view = makeView('> "hi" — A', { anchor: 0 })
    expect(addBlockquoteAuthor('A')(view)).toBe(false)
  })

  it('strips author', () => {
    const view = makeView('> "hi" — A', { anchor: 0 })
    expect(stripBlockquoteAuthor(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('> "hi"')
  })

  it('strip returns false when not in blockquote', () => {
    const view = makeView('plain', { anchor: 0 })
    expect(stripBlockquoteAuthor(view)).toBe(false)
  })
})

import {
  fillEmptyImageAltText,
  expandShortLinksToReferenceText,
  inlineReferenceLinksText,
  emojiBulletText,
  numberLinesText,
  unnumberLinesText,
} from './commands'

describe('fillEmptyImageAltText', () => {
  it('fills alt from basename', () => {
    expect(fillEmptyImageAltText('![](images/sun_set.png)')).toBe('![sun set](images/sun_set.png)')
  })

  it('keeps non-empty alt', () => {
    expect(fillEmptyImageAltText('![already](x.png)')).toBe('![already](x.png)')
  })

  it('preserves title', () => {
    expect(fillEmptyImageAltText('![](x.png "T")')).toBe('![x](x.png "T")')
  })
})

describe('expandShortLinksToReferenceText / inlineReferenceLinksText', () => {
  it('converts inline → reference and dedupes', () => {
    const src = 'see [a](u1) and [b](u1) and [c](u2)'
    const out = expandShortLinksToReferenceText(src)
    expect(out).toContain('[a][1]')
    expect(out).toContain('[b][1]')
    expect(out).toContain('[c][2]')
    expect(out).toContain('[1]: u1')
    expect(out).toContain('[2]: u2')
  })

  it('skips images', () => {
    const out = expandShortLinksToReferenceText('![img](u)')
    expect(out).toBe('![img](u)')
  })

  it('round-trips back to inline', () => {
    const refForm = 'see [a][1]\n\n[1]: https://x'
    expect(inlineReferenceLinksText(refForm).trim()).toBe('see [a](https://x)')
  })
})

describe('emojiBulletText', () => {
  it('prefixes bullets with emoji', () => {
    const out = emojiBulletText('- a\n- b')
    expect(out.split('\n')[0]).toMatch(/^.\sa$/u)
    expect(out.split('\n')[1]).toMatch(/^.\sb$/u)
  })

  it('skips non-bullets', () => {
    expect(emojiBulletText('plain')).toBe('plain')
  })
})

describe('numberLinesText / unnumberLinesText', () => {
  it('numbers lines with right padding', () => {
    const out = numberLinesText('a\nb\nc')
    expect(out).toBe('1: a\n2: b\n3: c')
  })

  it('pads width', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    const out = numberLinesText(lines)
    expect(out.split('\n')[0].startsWith(' 1:')).toBe(true)
    expect(out.split('\n')[9].startsWith('10:')).toBe(true)
  })

  it('removes numbers', () => {
    expect(unnumberLinesText(' 1: a\n10: b')).toBe('a\nb')
  })
})

import {
  cleanTrackingParamsText,
  decodeUrlsInLinksText,
  renameHeadingInDocText,
  dedupFrontmatterTagsText,
  wikilinkToFootnoteText,
  stripAllImagesText,
} from './commands'

describe('cleanTrackingParamsText', () => {
  it('strips utm_*', () => {
    const out = cleanTrackingParamsText('[link](https://x?utm_source=a&q=1)')
    expect(out).toContain('?q=1')
    expect(out).not.toContain('utm_source')
  })

  it('strips gclid, fbclid', () => {
    const out = cleanTrackingParamsText('[a](https://x?gclid=1&fbclid=2)')
    expect(out).toBe('[a](https://x)')
  })

  it('preserves fragment', () => {
    const out = cleanTrackingParamsText('[a](https://x?utm_source=a#frag)')
    expect(out).toBe('[a](https://x#frag)')
  })

  it('handles bare <url>', () => {
    expect(cleanTrackingParamsText('<https://x?utm_source=a>')).toBe('<https://x>')
  })
})

describe('decodeUrlsInLinksText', () => {
  it('decodes %20', () => {
    expect(decodeUrlsInLinksText('[a](path%20to/x)')).toBe('[a](path to/x)')
  })
})

describe('renameHeadingInDocText', () => {
  it('renames heading and wikilink anchor', () => {
    const src = '# Old\nsee [[note#Old]] and [[#Old]]'
    const out = renameHeadingInDocText(src, 'Old', 'New')
    expect(out).toContain('# New')
    expect(out).toContain('[[note#New]]')
    expect(out).toContain('[[#New]]')
  })
})

describe('dedupFrontmatterTagsText', () => {
  it('dedups inline form preserving order', () => {
    const src = '---\ntags: [a, b, a, c]\n---'
    expect(dedupFrontmatterTagsText(src)).toContain('tags: [a, b, c]')
  })

  it('dedups dash form', () => {
    const src = '---\ntags:\n  - a\n  - b\n  - a\n---'
    const out = dedupFrontmatterTagsText(src)
    expect(out.match(/- a/g)?.length).toBe(1)
  })
})

describe('wikilinkToFootnoteText', () => {
  it('converts wikilinks to footnotes', () => {
    const out = wikilinkToFootnoteText('see [[Apple]] and [[Pear|Pearbox]]')
    expect(out).toContain('Apple[^wl1]')
    expect(out).toContain('Pearbox[^wl2]')
    expect(out).toContain('[^wl1]: [[Apple]]')
    expect(out).toContain('[^wl2]: [[Pear]]')
  })
})

describe('stripAllImagesText', () => {
  it('strips markdown images', () => {
    expect(stripAllImagesText('a ![x](u.png) b')).toBe('a  b')
  })

  it('strips wikilink embed', () => {
    expect(stripAllImagesText('a ![[f.png]] b')).toBe('a  b')
  })
})

import {
  wrapCodeBlockLang,
  convertSetextHeadingsText,
  convertAtxToSetextText,
  wrapEachLineWithText,
  pruneEmptyHeadingsText,
  annotateCodeLineNumbersText,
} from './commands'

describe('wrapCodeBlockLang', () => {
  it('changes lang of enclosing fence', () => {
    const doc = '```\nx\n```\n'
    const view = makeView(doc, { anchor: 5 }) // inside code
    expect(wrapCodeBlockLang('ts')(view)).toBe(true)
    expect(view.state.doc.toString().startsWith('```ts\n')).toBe(true)
  })

  it('returns false outside fence', () => {
    const view = makeView('not in fence', { anchor: 0 })
    expect(wrapCodeBlockLang('ts')(view)).toBe(false)
  })
})

describe('convertSetextHeadingsText / convertAtxToSetextText', () => {
  it('setext H1 → ATX', () => {
    expect(convertSetextHeadingsText('Title\n=====')).toBe('# Title')
  })

  it('setext H2 → ATX', () => {
    expect(convertSetextHeadingsText('Sub\n----')).toBe('## Sub')
  })

  it('ATX H1 → setext', () => {
    expect(convertAtxToSetextText('# Title')).toBe('Title\n=====')
  })

  it('ATX H2 → setext', () => {
    expect(convertAtxToSetextText('## Sub')).toBe('Sub\n---')
  })
})

describe('wrapEachLineWithText', () => {
  it('wraps non-empty lines', () => {
    expect(wrapEachLineWithText('a\nb\n\nc', '> ', '!')).toBe('> a!\n> b!\n\n> c!')
  })
})

describe('pruneEmptyHeadingsText', () => {
  it('removes empty headings', () => {
    const src = '# Has Body\nbody\n## Empty\n## Another Empty\n# Tail\ntail body'
    const out = pruneEmptyHeadingsText(src)
    expect(out).toContain('# Has Body')
    expect(out).toContain('# Tail')
    expect(out).not.toContain('## Empty')
    expect(out).not.toContain('## Another Empty')
  })
})

describe('annotateCodeLineNumbersText', () => {
  it('annotates ts code block', () => {
    const src = '```ts\nfoo()\nbar()\n```'
    const out = annotateCodeLineNumbersText(src)
    expect(out).toContain('foo() // 1')
    expect(out).toContain('bar() // 2')
  })

  it('skips unknown languages', () => {
    const src = '```mermaid\nsome\n```'
    expect(annotateCodeLineNumbersText(src)).toBe(src)
  })
})

import {
  renameTagInDocText,
  extractAllTagsList,
  boldLargeNumbersText,
  joinSentencesText,
  convertSingleQuoteToDoubleText,
  convertDoubleQuoteToSingleText,
  insertTaskProgressSummary,
} from './commands'

describe('renameTagInDocText', () => {
  it('renames tags', () => {
    expect(renameTagInDocText('see #old here', 'old', 'new')).toBe('see #new here')
  })

  it('skips inside fence', () => {
    const src = '```\n#old\n```\n#old after'
    const out = renameTagInDocText(src, 'old', 'new')
    expect(out).toContain('```\n#old\n```')
    expect(out).toContain('#new after')
  })

  it('does not rename if old is partial match', () => {
    expect(renameTagInDocText('#oldish', 'old', 'new')).toBe('#oldish')
  })
})

describe('extractAllTagsList', () => {
  it('returns sorted unique tags', () => {
    const src = 'see #b and #a and #b'
    expect(extractAllTagsList(src)).toEqual(['a', 'b'])
  })

  it('skips fence and inline code', () => {
    const src = '```\n#code\n```\n#real `#inline`'
    expect(extractAllTagsList(src)).toEqual(['real'])
  })
})

describe('boldLargeNumbersText', () => {
  it('bolds 4+ digit numbers', () => {
    expect(boldLargeNumbersText('total 12345 items')).toBe('total **12345** items')
  })

  it('skips short numbers', () => {
    expect(boldLargeNumbersText('only 999 here')).toBe('only 999 here')
  })

  it('skips inside fence', () => {
    expect(boldLargeNumbersText('```\n1234\n```')).toBe('```\n1234\n```')
  })
})

describe('insertTaskProgressSummary', () => {
  it('inserts summary at top', () => {
    const doc = '- [x] done\n- [ ] todo\n- [ ] todo2\n'
    const view = makeView(doc, { anchor: 0 })
    expect(insertTaskProgressSummary(view)).toBe(true)
    expect(view.state.doc.toString()).toMatch(/^\*\*Tasks: 1\/3 done \(33%\)\*\*/)
  })

  it('no-op when no tasks', () => {
    const view = makeView('plain', { anchor: 0 })
    expect(insertTaskProgressSummary(view)).toBe(false)
  })
})

describe('joinSentencesText', () => {
  it('joins line-broken paragraph', () => {
    expect(joinSentencesText('a\nb\nc')).toBe('a b c')
  })

  it('preserves paragraph boundaries', () => {
    expect(joinSentencesText('a\nb\n\nc\nd')).toBe('a b\n\nc d')
  })
})

describe('quote swaps', () => {
  it('single → double', () => {
    expect(convertSingleQuoteToDoubleText(`he said 'hi'`)).toBe(`he said "hi"`)
  })

  it('double → single', () => {
    expect(convertDoubleQuoteToSingleText(`he said "hi"`)).toBe(`he said 'hi'`)
  })
})

import {
  expandWikilinkAliasesText,
  collapseWikilinkAliasesText,
  addDaysToDateLinksText,
  sortListByWordCountText,
  splitOnSemicolonsText,
  insertCurrentWeekRange,
} from './commands'

describe('expand/collapseWikilinkAliasesText', () => {
  it('expands plain wikilink to alias form', () => {
    expect(expandWikilinkAliasesText('[[foo]]')).toBe('[[foo|foo]]')
  })

  it('collapses identity aliases', () => {
    expect(collapseWikilinkAliasesText('[[foo|foo]]')).toBe('[[foo]]')
  })

  it('does not collapse different aliases', () => {
    expect(collapseWikilinkAliasesText('[[foo|bar]]')).toBe('[[foo|bar]]')
  })
})

describe('addDaysToDateLinksText', () => {
  it('shifts wikilink dates +1', () => {
    expect(addDaysToDateLinksText('see [[2026-06-07]]', 1)).toBe('see [[2026-06-08]]')
  })

  it('shifts -1 across month boundary', () => {
    expect(addDaysToDateLinksText('[[2026-07-01]]', -1)).toBe('[[2026-06-30]]')
  })

  it('preserves alias', () => {
    expect(addDaysToDateLinksText('[[2026-06-07|today]]', 1)).toBe('[[2026-06-08|today]]')
  })
})

describe('insertCurrentWeekRange', () => {
  it('inserts range with two ISO dates', () => {
    const view = makeView('', { anchor: 0 })
    expect(insertCurrentWeekRange(view)).toBe(true)
    expect(view.state.doc.toString()).toMatch(/^\[\[\d{4}-\d{2}-\d{2}\]\] → \[\[\d{4}-\d{2}-\d{2}\]\]$/)
  })
})

describe('sortListByWordCountText', () => {
  it('sorts ascending', () => {
    const src = '- two words here\n- one\n- three little words'
    const out = sortListByWordCountText(src, 'asc')
    expect(out).toBe('- one\n- two words here\n- three little words')
  })

  it('sorts descending', () => {
    const src = '- a\n- b c\n- d'
    const out = sortListByWordCountText(src, 'desc')
    expect(out).toBe('- b c\n- a\n- d')
  })

  it('does not cross non-list lines', () => {
    const src = '- a\nmid\n- bb cc'
    expect(sortListByWordCountText(src, 'asc')).toBe(src)
  })
})

describe('splitOnSemicolonsText', () => {
  it('splits a plain line', () => {
    expect(splitOnSemicolonsText('a; b; c')).toBe('a\nb\nc')
  })

  it('preserves bullet prefix', () => {
    expect(splitOnSemicolonsText('- a; b; c')).toBe('- a\n- b\n- c')
  })

  it('leaves line unchanged when no semicolon', () => {
    expect(splitOnSemicolonsText('plain')).toBe('plain')
  })
})

import {
  normalizeListIndentationText,
  formatCitation,
  buildImageGridHtml,
  escapeMarkdownInPlainText,
  splitAfterCjkPunctuationText,
  extractAllUrls,
  insertAllUrlsList,
} from './commands'

describe('normalizeListIndentationText', () => {
  it('shrinks 4-space indent to 2-space', () => {
    expect(normalizeListIndentationText('- a\n    - b')).toBe('- a\n  - b')
  })

  it('shrinks 8-space indent to 4-space', () => {
    expect(normalizeListIndentationText('- a\n        - b')).toBe('- a\n    - b')
  })

  it('leaves non-list lines alone', () => {
    expect(normalizeListIndentationText('  plain')).toBe('  plain')
  })
})

describe('formatCitation', () => {
  it('renders author year title with url', () => {
    expect(formatCitation({ author: 'A', year: 2023, title: 'T', url: 'https://x' })).toBe('A (2023) [T](https://x)')
  })

  it('renders without url uses italic', () => {
    expect(formatCitation({ author: 'A', title: 'T' })).toBe('A *T*')
  })

  it('returns empty when nothing', () => {
    expect(formatCitation({ title: '' })).toBe('')
  })
})

describe('buildImageGridHtml', () => {
  it('builds 3-column grid', () => {
    const out = buildImageGridHtml(['u1', 'u2', 'u3'], 3)
    expect(out).toContain('grid-template-columns:repeat(3,1fr)')
    expect(out).toContain('<img src="u1"')
    expect(out).toContain('<img src="u3"')
  })

  it('returns empty for empty input', () => {
    expect(buildImageGridHtml([])).toBe('')
  })
})

describe('escapeMarkdownInPlainText', () => {
  it('escapes special chars', () => {
    expect(escapeMarkdownInPlainText('a *b* _c_ #d')).toBe('a \\*b\\* \\_c\\_ \\#d')
  })
})

describe('splitAfterCjkPunctuationText', () => {
  it('splits after an ideographic full stop', () => {
    const source = String.fromCodePoint(0x4f60, 0x597d, 0x3002, 0x4e16, 0x754c, 0x3002)
    const expected = String.fromCodePoint(0x4f60, 0x597d, 0x3002, 0x0a, 0x4e16, 0x754c, 0x3002, 0x0a)
    expect(splitAfterCjkPunctuationText(source)).toBe(expected)
  })

  it('splits after English sentence', () => {
    expect(splitAfterCjkPunctuationText('First. Second')).toBe('First.\nSecond')
  })
})

describe('extractAllUrls', () => {
  it('finds urls in links, bare, raw forms', () => {
    const src = '[a](https://x) and <https://y> and bare https://z.'
    const out = extractAllUrls(src)
    expect(out).toContain('https://x')
    expect(out).toContain('https://y')
    expect(out).toContain('https://z')
  })
})

describe('insertAllUrlsList', () => {
  it('appends a URLs section', () => {
    const view = makeView('see [a](https://x)', { anchor: 0 })
    expect(insertAllUrlsList(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('## URLs')
    expect(view.state.doc.toString()).toContain('- <https://x>')
  })

  it('no-op when no urls', () => {
    const view = makeView('plain', { anchor: 0 })
    expect(insertAllUrlsList(view)).toBe(false)
  })
})

import {
  formatTimestamp,
  convertHHMMToMinutes,
  sumTimeEntries,
  formatMinutesAsHm,
  incrementOrderedListByText,
  prependLinesWithText,
  appendLinesWithText,
  insertTimestampAtCursor,
  insertTimeEntriesTotal,
} from './commands'

describe('formatTimestamp', () => {
  it('iso', () => {
    expect(formatTimestamp(new Date('2026-06-07T12:34:56Z'), 'iso')).toBe('2026-06-07T12:34:56.000Z')
  })

  it('datetime in local form', () => {
    const d = new Date(2026, 5, 7, 12, 34, 56)
    expect(formatTimestamp(d, 'datetime')).toBe('2026-06-07 12:34:56')
  })

  it('time', () => {
    const d = new Date(2026, 5, 7, 9, 5)
    expect(formatTimestamp(d, 'time')).toBe('09:05')
  })

  it('epoch is a number', () => {
    const s = formatTimestamp(new Date(0), 'epoch')
    expect(/^\d+$/.test(s)).toBe(true)
  })
})

describe('insertTimestampAtCursor', () => {
  it('inserts at cursor', () => {
    const view = makeView('a|b', { anchor: 1 })
    expect(insertTimestampAtCursor('time')(view)).toBe(true)
    expect(view.state.doc.toString()).toMatch(/^a\d{2}:\d{2}\|b$/)
  })
})

describe('convertHHMMToMinutes / sumTimeEntries / formatMinutesAsHm', () => {
  it('hh:mm parses', () => {
    expect(convertHHMMToMinutes('1:30')).toBe(90)
    expect(convertHHMMToMinutes('0:45')).toBe(45)
  })

  it('Nh Nm parses', () => {
    expect(convertHHMMToMinutes('2h 15m')).toBe(135)
    expect(convertHHMMToMinutes('30m')).toBe(30)
  })

  it('sums durations across doc', () => {
    const src = 'work 1:30 and 2h 15m and 5m\nnothing here'
    expect(sumTimeEntries(src)).toBe(90 + 135 + 5)
  })

  it('formats minutes', () => {
    expect(formatMinutesAsHm(135)).toBe('2h 15m')
    expect(formatMinutesAsHm(30)).toBe('30m')
  })
})

describe('insertTimeEntriesTotal', () => {
  it('appends total when durations exist', () => {
    const view = makeView('- 1:30 task\n- 30m other', { anchor: 0 })
    expect(insertTimeEntriesTotal(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('Total: 2h 0m (120 min)')
  })

  it('no-op when none', () => {
    const view = makeView('plain', { anchor: 0 })
    expect(insertTimeEntriesTotal(view)).toBe(false)
  })
})

describe('incrementOrderedListByText', () => {
  it('shifts numbers +5', () => {
    expect(incrementOrderedListByText('1. a\n2. b\n3. c', 5)).toBe('6. a\n7. b\n8. c')
  })

  it('shifts -1 leaves zero alone (no clamp)', () => {
    expect(incrementOrderedListByText('5. a', -3)).toBe('2. a')
  })
})

describe('prependLinesWithText / appendLinesWithText', () => {
  it('prepends', () => {
    expect(prependLinesWithText('a\nb', '> ')).toBe('> a\n> b')
  })

  it('appends', () => {
    expect(appendLinesWithText('a\nb', '!')).toBe('a!\nb!')
  })

  it('skips empty lines', () => {
    expect(prependLinesWithText('a\n\nb', '> ')).toBe('> a\n\n> b')
  })
})

describe('safeEvalArithmetic', () => {
  it('evaluates basic arithmetic', () => {
    expect(safeEvalArithmetic('1+2')).toBe(3)
    expect(safeEvalArithmetic('3 * (4 + 5)')).toBe(27)
    expect(safeEvalArithmetic('10 / 4')).toBe(2.5)
  })

  it('rejects identifiers / functions', () => {
    expect(safeEvalArithmetic('Math.PI')).toBeNull()
    expect(safeEvalArithmetic('alert(1)')).toBeNull()
    expect(safeEvalArithmetic('1+a')).toBeNull()
  })

  it('returns null for empty', () => {
    expect(safeEvalArithmetic('')).toBeNull()
  })
})

describe('evalInlineMathInLinesText', () => {
  it('evaluates "= expr" suffix', () => {
    expect(evalInlineMathInLinesText('hours = 2 + 3')).toBe('hours = 2 + 3 = 5')
  })

  it('skips already-evaluated lines', () => {
    expect(evalInlineMathInLinesText('total = 1 + 2 = 3')).toBe('total = 1 + 2 = 3')
  })

  it('leaves non-math lines alone', () => {
    expect(evalInlineMathInLinesText('plain text')).toBe('plain text')
  })
})

describe('cycleTaskStateChar', () => {
  it('cycles space → /', () => {
    expect(cycleTaskStateChar(' ')).toBe('/')
  })

  it('cycles / → x', () => {
    expect(cycleTaskStateChar('/')).toBe('x')
  })

  it('cycles x → -', () => {
    expect(cycleTaskStateChar('x')).toBe('-')
  })

  it('cycles > back to space', () => {
    expect(cycleTaskStateChar('>')).toBe(' ')
  })

  it('unknown char goes to space', () => {
    expect(cycleTaskStateChar('?')).toBe(' ')
  })
})

describe('archiveDoneTasksText', () => {
  it('moves done to a new Archived section', () => {
    const out = archiveDoneTasksText('- [ ] a\n- [x] b\n- [ ] c')
    expect(out).toContain('## Archived')
    expect(out).toContain('- [x] b')
    expect(out.indexOf('## Archived')).toBeLessThan(out.indexOf('- [x] b'))
  })

  it('appends to existing Archived section', () => {
    const src = 'Open:\n- [ ] a\n\n## Archived\n- [x] old'
    const out = archiveDoneTasksText(src + '\n- [x] fresh')
    expect(out).toMatch(/## Archived\n- [^\n]*\n- /)
  })

  it('no-op when nothing done', () => {
    expect(archiveDoneTasksText('- [ ] only')).toBe('- [ ] only')
  })
})

describe('strip markdown helpers', () => {
  it('strips highlights', () => {
    expect(stripHighlightsText('==red== plain')).toBe('red plain')
  })

  it('strips bold', () => {
    expect(stripBoldText('a **bold** b')).toBe('a bold b')
  })

  it('strips italic asterisk', () => {
    expect(stripItalicText('a *it* b')).toBe('a it b')
  })

  it('strips italic underscore', () => {
    expect(stripItalicText('a _it_ b')).toBe('a it b')
  })

  it('does not strip across bold', () => {
    expect(stripItalicText('**bold** _it_')).toBe('**bold** it')
  })
})

describe('ensureUpdatedFrontmatterText', () => {
  const NOW = new Date('2026-06-07T00:00:00Z')

  it('adds frontmatter if missing', () => {
    const out = ensureUpdatedFrontmatterText('# Title', NOW)
    expect(out.startsWith('---\nupdated: 2026-06-07\n---\n')).toBe(true)
  })

  it('replaces existing updated field', () => {
    const src = '---\nupdated: 2020-01-01\nfoo: bar\n---\nbody'
    const out = ensureUpdatedFrontmatterText(src, NOW)
    expect(out).toContain('updated: 2026-06-07')
    expect(out).not.toContain('2020-01-01')
  })

  it('appends updated to existing frontmatter without it', () => {
    const src = '---\nfoo: bar\n---\nbody'
    const out = ensureUpdatedFrontmatterText(src, NOW)
    expect(out).toContain('foo: bar')
    expect(out).toContain('updated: 2026-06-07')
  })
})

describe('hardBreaksToSpaceText', () => {
  it('adds 2 trailing spaces to non-empty lines', () => {
    expect(hardBreaksToSpaceText('a\nb\n\nc')).toBe('a  \nb  \n\nc  ')
  })
})

describe('bulletPairsToDefinitionListText', () => {
  it('converts term + indented bullet to def list', () => {
    const src = '- Foo\n  - This is foo\n- Bar\n  - This is bar'
    expect(bulletPairsToDefinitionListText(src)).toBe('Foo\n: This is foo\nBar\n: This is bar')
  })

  it('leaves non-pairs alone', () => {
    expect(bulletPairsToDefinitionListText('- only')).toBe('- only')
  })
})

describe('sortFrontmatterAliasesText', () => {
  it('sorts inline array', () => {
    const src = '---\ntitle: x\naliases: [zebra, apple, mango]\n---\nbody'
    expect(sortFrontmatterAliasesText(src)).toContain('aliases: [apple, mango, zebra]')
  })

  it('sorts block list', () => {
    const src = '---\naliases:\n  - zebra\n  - apple\n---\nbody'
    const out = sortFrontmatterAliasesText(src)
    expect(out).toMatch(/aliases:\n\s*- apple\n\s*- zebra/)
  })

  it('no-op without frontmatter', () => {
    expect(sortFrontmatterAliasesText('plain')).toBe('plain')
  })
})

describe('blockquoteLinesText / unblockquoteLinesText', () => {
  it('quotes each line', () => {
    expect(blockquoteLinesText('a\nb')).toBe('> a\n> b')
  })

  it('preserves blank lines as bare >', () => {
    expect(blockquoteLinesText('a\n\nb')).toBe('> a\n>\n> b')
  })

  it('unquotes once', () => {
    expect(unblockquoteLinesText('> a\n> b')).toBe('a\nb')
  })

  it('unquote idempotent on non-quote', () => {
    expect(unblockquoteLinesText('a\nb')).toBe('a\nb')
  })
})

describe('injectTopTOCText', () => {
  it('inserts TOC after H1', () => {
    const src = '# Title\n## A\n## B\ntext'
    const out = injectTopTOCText(src)
    expect(out).toContain('## Table of Contents')
    expect(out).toContain('- [[#A]]')
    expect(out).toContain('- [[#B]]')
    expect(out.indexOf('# Title')).toBeLessThan(out.indexOf('## Table of Contents'))
  })

  it('replaces existing TOC block', () => {
    const src = '# Title\n## Table of Contents\n- [[#Old]]\n## A\n## B'
    const out = injectTopTOCText(src)
    expect(out).not.toContain('- [[#Old]]')
    expect(out).toContain('- [[#A]]')
  })

  it('no-op without h1', () => {
    expect(injectTopTOCText('## only h2')).toBe('## only h2')
  })
})

describe('renameInlineDataviewFieldText', () => {
  it('renames at line start', () => {
    expect(renameInlineDataviewFieldText('status:: open', 'status', 'state'))
      .toBe('state:: open')
  })

  it('renames inside brackets', () => {
    expect(renameInlineDataviewFieldText('[status:: open]', 'status', 'state'))
      .toBe('[state:: open]')
  })

  it('does not rename partial match', () => {
    expect(renameInlineDataviewFieldText('mystatus:: open', 'status', 'state'))
      .toBe('mystatus:: open')
  })

  it('returns original when keys match', () => {
    expect(renameInlineDataviewFieldText('x', 'a', 'a')).toBe('x')
  })
})

describe('numberCodeBlockLinesText', () => {
  it('numbers lines inside first fence', () => {
    const src = 'before\n```\na\nb\nc\n```\nafter'
    const out = numberCodeBlockLinesText(src)
    expect(out).toContain('1 | a')
    expect(out).toContain('2 | b')
    expect(out).toContain('3 | c')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('no-op without fence', () => {
    expect(numberCodeBlockLinesText('plain')).toBe('plain')
  })
})

describe('stripHtmlCommentsText', () => {
  it('removes <!-- … -->', () => {
    expect(stripHtmlCommentsText('a<!-- x -->b')).toBe('ab')
  })

  it('handles multi-line', () => {
    expect(stripHtmlCommentsText('a<!--\nmulti\n-->b')).toBe('ab')
  })
})

describe('purgeDoneTasksUnderTasksHeadingText', () => {
  it('removes only done tasks under Tasks heading', () => {
    const src = '# Doc\n## Tasks\n- [ ] a\n- [x] b\n- [ ] c\n## Other\n- [x] keep'
    const out = purgeDoneTasksUnderTasksHeadingText(src)
    expect(out).not.toContain('- [x] b')
    expect(out).toContain('- [ ] a')
    expect(out).toContain('- [ ] c')
    expect(out).toContain('- [x] keep')
  })

  it('no-op without Tasks heading', () => {
    expect(purgeDoneTasksUnderTasksHeadingText('- [x] a')).toBe('- [x] a')
  })
})

describe('swapLinkTextWithUrlText', () => {
  it('swaps text and url', () => {
    expect(swapLinkTextWithUrlText('see [docs](https://x.com)')).toBe('see [https://x.com](docs)')
  })

  it('does not touch images', () => {
    expect(swapLinkTextWithUrlText('![alt](img.png)')).toBe('![alt](img.png)')
  })

  it('keeps title', () => {
    expect(swapLinkTextWithUrlText('[t](u "T")')).toBe('[u](t "T")')
  })
})

describe('frontmatterFieldInlineToBlockText', () => {
  it('expands inline to block', () => {
    const src = '---\ntags: [a, b, c]\n---\nbody'
    expect(frontmatterFieldInlineToBlockText(src, 'tags')).toMatch(/tags:\n {2}- a\n {2}- b\n {2}- c/)
  })

  it('no-op if field missing', () => {
    expect(frontmatterFieldInlineToBlockText('---\n---\nbody', 'tags')).toBe('---\n---\nbody')
  })
})

describe('frontmatterFieldBlockToInlineText', () => {
  it('compresses block to inline', () => {
    const src = '---\ntags:\n  - a\n  - b\n---\nbody'
    const out = frontmatterFieldBlockToInlineText(src, 'tags')
    expect(out).toContain('tags: [a, b]')
  })

  it('no-op if not block-form', () => {
    expect(frontmatterFieldBlockToInlineText('---\ntags: [a]\n---', 'tags'))
      .toBe('---\ntags: [a]\n---')
  })
})

describe('stampLinesWithDateText', () => {
  it('stamps non-empty lines', () => {
    expect(stampLinesWithDateText('a\n\nb', '2026-06-07'))
      .toBe('[2026-06-07] a\n\n[2026-06-07] b')
  })

  it('skips fenced code', () => {
    expect(stampLinesWithDateText('a\n```\ncode\n```\nb', '2026-06-07'))
      .toBe('[2026-06-07] a\n```\ncode\n```\n[2026-06-07] b')
  })
})

describe('unwrapDetailsBlocksText', () => {
  it('converts to heading + body', () => {
    const src = '<details><summary>X</summary>\nbody\n</details>'
    expect(unwrapDetailsBlocksText(src)).toBe('### X\nbody')
  })

  it('no-op without details', () => {
    expect(unwrapDetailsBlocksText('plain')).toBe('plain')
  })
})

describe('markdown lint fixers', () => {
  it('collapses excessive blank lines', () => {
    expect(collapseExcessiveBlankLinesText('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('single-spaces after list marker', () => {
    expect(singleSpaceAfterListMarkerText('-   item')).toBe('- item')
    expect(singleSpaceAfterListMarkerText('1.  item')).toBe('1. item')
  })

  it('list space respects fence', () => {
    expect(singleSpaceAfterListMarkerText('```\n-   keep\n```\n-   fix'))
      .toBe('```\n-   keep\n```\n- fix')
  })

  it('inserts blank around headings', () => {
    expect(ensureBlankAroundHeadingsText('text\n# H\nbody')).toBe('text\n\n# H\n\nbody')
  })

  it('does not over-insert blank lines', () => {
    expect(ensureBlankAroundHeadingsText('text\n\n# H\n\nbody')).toBe('text\n\n# H\n\nbody')
  })

  it('ensures single trailing newline', () => {
    expect(ensureSingleTrailingNewlineText('x')).toBe('x\n')
    expect(ensureSingleTrailingNewlineText('x\n\n\n')).toBe('x\n')
  })

  it('sorts frontmatter top keys', () => {
    const src = '---\nz: 1\na: 2\nm: 3\n---\nbody'
    const out = sortFrontmatterTopKeysText(src)
    const order = (s: string) => out.indexOf(s)
    expect(order('a:')).toBeLessThan(order('m:'))
    expect(order('m:')).toBeLessThan(order('z:'))
  })

  it('normalizes emphasis to asterisk', () => {
    expect(normalizeEmphasisToAsteriskText('_word_')).toBe('*word*')
  })

  it('normalizes emphasis does not affect __strong__', () => {
    expect(normalizeEmphasisToAsteriskText('__strong__')).toBe('__strong__')
  })

  it('normalizes emphasis to underscore', () => {
    expect(normalizeEmphasisToUnderscoreText('*word*')).toBe('_word_')
  })

  it('normalizes strong to asterisk', () => {
    expect(normalizeStrongToAsteriskText('__bold__')).toBe('**bold**')
  })

  it('trims trailing whitespace but preserves hard break', () => {
    expect(trimTrailingNonBreakWhitespaceText('x   \ny  \nz')).toBe('x\ny  \nz')
  })
})

describe('flattenNestedListsText', () => {
  it('flattens indents and normalizes marker', () => {
    const src = '- a\n  * b\n    + c\n      - d'
    expect(flattenNestedListsText(src)).toBe('- a\n- b\n- c\n- d')
  })

  it('respects fence', () => {
    expect(flattenNestedListsText('```\n  - x\n```\n  - y'))
      .toBe('```\n  - x\n```\n- y')
  })
})

describe('indent/dedent lines by spaces', () => {
  it('indents by 2 spaces', () => {
    expect(indentLinesBySpacesText('a\nb', 2)).toBe('  a\n  b')
  })

  it('skips empty lines on indent', () => {
    expect(indentLinesBySpacesText('a\n\nb', 2)).toBe('  a\n\n  b')
  })

  it('dedents up to N', () => {
    expect(dedentLinesBySpacesText('    a\n  b\nc', 2)).toBe('  a\nb\nc')
  })

  it('no-op when n=0', () => {
    expect(indentLinesBySpacesText('x', 0)).toBe('x')
    expect(dedentLinesBySpacesText('  x', 0)).toBe('  x')
  })
})

describe('plainUrlToAutolinkText', () => {
  it('wraps plain url', () => {
    expect(plainUrlToAutolinkText('see https://x.com please'))
      .toBe('see <https://x.com> please')
  })

  it('skips already-linked url', () => {
    expect(plainUrlToAutolinkText('[x](https://x.com)'))
      .toBe('[x](https://x.com)')
  })

  it('skips already <>-wrapped', () => {
    expect(plainUrlToAutolinkText('<https://x.com>'))
      .toBe('<https://x.com>')
  })

  it('skips inside code', () => {
    expect(plainUrlToAutolinkText('`https://x.com`'))
      .toBe('`https://x.com`')
  })
})

describe('applyFrontmatterTemplateText', () => {
  it('inserts new frontmatter', () => {
    const out = applyFrontmatterTemplateText('body', { tags: '[]', status: 'open' })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('tags: []')
    expect(out).toContain('status: open')
  })

  it('does not overwrite existing keys', () => {
    const src = '---\nstatus: closed\n---\nbody'
    const out = applyFrontmatterTemplateText(src, { status: 'open', tags: '[]' })
    expect(out).toContain('status: closed')
    expect(out).toContain('tags: []')
  })

  it('no-op when all keys present', () => {
    const src = '---\nstatus: open\n---\nbody'
    expect(applyFrontmatterTemplateText(src, { status: 'closed' })).toBe(src)
  })
})

describe('shiftHeadingsUp/DownOneLevelText', () => {
  it('up moves H2 → H1', () => {
    expect(shiftHeadingsUpOneLevelText('## A')).toBe('# A')
  })

  it('up leaves H1 alone', () => {
    expect(shiftHeadingsUpOneLevelText('# A')).toBe('# A')
  })

  it('down moves H1 → H2', () => {
    expect(shiftHeadingsDownOneLevelText('# A')).toBe('## A')
  })

  it('down leaves H6 alone', () => {
    expect(shiftHeadingsDownOneLevelText('###### A')).toBe('###### A')
  })

  it('skips fence', () => {
    expect(shiftHeadingsUpOneLevelText('```\n## x\n```')).toBe('```\n## x\n```')
  })
})

describe('brTagsToHardBreaksText', () => {
  it('replaces trailing <br>', () => {
    expect(brTagsToHardBreaksText('hello<br>')).toBe('hello  ')
  })

  it('only at end of line', () => {
    expect(brTagsToHardBreaksText('a<br>b')).toBe('a<br>b')
  })
})

describe('convertLinksToFootnotesText', () => {
  it('moves urls to footnote defs', () => {
    const src = 'Click [here](https://x.com) for info.'
    const out = convertLinksToFootnotesText(src)
    expect(out).toMatch(/Click here\[\^1\] for info\./)
    expect(out).toMatch(/\[\^1\]: https:\/\/x\.com/)
  })

  it('skips when no links', () => {
    expect(convertLinksToFootnotesText('plain')).toBe('plain')
  })

  it('reserves existing ids', () => {
    const src = 'See [a](u) and [^1].\n\n[^1]: existing'
    const out = convertLinksToFootnotesText(src)
    expect(out).toMatch(/\[\^2\]: u/)
  })
})

describe('headingsToOutlineText', () => {
  it('produces indented bullets by depth', () => {
    const src = '# A\n## B\n### C'
    expect(headingsToOutlineText(src)).toBe('- A\n  - B\n    - C')
  })

  it('leaves non-headings alone', () => {
    expect(headingsToOutlineText('text')).toBe('text')
  })

  it('skips fence', () => {
    expect(headingsToOutlineText('```\n# x\n```')).toBe('```\n# x\n```')
  })
})

describe('surroundEachLineWithTagText', () => {
  it('wraps non-empty lines', () => {
    expect(surroundEachLineWithTagText('a\nb', 'p')).toBe('<p>a</p>\n<p>b</p>')
  })

  it('preserves indentation', () => {
    expect(surroundEachLineWithTagText('  x', 'em')).toBe('  <em>x</em>')
  })

  it('skips empty lines', () => {
    expect(surroundEachLineWithTagText('a\n\nb', 'p')).toBe('<p>a</p>\n\n<p>b</p>')
  })
})

describe('htmlSupToCaretText / htmlSubToTildeText', () => {
  it('converts sup', () => {
    expect(htmlSupToCaretText('x<sup>2</sup>')).toBe('x^2')
  })

  it('converts sub', () => {
    expect(htmlSubToTildeText('H<sub>2</sub>O')).toBe('H~2~O')
  })
})

describe('calloutsToHeadingsText', () => {
  it('converts callout to H2 with title', () => {
    expect(calloutsToHeadingsText('> [!note] Hello')).toBe('## Hello')
  })

  it('uses type when no title', () => {
    expect(calloutsToHeadingsText('> [!warning]')).toBe('## warning')
  })

  it('leaves regular quote alone', () => {
    expect(calloutsToHeadingsText('> just a quote')).toBe('> just a quote')
  })
})

describe('countHashtagsText', () => {
  it('counts unique tags', () => {
    const c = countHashtagsText('text #a and #b and #a again')
    expect(c.get('a')).toBe(2)
    expect(c.get('b')).toBe(1)
  })

  it('does not count heading markers', () => {
    const c = countHashtagsText('## Heading\n#tag')
    expect(c.get('tag')).toBe(1)
    expect(c.get('Heading')).toBeUndefined()
  })

  it('skips fenced code', () => {
    const c = countHashtagsText('```\n#code\n```\n#real')
    expect(c.get('code')).toBeUndefined()
    expect(c.get('real')).toBe(1)
  })
})

describe('collectAllLinkTargets', () => {
  it('collects wikilink, image, mdlink', () => {
    const src = 'See [[Foo]] and ![alt](img.png) and [text](https://x.com)'
    const got = collectAllLinkTargets(src)
    expect(got.find((t) => t.kind === 'wikilink' && t.target === 'Foo')).toBeTruthy()
    expect(got.find((t) => t.kind === 'image' && t.target === 'img.png')).toBeTruthy()
    expect(got.find((t) => t.kind === 'mdlink' && t.target === 'https://x.com')).toBeTruthy()
  })

  it('returns empty when no links', () => {
    expect(collectAllLinkTargets('plain')).toEqual([])
  })
})

describe('findDuplicateHeadings', () => {
  it('finds duplicate heading text', () => {
    const src = '# Intro\n## Detail\n## detail\n# Outro'
    const dup = findDuplicateHeadings(src)
    expect(dup.length).toBe(1)
    expect(dup[0].title).toBe('detail')
    expect(dup[0].lines).toEqual([2, 3])
  })

  it('no dups → empty', () => {
    expect(findDuplicateHeadings('# A\n# B')).toEqual([])
  })
})

describe('case all tags', () => {
  it('lowercases', () => {
    expect(lowercaseAllTagsText('a #FooBar end')).toBe('a #foobar end')
  })

  it('uppercases', () => {
    expect(uppercaseAllTagsText('a #foobar end')).toBe('a #FOOBAR end')
  })

  it('does not touch heading hash', () => {
    expect(lowercaseAllTagsText('# Heading X')).toBe('# Heading X')
  })
})

describe('paragraphsToHtmlBreaksText', () => {
  it('replaces blank-line paragraph break with <br><br>', () => {
    expect(paragraphsToHtmlBreaksText('a\n\nb')).toBe('a<br><br>b')
  })

  it('does not affect single-line break', () => {
    expect(paragraphsToHtmlBreaksText('a\nb')).toBe('a\nb')
  })
})

describe('convertMarkdownImagesToWikiEmbedsText', () => {
  it('converts with alt', () => {
    expect(convertMarkdownImagesToWikiEmbedsText('![a](x.png)')).toBe('![[x.png|a]]')
  })

  it('converts without alt', () => {
    expect(convertMarkdownImagesToWikiEmbedsText('![](x.png)')).toBe('![[x.png]]')
  })
})

describe('convertDocumentEmbedToMdImageText', () => {
  it('converts with alt', () => {
    expect(convertDocumentEmbedToMdImageText('![[x.png|a]]')).toBe('![a](x.png)')
  })

  it('converts without alt', () => {
    expect(convertDocumentEmbedToMdImageText('![[x.png]]')).toBe('![](x.png)')
  })
})

describe('setImageWidthForEmbedsText', () => {
  it('adds width when missing', () => {
    expect(setImageWidthForEmbedsText('![[x.png]]', 400)).toBe('![[x.png|400]]')
  })

  it('skips when width present', () => {
    expect(setImageWidthForEmbedsText('![[x.png|200]]', 400)).toBe('![[x.png|200]]')
  })
})

describe('injectHtmlAnchorsBeforeHeadingsText', () => {
  it('inserts anchor before heading', () => {
    const out = injectHtmlAnchorsBeforeHeadingsText('# My Title')
    expect(out).toBe('<a id="my-title"></a>\n# My Title')
  })

  it('skips fence', () => {
    expect(injectHtmlAnchorsBeforeHeadingsText('```\n# x\n```'))
      .toBe('```\n# x\n```')
  })
})

describe('abbreviateLinksToHostText', () => {
  it('replaces label with host', () => {
    const out = abbreviateLinksToHostText('[click](https://www.example.com/a/b)')
    expect(out).toBe('[example.com](https://www.example.com/a/b)')
  })

  it('skips invalid url', () => {
    expect(abbreviateLinksToHostText('[x](not a url)')).toBe('[x](not a url)')
  })
})

describe('relativeMdLinksToWikilinksText', () => {
  it('converts relative no-ext path', () => {
    expect(relativeMdLinksToWikilinksText('[Foo](Bar)')).toBe('[[Bar|Foo]]')
  })

  it('keeps url with scheme', () => {
    expect(relativeMdLinksToWikilinksText('[x](https://x.com)'))
      .toBe('[x](https://x.com)')
  })

  it('keeps file with extension', () => {
    expect(relativeMdLinksToWikilinksText('[x](file.pdf)'))
      .toBe('[x](file.pdf)')
  })
})

describe('defaultCalloutTitlesText', () => {
  it('adds title from type', () => {
    expect(defaultCalloutTitlesText('> [!note]')).toBe('> [!note] Note')
  })

  it('leaves existing title', () => {
    expect(defaultCalloutTitlesText('> [!warning] Heads up'))
      .toBe('> [!warning] Heads up')
  })
})

import {
  fillImageAltFromFilenameText,
  normalizeHorizontalRulesText,
  numberHeadingsText,
  prefixTasksWithEmojiInRange,
  sortSectionsByHeadingText,
  tabsToListText,
  tidyLinkTextFromSlugText,
  unnumberHeadingsText,
} from './commands'

describe('numberHeadingsText', () => {
  it('numbers nested headings', () => {
    const src = '# A\n## B\n## C\n### D\n# E'
    const out = numberHeadingsText(src)
    expect(out).toBe('# 1 A\n## 1.1 B\n## 1.2 C\n### 1.2.1 D\n# 2 E')
  })

  it('replaces existing numbers', () => {
    expect(numberHeadingsText('# 9 A')).toBe('# 1 A')
  })

  it('skips fence', () => {
    expect(numberHeadingsText('```\n# X\n```\n# A'))
      .toBe('```\n# X\n```\n# 1 A')
  })
})

describe('unnumberHeadingsText', () => {
  it('removes numbering', () => {
    expect(unnumberHeadingsText('## 1.2 Foo')).toBe('## Foo')
  })

  it('handles deep numbering', () => {
    expect(unnumberHeadingsText('### 1.2.3. Bar')).toBe('### Bar')
  })
})

describe('tidyLinkTextFromSlugText', () => {
  it('derives text from path tail', () => {
    expect(tidyLinkTextFromSlugText('[https://example.com/a/hello-world](https://example.com/a/hello-world)'))
      .toBe('[hello world](https://example.com/a/hello-world)')
  })

  it('strips html extension', () => {
    expect(tidyLinkTextFromSlugText('[https://x.com/p/foo.html](https://x.com/p/foo.html)'))
      .toBe('[foo](https://x.com/p/foo.html)')
  })

  it('leaves links with distinct text', () => {
    expect(tidyLinkTextFromSlugText('[click](https://x.com/y)'))
      .toBe('[click](https://x.com/y)')
  })
})

describe('prefixTasksWithEmojiInRange', () => {
  it('prefixes tasks in range', () => {
    const src = '## H\n- [ ] a\n- [x] b\n- not task'
    const out = prefixTasksWithEmojiInRange(src, 1, 3, '🔥')
    expect(out).toBe('## H\n- [ ] 🔥 a\n- [x] 🔥 b\n- not task')
  })

  it('skips already-prefixed', () => {
    const out = prefixTasksWithEmojiInRange('- [ ] 🔥 a', 0, 0, '🔥')
    expect(out).toBe('- [ ] 🔥 a')
  })
})

describe('normalizeHorizontalRulesText', () => {
  it('rewrites hr style', () => {
    const src = '***\n___'
    expect(normalizeHorizontalRulesText(src, '---')).toBe('---\n---')
  })

  it('keeps text untouched', () => {
    expect(normalizeHorizontalRulesText('hi\n---\nbye', '***'))
      .toBe('hi\n***\nbye')
  })

  it('skips fence', () => {
    expect(normalizeHorizontalRulesText('```\n---\n```', '***'))
      .toBe('```\n---\n```')
  })
})

describe('fillImageAltFromFilenameText', () => {
  it('fills empty alt', () => {
    expect(fillImageAltFromFilenameText('![](images/my-pic.png)'))
      .toBe('![my pic](images/my-pic.png)')
  })

  it('keeps non-empty alt', () => {
    expect(fillImageAltFromFilenameText('![alt](pic.png)'))
      .toBe('![alt](pic.png)')
  })
})

describe('sortSectionsByHeadingText', () => {
  it('sorts H2 blocks alphabetically', () => {
    const src = '# top\n## Banana\nb body\n## Apple\na body'
    const out = sortSectionsByHeadingText(src)
    expect(out).toBe('# top\n## Apple\na body\n## Banana\nb body')
  })

  it('preserves prefix before first H2', () => {
    const src = 'intro\n## B\nb\n## A\na'
    expect(sortSectionsByHeadingText(src)).toBe('intro\n## A\na\n## B\nb')
  })
})

describe('tabsToListText', () => {
  it('converts single-tab leading', () => {
    expect(tabsToListText('\titem')).toBe('- item')
  })

  it('handles depth 2', () => {
    expect(tabsToListText('\t\titem')).toBe('  - item')
  })

  it('skips fence', () => {
    expect(tabsToListText('```\n\titem\n```'))
      .toBe('```\n\titem\n```')
  })
})

import {
  listSummaryText,
  paragraphsToQuotesText,
  stripFrontmatterText,
  unquoteParagraphsText,
  wikilinksToFootnotesInRange,
} from './commands'

describe('paragraphsToQuotesText', () => {
  it('quotes plain paragraphs', () => {
    expect(paragraphsToQuotesText('hello\nworld')).toBe('> hello\n> world')
  })

  it('keeps headings and lists', () => {
    expect(paragraphsToQuotesText('# title\n- item'))
      .toBe('# title\n- item')
  })

  it('keeps blank lines', () => {
    expect(paragraphsToQuotesText('a\n\nb')).toBe('> a\n\n> b')
  })
})

describe('unquoteParagraphsText', () => {
  it('strips one quote level', () => {
    expect(unquoteParagraphsText('> hi')).toBe('hi')
  })

  it('keeps nested quote', () => {
    expect(unquoteParagraphsText('>> nested')).toBe('> nested')
  })

  it('passes through non-quotes', () => {
    expect(unquoteParagraphsText('plain')).toBe('plain')
  })
})

describe('listSummaryText', () => {
  it('appends count line', () => {
    const out = listSummaryText('- a\n- b\n- c')
    expect(out).toBe('- a\n- b\n- c\n\n3 items\n')
  })

  it('counts ordered too', () => {
    const out = listSummaryText('1. a\n2. b')
    expect(out).toBe('1. a\n2. b\n\n2 items\n')
  })

  it('no-op without lists', () => {
    expect(listSummaryText('hello')).toBe('hello')
  })
})

describe('stripFrontmatterText', () => {
  it('strips full frontmatter block', () => {
    expect(stripFrontmatterText('---\ntitle: x\n---\nbody'))
      .toBe('body')
  })

  it('returns unchanged when no frontmatter', () => {
    expect(stripFrontmatterText('body only')).toBe('body only')
  })
})

describe('wikilinksToFootnotesInRange', () => {
  it('rewrites wikilinks to footnotes', () => {
    const src = '## H\nuse [[A]] and [[B|alias]] here.'
    const out = wikilinksToFootnotesInRange(src, 0, src.length)
    expect(out).toContain('use A[^1] and alias[^2] here.')
    expect(out).toContain('[^1]: [[A]]')
    expect(out).toContain('[^2]: [[B]]')
  })

  it('no-op when no wikilinks', () => {
    expect(wikilinksToFootnotesInRange('plain', 0, 5)).toBe('plain')
  })
})

import {
  calloutHeaderToHeadingText,
  detectLangByHeuristic,
  extractTableColumnAsListText,
  filterListItemsText,
  inlineMathToBlockText,
  keepCheckedTasksOnlyText,
  removeInlineCodeBackticksText,
  singleLineFenceToInlineText,
  transformTableCellsText,
} from './commands'

describe('extractTableColumnAsListText', () => {
  it('extracts first column', () => {
    const src = '| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |'
    const out = extractTableColumnAsListText(src, 1)
    expect(out).toContain('- 1\n- 3')
  })

  it('no-op without table', () => {
    expect(extractTableColumnAsListText('plain', 1)).toBe('plain')
  })
})

describe('transformTableCellsText', () => {
  it('uppercases body cells', () => {
    const src = '| a | b |\n| - | - |\n| hi | yo |'
    const out = transformTableCellsText(src, (x) => x.toUpperCase())
    expect(out).toContain('| HI | YO |')
  })
})

describe('filterListItemsText', () => {
  it('keeps only matching items', () => {
    const src = '- apple\n- banana\n- cherry'
    expect(filterListItemsText(src, 'an')).toBe('- banana')
  })

  it('returns source for empty keyword', () => {
    expect(filterListItemsText('- a', '')).toBe('- a')
  })
})

describe('keepCheckedTasksOnlyText', () => {
  it('drops unchecked tasks', () => {
    const src = '- [x] done\n- [ ] todo\n- normal'
    expect(keepCheckedTasksOnlyText(src)).toBe('- [x] done\n- normal')
  })
})

describe('removeInlineCodeBackticksText', () => {
  it('removes backticks', () => {
    expect(removeInlineCodeBackticksText('here is `code` here'))
      .toBe('here is code here')
  })
})

describe('singleLineFenceToInlineText', () => {
  it('downgrades to inline code', () => {
    expect(singleLineFenceToInlineText('```\nfoo\n```')).toBe('`foo`')
  })

  it('handles lang tag', () => {
    expect(singleLineFenceToInlineText('```ts\nbar\n```')).toBe('`bar`')
  })
})

describe('calloutHeaderToHeadingText', () => {
  it('rewrites to h2', () => {
    expect(calloutHeaderToHeadingText('> [!note] Title')).toBe('## Title')
  })

  it('defaults to Note', () => {
    expect(calloutHeaderToHeadingText('> [!note]')).toBe('## Note')
  })
})

describe('inlineMathToBlockText', () => {
  it('promotes one-line $..$ to block math', () => {
    const out = inlineMathToBlockText('$a^2 + b^2$')
    expect(out).toBe('$$\na^2 + b^2\n$$')
  })
})

describe('detectLangByHeuristic', () => {
  it('detects python', () => {
    expect(detectLangByHeuristic('import os')).toBe('python')
  })

  it('detects ts', () => {
    expect(detectLangByHeuristic('const x = 1')).toBe('ts')
  })

  it('returns empty for unknown', () => {
    expect(detectLangByHeuristic('plain text here')).toBe('')
  })
})

import {
  annotateWikilinksWithEmojiText,
  atxHeadingCloseText,
  highlightsToMarkText,
  insertTableEmptyRowText,
  markToHighlightsText,
  normalizeBulletsToDashText,
  stripAtxCloseText,
  unifyFrontmatterTagsText,
} from './commands'

describe('highlightsToMarkText / markToHighlightsText', () => {
  it('roundtrips', () => {
    const src = 'I ==love== this'
    const html = highlightsToMarkText(src)
    expect(html).toBe('I <mark>love</mark> this')
    expect(markToHighlightsText(html)).toBe(src)
  })
})

describe('normalizeBulletsToDashText', () => {
  it('normalizes star and plus', () => {
    expect(normalizeBulletsToDashText('* a\n+ b')).toBe('- a\n- b')
  })

  it('skips fence', () => {
    expect(normalizeBulletsToDashText('```\n* code\n```'))
      .toBe('```\n* code\n```')
  })
})

describe('atxHeadingCloseText', () => {
  it('adds trailing #', () => {
    expect(atxHeadingCloseText('## Hi')).toBe('## Hi ##')
  })

  it('leaves already-closed', () => {
    expect(atxHeadingCloseText('## Hi ##')).toBe('## Hi ##')
  })
})

describe('stripAtxCloseText', () => {
  it('strips trailing close', () => {
    expect(stripAtxCloseText('## Hi ##')).toBe('## Hi')
  })
})

describe('insertTableEmptyRowText', () => {
  it('inserts empty row at table end', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter'
    const out = insertTableEmptyRowText(src)
    expect(out).toContain('|  |  |')
  })

  it('no-op without table', () => {
    expect(insertTableEmptyRowText('plain')).toBe('plain')
  })
})

describe('annotateWikilinksWithEmojiText', () => {
  it('appends emoji', () => {
    expect(annotateWikilinksWithEmojiText('see [[X]]', '✨'))
      .toBe('see [[X]] ✨')
  })
})

describe('unifyFrontmatterTagsText', () => {
  it('merges multiple tag lines', () => {
    const src = '---\ntitle: x\ntags: [a, b]\ntag: c\n---\nbody'
    const out = unifyFrontmatterTagsText(src)
    expect(out).toContain('tags: ["a", "b", "c"]')
    expect(out).not.toContain('tag: c')
  })

  it('no-op when no frontmatter', () => {
    expect(unifyFrontmatterTagsText('body')).toBe('body')
  })
})

import {
  alignImagesText,
  buildScopedTOCText,
  dedupAdjacentParagraphsText,
  promoteH1ToFrontmatterTitleText,
  splitLongLinesAtSentencesText,
  tagSectionTasksInRange,
} from './commands'

describe('buildScopedTOCText', () => {
  it('emits indent by depth', () => {
    const src = '## A\n### B\n#### C\n## D'
    expect(buildScopedTOCText(src, 3)).toBe('- A\n  - B\n- D')
  })
})

describe('promoteH1ToFrontmatterTitleText', () => {
  it('prepends new frontmatter', () => {
    const out = promoteH1ToFrontmatterTitleText('# My Title\nbody')
    expect(out).toBe('---\ntitle: My Title\n---\n# My Title\nbody')
  })

  it('keeps existing title', () => {
    const src = '---\ntitle: Other\n---\n# X'
    expect(promoteH1ToFrontmatterTitleText(src)).toBe(src)
  })

  it('inserts title into existing frontmatter', () => {
    const src = '---\nfoo: bar\n---\n# Hi'
    expect(promoteH1ToFrontmatterTitleText(src))
      .toBe('---\ntitle: Hi\nfoo: bar\n---\n# Hi')
  })
})

describe('splitLongLinesAtSentencesText', () => {
  it('splits long paragraphs at sentence boundaries', () => {
    const long = 'This is one sentence. ' +
      'Here is another sentence. ' +
      'And a third one that is also pretty long.'
    const out = splitLongLinesAtSentencesText(long)
    expect(out.split('\n').length).toBeGreaterThan(1)
  })

  it('leaves short lines', () => {
    expect(splitLongLinesAtSentencesText('short')).toBe('short')
  })
})

describe('dedupAdjacentParagraphsText', () => {
  it('removes consecutive duplicates', () => {
    expect(dedupAdjacentParagraphsText('a\na\nb')).toBe('a\nb')
  })

  it('keeps separated duplicates', () => {
    expect(dedupAdjacentParagraphsText('a\nb\na')).toBe('a\nb\na')
  })
})

describe('alignImagesText', () => {
  it('wraps image with align', () => {
    const out = alignImagesText('![](x.png)', 'center')
    expect(out).toBe('<p align="center">![](x.png)</p>')
  })
})

describe('tagSectionTasksInRange', () => {
  it('adds tag to tasks', () => {
    const src = '## H\n- [ ] task1\n- [x] task2\n- not task'
    const out = tagSectionTasksInRange(src, 0, 3, 'review')
    expect(out).toContain('- [ ] task1 #review')
    expect(out).toContain('- [x] task2 #review')
    expect(out).toContain('- not task')
  })

  it('skips already-tagged', () => {
    const out = tagSectionTasksInRange('- [ ] x #review', 0, 0, 'review')
    expect(out).toBe('- [ ] x #review')
  })
})

import {
  addFrontmatterAliasText,
  addReadingCssclassText,
  buildMermaidFromWikilinks,
  collectTagTree,
  renameWikilinkText,
  renderTagTree,
  swapMermaidDirectionText,
  tagsToWikilinksText,
} from './commands'

describe('collectTagTree / renderTagTree', () => {
  it('builds nested tree', () => {
    const src = '#a/b stuff\n#a/c thing\n#a/b again\n#x'
    const tree = collectTagTree(src)
    const rendered = renderTagTree(tree)
    expect(rendered).toContain('- #a (3)')
    expect(rendered).toContain('  - #b (2)')
    expect(rendered).toContain('  - #c (1)')
    expect(rendered).toContain('- #x (1)')
  })

  it('skips fence', () => {
    const tree = collectTagTree('```\n#fenced\n```')
    expect(tree.children.size).toBe(0)
  })
})

describe('buildMermaidFromWikilinks', () => {
  it('emits TD graph', () => {
    const out = buildMermaidFromWikilinks('see [[A]] and [[B|alias]]', 'TD')
    expect(out).toContain('```mermaid')
    expect(out).toContain('graph TD')
    expect(out).toContain('"A"')
    expect(out).toContain('"B"')
  })

  it('returns empty when no wikilinks', () => {
    expect(buildMermaidFromWikilinks('plain')).toBe('')
  })
})

describe('swapMermaidDirectionText', () => {
  it('TD → LR', () => {
    expect(swapMermaidDirectionText('```mermaid\ngraph TD\n```'))
      .toBe('```mermaid\ngraph LR\n```')
  })

  it('LR → TD', () => {
    expect(swapMermaidDirectionText('```mermaid\ngraph LR\n```'))
      .toBe('```mermaid\ngraph TD\n```')
  })
})

describe('renameWikilinkText', () => {
  it('renames simple', () => {
    expect(renameWikilinkText('[[A]] and [[A|alias]]', 'A', 'B'))
      .toBe('[[B]] and [[B|alias]]')
  })

  it('does not match substring', () => {
    expect(renameWikilinkText('[[Apple]]', 'A', 'B')).toBe('[[Apple]]')
  })
})

describe('tagsToWikilinksText', () => {
  it('converts tags', () => {
    expect(tagsToWikilinksText('see #foo here'))
      .toBe('see [[foo]] here')
  })

  it('skips fence', () => {
    expect(tagsToWikilinksText('```\n#foo\n```'))
      .toBe('```\n#foo\n```')
  })
})

describe('addFrontmatterAliasText', () => {
  it('creates fm if missing', () => {
    expect(addFrontmatterAliasText('body', 'X'))
      .toBe('---\naliases: ["X"]\n---\nbody')
  })

  it('appends to existing aliases', () => {
    const src = '---\naliases: ["A"]\n---\nbody'
    expect(addFrontmatterAliasText(src, 'B'))
      .toBe('---\naliases: ["A", "B"]\n---\nbody')
  })

  it('no-op if alias exists', () => {
    const src = '---\naliases: ["A"]\n---\n'
    expect(addFrontmatterAliasText(src, 'A')).toBe(src)
  })
})

describe('addReadingCssclassText', () => {
  it('inserts new', () => {
    expect(addReadingCssclassText('body', 'two-columns'))
      .toBe('---\ncssclasses: ["two-columns"]\n---\nbody')
  })

  it('appends to existing', () => {
    const src = '---\ncssclasses: ["wide"]\n---\nbody'
    expect(addReadingCssclassText(src, 'two-columns'))
      .toBe('---\ncssclasses: ["wide", "two-columns"]\n---\nbody')
  })
})

import {
  audioLinksToEmbedText,
  buildMeetingNoteSnippet,
  buildReviewNoteSnippet,
  buildWeeklyReviewSnippet,
  forceHardBreaksText,
  swapAdjacentTableColumnsText,
  toggleCalloutFoldText,
  videoLinksToEmbedText,
} from './commands'

describe('snippet builders', () => {
  it('review note has top heading', () => {
    expect(buildReviewNoteSnippet().startsWith('# Review ')).toBe(true)
  })

  it('meeting note has a Decisions section', () => {
    expect(buildMeetingNoteSnippet()).toContain('## Decisions')
  })

  it('weekly review has a Next Week section', () => {
    expect(buildWeeklyReviewSnippet()).toContain('## Next Week')
  })
})

describe('swapAdjacentTableColumnsText', () => {
  it('swaps col 1 with col 2', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |'
    const out = swapAdjacentTableColumnsText(src, 1)
    expect(out).toBe('| b | a |\n| - | - |\n| 2 | 1 |')
  })

  it('no-op when col out of range', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |'
    expect(swapAdjacentTableColumnsText(src, 5)).toBe(src)
  })
})

describe('forceHardBreaksText', () => {
  it('appends 2 spaces to non-blank middle lines', () => {
    expect(forceHardBreaksText('a\nb\nc')).toBe('a  \nb  \nc')
  })

  it('skips blanks and final line', () => {
    expect(forceHardBreaksText('a\n\nb')).toBe('a  \n\nb')
  })
})

describe('toggleCalloutFoldText', () => {
  it('default → folded (+)', () => {
    expect(toggleCalloutFoldText('> [!note]')).toBe('> [!note]+')
  })

  it('+ → -', () => {
    expect(toggleCalloutFoldText('> [!note]+')).toBe('> [!note]-')
  })

  it('- → none', () => {
    expect(toggleCalloutFoldText('> [!note]-')).toBe('> [!note]')
  })
})

describe('videoLinksToEmbedText / audioLinksToEmbedText', () => {
  it('video link → embed', () => {
    expect(videoLinksToEmbedText('[demo](demo.mp4)')).toBe('![[demo.mp4]]')
  })

  it('audio link → embed', () => {
    expect(audioLinksToEmbedText('[s](a.mp3)')).toBe('![[a.mp3]]')
  })

  it('leaves non-media', () => {
    expect(videoLinksToEmbedText('[x](x.png)')).toBe('[x](x.png)')
  })
})

import {
  applyTemplaterText,
  expandCalloutAliasesText,
  mdImagesToDocumentEmbedText,
  documentEmbedToMdImagesText,
  reportDuplicateLinesText,
  sortLinesByLengthText,
  swapDollarMathText,
  unwrapSelfLinksText,
} from './commands'

describe('applyTemplaterText', () => {
  it('formats date with default', () => {
    const out = applyTemplaterText('{{date}}', { now: new Date(2026, 5, 7) })
    expect(out).toBe('2026-06-07')
  })

  it('formats date with custom pattern', () => {
    const out = applyTemplaterText('{{date:YYYY/MM/DD}}', { now: new Date(2026, 5, 7) })
    expect(out).toBe('2026/06/07')
  })

  it('substitutes title', () => {
    expect(applyTemplaterText('# {{title}}', { title: 'Hi' })).toBe('# Hi')
  })

  it('formats time', () => {
    const out = applyTemplaterText('{{time:HH-mm}}', { now: new Date(2026, 0, 1, 9, 8) })
    expect(out).toBe('09-08')
  })
})

describe('swapDollarMathText', () => {
  it('inline → block', () => {
    expect(swapDollarMathText('$x$', true)).toBe('$$x$$')
  })

  it('block → inline', () => {
    expect(swapDollarMathText('$$x$$', false)).toBe('$x$')
  })
})

describe('sortLinesByLengthText', () => {
  it('asc', () => {
    expect(sortLinesByLengthText('aaa\nb\ncc')).toBe('b\ncc\naaa')
  })

  it('desc', () => {
    expect(sortLinesByLengthText('aaa\nb\ncc', true)).toBe('aaa\ncc\nb')
  })
})

describe('reportDuplicateLinesText', () => {
  it('reports duplicates with line numbers', () => {
    const src = 'a\nb\na\nc\nb\nb'
    const out = reportDuplicateLinesText(src)
    expect(out).toContain('"b"')
    expect(out).toContain('× 3')
  })

  it('empty when no dupes', () => {
    expect(reportDuplicateLinesText('a\nb\nc')).toBe('')
  })
})

describe('mdImagesToDocumentEmbedText / documentEmbedToMdImagesText', () => {
  it('md → obs for relative', () => {
    expect(mdImagesToDocumentEmbedText('![alt](pic.png)')).toBe('![[pic.png]]')
  })

  it('md skips http', () => {
    expect(mdImagesToDocumentEmbedText('![](https://x/y.png)'))
      .toBe('![](https://x/y.png)')
  })

  it('obs → md', () => {
    expect(documentEmbedToMdImagesText('![[pic.png]]')).toBe('![](pic.png)')
  })
})

describe('expandCalloutAliasesText', () => {
  it('expands single-letter aliases', () => {
    expect(expandCalloutAliasesText('> [!w] Heads')).toBe('> [!warning] Heads')
    expect(expandCalloutAliasesText('> [!t]')).toBe('> [!tip]')
  })

  it('leaves unknown', () => {
    expect(expandCalloutAliasesText('> [!z]')).toBe('> [!z]')
  })

  it('leaves multi-letter standard', () => {
    expect(expandCalloutAliasesText('> [!note]')).toBe('> [!note]')
  })
})

describe('unwrapSelfLinksText', () => {
  it('wraps self-link as autolink', () => {
    expect(unwrapSelfLinksText('[https://x.com](https://x.com)'))
      .toBe('<https://x.com>')
  })

  it('keeps distinct text', () => {
    expect(unwrapSelfLinksText('[x](https://x.com)'))
      .toBe('[x](https://x.com)')
  })
})

import {
  filterOutlineByLevelText,
  autoLinkBareUrlsText,
  titleCaseFrontmatterKeysText,
  trimHeadingPunctuationText,
  splitLongTableText,
  embedKnownVideoIframesText,
} from './commands'

describe('filterOutlineByLevelText', () => {
  it('keeps headings up to keepLevel only', () => {
    const src = '# A\n## B\n### C\n#### D\ncontent\n'
    expect(filterOutlineByLevelText(src, 2)).toBe('# A\n## B\ncontent\n')
  })

  it('preserves fenced code', () => {
    const src = '# A\n```\n### inside\n```\n## B\n'
    expect(filterOutlineByLevelText(src, 1)).toBe('# A\n```\n### inside\n```\n')
  })
})

describe('autoLinkBareUrlsText', () => {
  it('wraps bare URL with host as label', () => {
    expect(autoLinkBareUrlsText('see https://example.com/x for more'))
      .toBe('see [example.com](https://example.com/x) for more')
  })

  it('skips URL already in md link', () => {
    expect(autoLinkBareUrlsText('[ex](https://example.com)'))
      .toBe('[ex](https://example.com)')
  })

  it('skips URL inline-code', () => {
    expect(autoLinkBareUrlsText('use `curl https://example.com`'))
      .toBe('use `curl https://example.com`')
  })

  it('strips trailing punctuation from URL', () => {
    expect(autoLinkBareUrlsText('see https://example.com.'))
      .toBe('see [example.com](https://example.com).')
  })
})

describe('titleCaseFrontmatterKeysText', () => {
  it('title-cases YAML keys', () => {
    const src = '---\nblog_title: Hi\nauthor-name: A\n---\nbody\n'
    expect(titleCaseFrontmatterKeysText(src)).toBe(
      '---\nBlog Title: Hi\nAuthor Name: A\n---\nbody\n',
    )
  })

  it('leaves doc without frontmatter alone', () => {
    expect(titleCaseFrontmatterKeysText('hello\n')).toBe('hello\n')
  })
})

describe('trimHeadingPunctuationText', () => {
  it('removes trailing colon and period', () => {
    expect(trimHeadingPunctuationText('## Foo:'))
      .toBe('## Foo')
    expect(trimHeadingPunctuationText('# Bar.'))
      .toBe('# Bar')
  })

  it('removes Chinese punctuation', () => {
    const title = String.fromCodePoint(0x6807, 0x9898)
    expect(trimHeadingPunctuationText(`### ${title}${String.fromCodePoint(0x3002)}`))
      .toBe(`### ${title}`)
  })

  it('leaves non-headings alone', () => {
    expect(trimHeadingPunctuationText('foo.'))
      .toBe('foo.')
  })
})

describe('splitLongTableText', () => {
  it('splits table that exceeds chunkRows', () => {
    const rows = Array.from({ length: 7 }, (_, i) => `| ${i + 1} | r${i + 1} |`).join('\n')
    const src = `| n | x |\n| --- | --- |\n${rows}\n`
    const out = splitLongTableText(src, 3)
    // 3 chunks of header+sep+3/3/1 rows
    expect(out.match(/\| --- \| --- \|/g)?.length).toBe(3)
  })

  it('leaves small tables alone', () => {
    const src = '| n | x |\n| --- | --- |\n| 1 | a |\n'
    expect(splitLongTableText(src, 5)).toBe(src)
  })
})

describe('embedKnownVideoIframesText', () => {
  it('converts youtube link to iframe', () => {
    expect(embedKnownVideoIframesText('https://youtube.com/watch?v=abcdef'))
      .toContain('youtube.com/embed/abcdef')
  })

  it('converts youtu.be link', () => {
    expect(embedKnownVideoIframesText('https://youtu.be/xyz123'))
      .toContain('youtube.com/embed/xyz123')
  })

  it('converts www.youtube.com link to iframe', () => {
    expect(embedKnownVideoIframesText('https://www.youtube.com/watch?v=video123'))
      .toContain('youtube.com/embed/video123')
  })

  it('leaves unknown URLs alone', () => {
    expect(embedKnownVideoIframesText('https://example.com/v'))
      .toBe('https://example.com/v')
  })
})

import {
  findWikilinkPositions,
  promoteListIndentText,
  demoteListIndentText,
  unifyBulletMarkersText,
  buildDocumentMapText,
  countCharsInRangeText,
  extractHtmlCommentsAsSectionText,
} from './commands'

describe('findWikilinkPositions', () => {
  it('finds all wikilink offsets', () => {
    expect(findWikilinkPositions('a [[x]] b [[y]]')).toEqual([2, 10])
  })

  it('skips fence', () => {
    expect(findWikilinkPositions('a [[x]]\n```\n[[no]]\n```\n[[y]]'))
      .toEqual([2, 23])
  })

  it('skips inline code', () => {
    expect(findWikilinkPositions('use `[[ignored]]` then [[real]]'))
      .toEqual([23])
  })
})

describe('promoteListIndentText / demoteListIndentText', () => {
  it('adds two spaces to list lines only', () => {
    const src = '- a\nparagraph\n- b\n'
    expect(promoteListIndentText(src)).toBe('  - a\nparagraph\n  - b\n')
  })

  it('demotes by removing up to two leading spaces', () => {
    expect(demoteListIndentText('    - a\n  - b\n')).toBe('  - a\n- b\n')
  })

  it('promote skips fenced code', () => {
    const src = '- a\n```\n- in\n```\n'
    expect(promoteListIndentText(src)).toBe('  - a\n```\n- in\n```\n')
  })
})

describe('unifyBulletMarkersText', () => {
  it('rewrites *, + to -', () => {
    expect(unifyBulletMarkersText('* a\n+ b\n- c'))
      .toBe('- a\n- b\n- c')
  })

  it('respects target marker arg', () => {
    expect(unifyBulletMarkersText('- a\n- b', '*'))
      .toBe('* a\n* b')
  })

  it('leaves numbered lists alone', () => {
    expect(unifyBulletMarkersText('1. a\n2. b'))
      .toBe('1. a\n2. b')
  })
})

describe('buildDocumentMapText', () => {
  it('appends a section listing H1-H3', () => {
    const src = '# A\n## B\n### C\n#### D\ntext'
    const out = buildDocumentMapText(src)
    expect(out).toContain('## Document Map')
    expect(out).toContain('- A')
    expect(out).toContain('  - B')
    expect(out).toContain('    - C')
    expect(out).not.toContain('- D')
  })

  it('no-op when no headings', () => {
    expect(buildDocumentMapText('just text\n')).toBe('just text\n')
  })
})

describe('countCharsInRangeText', () => {
  it('returns slice length', () => {
    expect(countCharsInRangeText('hello world', 6, 11)).toBe(5)
  })

  it('clamps negative', () => {
    expect(countCharsInRangeText('xx', 5, 0)).toBe(0)
  })
})

describe('extractHtmlCommentsAsSectionText', () => {
  it('extracts inline comments to an Annotations section', () => {
    const src = 'a <!-- note: 1 --> b\nc <!--note: 2-->\n'
    const out = extractHtmlCommentsAsSectionText(src)
    expect(out).toContain('## Annotations')
    expect(out).toContain('- note: 1')
    expect(out).toContain('- note: 2')
    expect(out).not.toContain('<!--')
  })

  it('no-op without comments', () => {
    expect(extractHtmlCommentsAsSectionText('no comments\n'))
      .toBe('no comments\n')
  })
})

import {
  renderProgressBarText,
  foldAllCalloutsText,
  expandAllCalloutsText,
  ensureTimestampsInFrontmatterText,
  cleanupAllWhitespaceText,
  linksToQrShortcutText,
  extractTasksToSummarySectionText,
} from './commands'

describe('renderProgressBarText', () => {
  it('renders 0 to all empty', () => {
    expect(renderProgressBarText(0, 10)).toBe('[░░░░░░░░░░] 0%')
  })

  it('renders 100 to all full', () => {
    expect(renderProgressBarText(100, 10)).toBe('[██████████] 100%')
  })

  it('clamps over 100', () => {
    expect(renderProgressBarText(150, 5)).toContain('100%')
  })
})

describe('foldAllCalloutsText / expandAllCalloutsText', () => {
  it('adds dash to all callout heads', () => {
    expect(foldAllCalloutsText('> [!note] x\n> [!tip] y'))
      .toBe('> [!note]- x\n> [!tip]- y')
  })

  it('expand removes fold marker', () => {
    expect(expandAllCalloutsText('> [!note]- x\n> [!tip]+ y'))
      .toBe('> [!note] x\n> [!tip] y')
  })
})

describe('ensureTimestampsInFrontmatterText', () => {
  it('adds frontmatter when missing', () => {
    const out = ensureTimestampsInFrontmatterText('body\n', '2026-06-07T00:00:00Z')
    expect(out.startsWith('---\ncreated: 2026-06-07T00:00:00Z\nmodified: 2026-06-07T00:00:00Z\n---'))
      .toBe(true)
  })

  it('updates modified, keeps existing created', () => {
    const src = '---\ncreated: 2024-01-01\nmodified: 2024-01-02\n---\nbody\n'
    const out = ensureTimestampsInFrontmatterText(src, '2026-06-07T00:00:00Z')
    expect(out).toContain('created: 2024-01-01')
    expect(out).toContain('modified: 2026-06-07T00:00:00Z')
  })
})

describe('cleanupAllWhitespaceText', () => {
  it('removes BOM, zero-width, trailing space, tab', () => {
    const src = '﻿hello ​\tworld   \n'
    expect(cleanupAllWhitespaceText(src)).toBe('hello   world\n')
  })

  it('normalizes CRLF to LF', () => {
    expect(cleanupAllWhitespaceText('a\r\nb\r\n')).toBe('a\nb\n')
  })
})

describe('linksToQrShortcutText', () => {
  it('rewrites md link href to qr endpoint', () => {
    const out = linksToQrShortcutText('[ex](https://example.com)')
    expect(out).toContain('api.qrserver.com')
    expect(out).toContain(encodeURIComponent('https://example.com'))
  })

  it('skips image embed', () => {
    expect(linksToQrShortcutText('![alt](https://example.com/x.png)'))
      .toBe('![alt](https://example.com/x.png)')
  })
})

describe('extractTasksToSummarySectionText', () => {
  it('appends a Task List section listing all task lines', () => {
    const src = '# A\n- [ ] one\n- [x] two\nother\n'
    const out = extractTasksToSummarySectionText(src)
    expect(out).toContain('## Task List')
    expect(out).toContain('- [ ] one')
    expect(out).toContain('- [x] two')
  })

  it('no-op without tasks', () => {
    expect(extractTasksToSummarySectionText('plain\n')).toBe('plain\n')
  })
})

import {
  inlineFootnotesToReferenceText,
  explodeListToParagraphsText,
  mergeAdjacentDuplicateHeadingsText,
  tableColumnToWikilinksText,
  wrapHeadingsAsBlockLinksText,
} from './commands'

describe('inlineFootnotesToReferenceText', () => {
  it('converts inline footnotes and appends references', () => {
    const out = inlineFootnotesToReferenceText('hello ^[first] world ^[second]\n')
    expect(out).toContain('hello [^1] world [^2]')
    expect(out).toContain('[^1]: first')
    expect(out).toContain('[^2]: second')
  })

  it('no-op without inline footnotes', () => {
    expect(inlineFootnotesToReferenceText('nope\n')).toBe('nope\n')
  })
})

describe('explodeListToParagraphsText', () => {
  it('removes bullets and double-spaces lines', () => {
    expect(explodeListToParagraphsText('- a\n- b\n- c\n'))
      .toBe('a\n\nb\n\nc\n')
  })

  it('preserves fenced code', () => {
    const src = '- a\n```\n- b\n```\n'
    expect(explodeListToParagraphsText(src)).toContain('```\n- b\n```')
  })
})

describe('mergeAdjacentDuplicateHeadingsText', () => {
  it('removes second occurrence of same heading', () => {
    const src = '## A\n\n## A\ncontent\n'
    expect(mergeAdjacentDuplicateHeadingsText(src))
      .toBe('## A\ncontent\n')
  })

  it('keeps non-duplicate adjacent headings', () => {
    const src = '## A\n## B\n'
    expect(mergeAdjacentDuplicateHeadingsText(src)).toBe('## A\n## B\n')
  })
})

describe('tableColumnToWikilinksText', () => {
  it('wraps cells in target column with [[...]]', () => {
    const src = '| name | age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n'
    const out = tableColumnToWikilinksText(src, 0)
    expect(out).toContain('| [[Alice]] | 30 |')
    expect(out).toContain('| [[Bob]] | 25 |')
    expect(out).toContain('| name | age |')
  })

  it('skips already-wikilinked cells', () => {
    const src = '| a | b |\n| --- | --- |\n| [[X]] | y |\n'
    const out = tableColumnToWikilinksText(src, 0)
    expect(out).toContain('| [[X]] | y |')
  })
})

describe('wrapHeadingsAsBlockLinksText', () => {
  it('wraps headings with self-wikilink', () => {
    expect(wrapHeadingsAsBlockLinksText('## Foo'))
      .toBe('## [[#Foo]]')
  })

  it('skips already-wrapped headings', () => {
    expect(wrapHeadingsAsBlockLinksText('## [[#Foo]]'))
      .toBe('## [[#Foo]]')
  })

  it('skips fence', () => {
    expect(wrapHeadingsAsBlockLinksText('```\n## inside\n```'))
      .toBe('```\n## inside\n```')
  })
})

import {
  bulletsToOrderedText,
  orderedToBulletsText,
  suggestFilenameFromH1,
  buildWordCloudSnapshotText,
  shuffleParagraphsText,
  sortFrontmatterArrayValuesText,
} from './commands'

describe('bulletsToOrderedText / orderedToBulletsText', () => {
  it('converts top-level bullets to ordered counter', () => {
    expect(bulletsToOrderedText('- a\n- b\n- c'))
      .toBe('1. a\n2. b\n3. c')
  })

  it('does not renumber nested bullets', () => {
    expect(bulletsToOrderedText('- a\n  - x\n- b'))
      .toBe('1. a\n  - x\n2. b')
  })

  it('ordered to bullets', () => {
    expect(orderedToBulletsText('1. a\n2. b'))
      .toBe('- a\n- b')
  })
})

describe('suggestFilenameFromH1', () => {
  it('slugifies H1 text', () => {
    expect(suggestFilenameFromH1('# Hello World!\nbody'))
      .toBe('hello-world')
  })

  it('returns null when no H1', () => {
    expect(suggestFilenameFromH1('## sub\n')).toBe(null)
  })
})

describe('buildWordCloudSnapshotText', () => {
  it('appends a Word Cloud section with top words', () => {
    const src = 'alpha alpha beta beta beta gamma\n'
    const out = buildWordCloudSnapshotText(src, 2)
    expect(out).toContain('## Word Cloud')
    expect(out).toContain('beta×3')
    expect(out).toContain('alpha×2')
    expect(out).not.toContain('gamma×1')
  })

  it('no-op when empty', () => {
    expect(buildWordCloudSnapshotText('', 5)).toBe('')
  })
})

describe('shuffleParagraphsText', () => {
  it('preserves headings and lists', () => {
    const src = '# title\n\npara one\n\n- l1\n\npara two\n'
    const out = shuffleParagraphsText(src, () => 0)
    expect(out.split('\n\n')[0]).toBe('# title')
    expect(out).toContain('- l1')
  })

  it('reverses paragraph order with rng=1', () => {
    const src = 'A\n\nB\n\nC\n'
    const rngVals = [0, 0]
    let i = 0
    const out = shuffleParagraphsText(src, () => rngVals[i++ % rngVals.length])
    expect(out.includes('A') && out.includes('B') && out.includes('C')).toBe(true)
  })
})

describe('sortFrontmatterArrayValuesText', () => {
  it('sorts inline array values', () => {
    const src = '---\ntags: [c, a, b]\n---\nbody\n'
    expect(sortFrontmatterArrayValuesText(src))
      .toBe('---\ntags: [a, b, c]\n---\nbody\n')
  })

  it('leaves scalar lines alone', () => {
    const src = '---\ntitle: Hi\ntags: [b, a]\n---\n'
    expect(sortFrontmatterArrayValuesText(src))
      .toBe('---\ntitle: Hi\ntags: [a, b]\n---\n')
  })

  it('no-op without frontmatter', () => {
    expect(sortFrontmatterArrayValuesText('body\n')).toBe('body\n')
  })
})

import {
  sortH2SectionsByDateText,
  orderedToRomanText,
  tasksToDefinitionListText,
  redactSensitivePatternsText,
  mergeDuplicateWikilinksText,
} from './commands'

describe('sortH2SectionsByDateText', () => {
  it('reorders dated H2 sections', () => {
    const src = '## 2024-03-01 Mar\nm body\n\n## 2024-01-01 Jan\nj body\n'
    const out = sortH2SectionsByDateText(src)
    expect(out.indexOf('## 2024-01-01')).toBeLessThan(out.indexOf('## 2024-03-01'))
  })

  it('keeps undated sections after dated', () => {
    const src = '## 2024-03-01\nA\n\n## misc\nB\n\n## 2024-01-01\nC\n'
    const out = sortH2SectionsByDateText(src)
    const i1 = out.indexOf('## 2024-01-01')
    const i2 = out.indexOf('## 2024-03-01')
    const i3 = out.indexOf('## misc')
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
  })
})

describe('orderedToRomanText', () => {
  it('rewrites top-level ordered to lowercase roman', () => {
    expect(orderedToRomanText('1. a\n2. b\n3. c'))
      .toBe('i. a\nii. b\niii. c')
  })

  it('leaves nested lists alone', () => {
    expect(orderedToRomanText('1. a\n  1. nested\n2. b'))
      .toBe('i. a\n  1. nested\nii. b')
  })
})

describe('tasksToDefinitionListText', () => {
  it('converts tasks to definition list', () => {
    const out = tasksToDefinitionListText('- [ ] one\n- [x] two\n')
    expect(out).toContain('one\n: Status: Not completed')
    expect(out).toContain('two\n: Status: Completed')
  })

  it('leaves non-tasks alone', () => {
    expect(tasksToDefinitionListText('hello\n')).toBe('hello\n')
  })
})

describe('redactSensitivePatternsText', () => {
  it('redacts email', () => {
    const out = redactSensitivePatternsText('contact me at hello@example.com')
    expect(out).not.toContain('hello@example.com')
    expect(out).toContain('he')
    expect(out).toContain('█')
  })

  it('redacts long digit sequences', () => {
    const out = redactSensitivePatternsText('card 4111 1111 1111 1234 here')
    expect(out).toContain('41')
    expect(out).toContain('34')
    expect(out).toContain('█')
    expect(out).not.toContain('1111 1111')
  })
})

describe('mergeDuplicateWikilinksText', () => {
  it('strips alias from wikilink', () => {
    expect(mergeDuplicateWikilinksText('see [[Foo|name]] and [[Foo]]'))
      .toBe('see [[Foo]] and [[Foo]]')
  })

  it('leaves alias-free wikilinks alone', () => {
    expect(mergeDuplicateWikilinksText('[[Bar]]')).toBe('[[Bar]]')
  })
})

import {
  blockquoteToCalloutText,
  calloutToBlockquoteText,
  paragraphsToSentenceBulletsText,
  emojifyHeadingsText,
  stripMarkdownToPlainTextV2,
  annotateUrlsWithTitlePlaceholderText,
  removeOrphanListMarkersText,
  sortFrontmatterKeysAlphaText,
} from './commands'

describe('blockquoteToCalloutText', () => {
  it('upgrades blockquote first line with [!type]', () => {
    expect(blockquoteToCalloutText('> hello\n> world\n', 'note'))
      .toBe('> [!note] hello\n> world\n')
  })

  it('skips already-callout blocks', () => {
    expect(blockquoteToCalloutText('> [!tip] go\n> deeper\n'))
      .toBe('> [!tip] go\n> deeper\n')
  })
})

describe('calloutToBlockquoteText', () => {
  it('strips [!type] tag', () => {
    expect(calloutToBlockquoteText('> [!warning] watch\n> body'))
      .toBe('> watch\n> body')
  })

  it('handles fold marker', () => {
    expect(calloutToBlockquoteText('> [!note]- hi'))
      .toBe('> hi')
  })
})

describe('paragraphsToSentenceBulletsText', () => {
  it('splits multi-sentence paragraph into bullets', () => {
    const out = paragraphsToSentenceBulletsText('First. Second. Third.\n')
    expect(out).toContain('- First.')
    expect(out).toContain('- Second.')
    expect(out).toContain('- Third.')
  })

  it('leaves headings alone', () => {
    expect(paragraphsToSentenceBulletsText('# H. Second.'))
      .toBe('# H. Second.')
  })

  it('does not split single-sentence paragraph', () => {
    expect(paragraphsToSentenceBulletsText('Just one sentence.'))
      .toBe('Just one sentence.')
  })
})

describe('emojifyHeadingsText', () => {
  it('prepends emoji to headings', () => {
    const rng = () => 0
    expect(emojifyHeadingsText('## Title', rng)).toBe('## 📌 Title')
  })

  it('skips headings already with emoji', () => {
    const rng = () => 0
    expect(emojifyHeadingsText('## 📌 Title', rng))
      .toBe('## 📌 Title')
  })
})

describe('stripMarkdownToPlainTextV2', () => {
  it('strips bold, italic, links', () => {
    expect(stripMarkdownToPlainTextV2('**bold** *it* [t](u)'))
      .toBe('bold it t')
  })

  it('strips wikilink with alias', () => {
    expect(stripMarkdownToPlainTextV2('see [[Foo|fo]] and [[Bar]]'))
      .toBe('see fo and Bar')
  })

  it('strips headings', () => {
    expect(stripMarkdownToPlainTextV2('## Heading'))
      .toBe('Heading')
  })
})

describe('annotateUrlsWithTitlePlaceholderText', () => {
  it('annotates bare URLs', () => {
    expect(annotateUrlsWithTitlePlaceholderText('https://x.com'))
      .toBe('[https://x.com](https://x.com "TODO: title")')
  })

  it('skips already-linked URLs', () => {
    expect(annotateUrlsWithTitlePlaceholderText('[x](https://x.com)'))
      .toBe('[x](https://x.com)')
  })
})

describe('removeOrphanListMarkersText', () => {
  it('drops empty bullet lines', () => {
    expect(removeOrphanListMarkersText('- ok\n- \n- still'))
      .toBe('- ok\n- still')
  })

  it('drops empty ordered markers', () => {
    expect(removeOrphanListMarkersText('1. ok\n2. \n3. last'))
      .toBe('1. ok\n3. last')
  })
})

describe('sortFrontmatterKeysAlphaText', () => {
  it('sorts keys alphabetically', () => {
    const src = '---\nzeta: 1\nalpha: 2\nbeta: 3\n---\nbody\n'
    const out = sortFrontmatterKeysAlphaText(src)
    expect(out.indexOf('alpha:')).toBeLessThan(out.indexOf('beta:'))
    expect(out.indexOf('beta:')).toBeLessThan(out.indexOf('zeta:'))
  })

  it('no-op without frontmatter', () => {
    expect(sortFrontmatterKeysAlphaText('body\n')).toBe('body\n')
  })
})

import {
  mergeConsecutiveCodeBlocksText,
  applyWikilinkAliasMapText,
  imagesToFigureCaptionText,
  expandInlineYamlObjectsText,
  wrapH3SectionsAsDetailsText,
} from './commands'

describe('mergeConsecutiveCodeBlocksText', () => {
  it('merges two adjacent js blocks', () => {
    const src = '```js\nA\n```\n\n```js\nB\n```\n'
    const out = mergeConsecutiveCodeBlocksText(src)
    expect(out).toContain('```js\nA\nB\n```')
    // only one fence pair
    expect((out.match(/```js/g) ?? []).length).toBe(1)
  })

  it('keeps different-lang blocks separate', () => {
    const src = '```js\nA\n```\n\n```py\nB\n```\n'
    expect(mergeConsecutiveCodeBlocksText(src)).toBe(src)
  })
})

describe('applyWikilinkAliasMapText', () => {
  it('rewrites alias hits to wikilink with alias', () => {
    const out = applyWikilinkAliasMapText('see Foo Bar', { Foo: 'Real Foo' })
    expect(out).toBe('see [[Real Foo|Foo]] Bar')
  })

  it('skips existing wikilink', () => {
    const out = applyWikilinkAliasMapText('[[Real Foo|Foo]] and Foo', { Foo: 'Real Foo' })
    expect(out).toBe('[[Real Foo|Foo]] and [[Real Foo|Foo]]')
  })

  it('prefers longest alias', () => {
    const out = applyWikilinkAliasMapText('see Foo Bar Baz', { Foo: 'A', 'Foo Bar': 'B' })
    expect(out).toBe('see [[B|Foo Bar]] Baz')
  })
})

describe('imagesToFigureCaptionText', () => {
  it('turns image into figure with caption', () => {
    expect(imagesToFigureCaptionText('![cat](cat.png)'))
      .toBe('<figure><img src="cat.png" alt="cat"/><figcaption>cat</figcaption></figure>')
  })

  it('uses Image as fallback caption', () => {
    expect(imagesToFigureCaptionText('![](x.png)'))
      .toContain('<figcaption>Image</figcaption>')
  })
})

describe('expandInlineYamlObjectsText', () => {
  it('expands inline object', () => {
    const src = '---\nmeta: {a: 1, b: 2}\n---\nbody\n'
    const out = expandInlineYamlObjectsText(src)
    expect(out).toContain('meta:\n  a: 1\n  b: 2')
  })

  it('leaves scalar lines alone', () => {
    const src = '---\nname: Hi\n---\n'
    expect(expandInlineYamlObjectsText(src)).toBe(src)
  })
})

describe('wrapH3SectionsAsDetailsText', () => {
  it('wraps H3 body in details/summary', () => {
    const src = '### Foo\nbody\nmore\n'
    const out = wrapH3SectionsAsDetailsText(src)
    expect(out).toContain('<details><summary>Foo</summary>')
    expect(out).toContain('</details>')
    expect(out).toContain('body')
  })

  it('leaves H1/H2 alone', () => {
    const src = '## A\nstuff\n'
    expect(wrapH3SectionsAsDetailsText(src)).toBe(src)
  })
})

import {
  smartJoinSoftWrapsText,
  wikipediaUrlsToWikilinksText,
  formatJsonCodeBlocksText,
  formatYamlCodeBlocksText,
  calloutsToAdmonitionText,
  rot13Text,
  checklistToBarText,
} from './commands'

describe('smartJoinSoftWrapsText', () => {
  it('joins consecutive plain prose lines with single space', () => {
    const src = 'foo\nbar\nbaz\n'
    const out = smartJoinSoftWrapsText(src)
    expect(out).toBe('foo bar baz\n')
  })

  it('does not join list items', () => {
    const src = '- a\n- b\n'
    expect(smartJoinSoftWrapsText(src)).toBe(src)
  })

  it('preserves fenced code blocks', () => {
    const src = '```\nfoo\nbar\n```\n'
    expect(smartJoinSoftWrapsText(src)).toBe(src)
  })

  it('does not merge heading and next line', () => {
    const src = '# Title\nbody one\nbody two\n'
    const out = smartJoinSoftWrapsText(src)
    expect(out).toBe('# Title\nbody one body two\n')
  })
})

describe('wikipediaUrlsToWikilinksText', () => {
  it('rewrites en.wikipedia URL', () => {
    const src = 'see https://en.wikipedia.org/wiki/CodeMirror\n'
    expect(wikipediaUrlsToWikilinksText(src)).toBe('see [[en.wp:CodeMirror]]\n')
  })

  it('decodes underscores to spaces', () => {
    const src = 'see https://en.wikipedia.org/wiki/New_York_City\n'
    expect(wikipediaUrlsToWikilinksText(src)).toBe('see [[en.wp:New York City]]\n')
  })

  it('handles other language wikipedia', () => {
    const src = 'see https://zh.wikipedia.org/wiki/Foo\n'
    expect(wikipediaUrlsToWikilinksText(src)).toBe('see [[zh.wp:Foo]]\n')
  })

  it('preserves fenced code', () => {
    const src = '```\nhttps://en.wikipedia.org/wiki/Foo\n```\n'
    expect(wikipediaUrlsToWikilinksText(src)).toBe(src)
  })
})

describe('formatJsonCodeBlocksText', () => {
  it('reformats compact json', () => {
    const src = '```json\n{"a":1,"b":2}\n```\n'
    const out = formatJsonCodeBlocksText(src)
    expect(out).toContain('"a": 1')
    expect(out).toContain('"b": 2')
  })

  it('keeps malformed json as-is', () => {
    const src = '```json\n{not valid}\n```\n'
    expect(formatJsonCodeBlocksText(src)).toBe(src)
  })

  it('skips non-json fences', () => {
    const src = '```\n{"a":1}\n```\n'
    expect(formatJsonCodeBlocksText(src)).toBe(src)
  })
})

describe('formatYamlCodeBlocksText', () => {
  it('strips trailing whitespace and converts tabs', () => {
    const src = '```yaml\nfoo: 1   \n\tbar: 2\n```\n'
    const out = formatYamlCodeBlocksText(src)
    expect(out).toContain('foo: 1\n')
    expect(out).toContain('  bar: 2')
  })

  it('preserves yml lang tag', () => {
    const src = '```yml\nfoo: 1\n```\n'
    const out = formatYamlCodeBlocksText(src)
    expect(out.startsWith('```yml\n')).toBe(true)
  })
})

describe('calloutsToAdmonitionText', () => {
  it('converts note callout to admonition', () => {
    const src = '> [!note] Title\n> body line\n'
    const out = calloutsToAdmonitionText(src)
    expect(out).toBe('!!! note "Title"\n    body line\n')
  })

  it('handles callout without title', () => {
    const src = '> [!warning]\n> heads up\n'
    const out = calloutsToAdmonitionText(src)
    expect(out).toBe('!!! warning\n    heads up\n')
  })

  it('leaves non-callout blockquotes alone', () => {
    const src = '> just a quote\n'
    expect(calloutsToAdmonitionText(src)).toBe(src)
  })
})

describe('rot13Text', () => {
  it('encodes ASCII letters', () => {
    expect(rot13Text('Hello')).toBe('Uryyb')
    expect(rot13Text('abc XYZ')).toBe('nop KLM')
  })

  it('leaves non-letters alone', () => {
    expect(rot13Text('1+2=3!')).toBe('1+2=3!')
  })

  it('is its own inverse', () => {
    const s = 'Mixed CASE 123'
    expect(rot13Text(rot13Text(s))).toBe(s)
  })
})

describe('checklistToBarText', () => {
  it('renders 30% bar for 3/10 done', () => {
    const src = Array.from({ length: 10 }, (_, i) =>
      `- [${i < 3 ? 'x' : ' '}] item ${i}\n`,
    ).join('')
    expect(checklistToBarText(src)).toBe('▰▰▰▱▱▱▱▱▱▱ 30% (3/10)')
  })

  it('returns source unchanged if no tasks', () => {
    const src = '- plain item\n'
    expect(checklistToBarText(src)).toBe(src)
  })

  it('respects custom width', () => {
    const src = '- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n'
    expect(checklistToBarText(src, 4)).toBe('▰▰▱▱ 50% (2/4)')
  })
})

import {
  wordWrapParagraphsText,
  toggleSetextHeadingsText,
  orderedListToLetteredText,
  stripEmojiFromHeadingsText,
  ensureCreatedUpdatedTimestampsText,
  changeOrderedStartText,
} from './commands'

describe('wordWrapParagraphsText', () => {
  it('wraps long prose at given width', () => {
    const src = 'one two three four five six seven eight\n'
    const out = wordWrapParagraphsText(src, 15)
    const lines = out.trimEnd().split('\n')
    expect(lines.every((l) => l.length <= 15)).toBe(true)
    expect(lines.join(' ')).toBe('one two three four five six seven eight')
  })

  it('does not wrap list items', () => {
    const src = '- abc def ghi jkl mno pqr\n'
    expect(wordWrapParagraphsText(src, 10)).toBe(src)
  })

  it('preserves code fence content', () => {
    const src = '```\nlong line of code that should not wrap regardless\n```\n'
    expect(wordWrapParagraphsText(src, 10)).toBe(src)
  })
})

describe('toggleSetextHeadingsText', () => {
  it('ATX H1 → setext with =', () => {
    const out = toggleSetextHeadingsText('# Hello\n')
    expect(out).toBe('Hello\n=====\n')
  })

  it('ATX H2 → setext with -', () => {
    const out = toggleSetextHeadingsText('## Hi\n')
    expect(out).toBe('Hi\n---\n')
  })

  it('setext H1 → ATX', () => {
    const out = toggleSetextHeadingsText('Hello\n=====\n')
    expect(out).toBe('# Hello\n')
  })
})

describe('orderedListToLetteredText', () => {
  it('converts 1.2.3. to a.b.c.', () => {
    const src = '1. a\n2. b\n3. c\n'
    expect(orderedListToLetteredText(src)).toBe('a. a\nb. b\nc. c\n')
  })

  it('respects indentation', () => {
    expect(orderedListToLetteredText('  1. a\n  2. b\n')).toBe('  a. a\n  b. b\n')
  })
})

describe('stripEmojiFromHeadingsText', () => {
  it('removes emoji from H1', () => {
    expect(stripEmojiFromHeadingsText('# 🚀 Foo\n')).toBe('# Foo\n')
  })

  it('keeps body text intact', () => {
    const src = '# Foo\n🚀 body line\n'
    expect(stripEmojiFromHeadingsText(src)).toBe(src)
  })
})

describe('ensureCreatedUpdatedTimestampsText', () => {
  it('inserts frontmatter when missing', () => {
    const now = new Date('2026-06-07T12:00:00Z')
    const out = ensureCreatedUpdatedTimestampsText('body', now)
    expect(out).toContain('created: 2026-06-07T12:00:00.000Z')
    expect(out).toContain('updated: 2026-06-07T12:00:00.000Z')
    expect(out).toContain('\nbody')
  })

  it('refreshes only updated when both present', () => {
    const now = new Date('2026-06-07T12:00:00Z')
    const src = '---\ncreated: 2024-01-01T00:00:00.000Z\nupdated: 2024-02-02T00:00:00.000Z\n---\n'
    const out = ensureCreatedUpdatedTimestampsText(src, now)
    expect(out).toContain('created: 2024-01-01T00:00:00.000Z')
    expect(out).toContain('updated: 2026-06-07T12:00:00.000Z')
  })
})

describe('changeOrderedStartText', () => {
  it('shifts start of single block', () => {
    const out = changeOrderedStartText('1. a\n2. b\n3. c\n', 10)
    expect(out).toBe('10. a\n11. b\n12. c\n')
  })

  it('resets counter across blank line', () => {
    const out = changeOrderedStartText('1. a\n2. b\n\n1. x\n2. y\n', 5)
    expect(out).toBe('5. a\n6. b\n\n5. x\n6. y\n')
  })
})

import {
  tableToYamlObjectsText,
  stripWikilinkAliasesText,
  headingsToNestedListText,
  normalizeMixedIndentText,
  sortTableByColumnDescText,
  inferFilenameFromH1Text,
  inlineCodeToWikilinkText,
} from './commands'

describe('tableToYamlObjectsText', () => {
  it('converts simple table to yaml list', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n'
    const out = tableToYamlObjectsText(src)
    expect(out).toContain('```yaml')
    expect(out).toMatch(/^-$/m)
    expect(out).toContain('a: 1')
    expect(out).toContain('b: 4')
  })

  it('returns source if no table', () => {
    expect(tableToYamlObjectsText('foo\nbar\n')).toBe('foo\nbar\n')
  })
})

describe('stripWikilinkAliasesText', () => {
  it('removes alias', () => {
    expect(stripWikilinkAliasesText('see [[foo|FOO]] here')).toBe('see [[foo]] here')
  })

  it('keeps plain wikilink', () => {
    expect(stripWikilinkAliasesText('see [[foo]] here')).toBe('see [[foo]] here')
  })
})

describe('headingsToNestedListText', () => {
  it('indents by heading depth', () => {
    const src = '# A\n## B\n### C\nbody\n'
    const out = headingsToNestedListText(src)
    expect(out).toBe('- A\n  - B\n    - C\nbody\n')
  })

  it('preserves code fence', () => {
    const src = '```\n# H in code\n```\n'
    expect(headingsToNestedListText(src)).toBe(src)
  })
})

describe('normalizeMixedIndentText', () => {
  it('converts tabs to 2 spaces', () => {
    expect(normalizeMixedIndentText('\tfoo\n  bar\n')).toBe('  foo\n  bar\n')
  })

  it('keeps non-indented lines', () => {
    expect(normalizeMixedIndentText('hello\nworld\n')).toBe('hello\nworld\n')
  })
})

describe('sortTableByColumnDescText', () => {
  it('sorts column 1 desc numerically', () => {
    const src = '| n | v |\n| --- | --- |\n| 1 | 5 |\n| 2 | 9 |\n| 3 | 1 |\n'
    const out = sortTableByColumnDescText(src, 1)
    const lines = out.trim().split('\n')
    expect(lines[2]).toBe('| 2 | 9 |')
    expect(lines[3]).toBe('| 1 | 5 |')
    expect(lines[4]).toBe('| 3 | 1 |')
  })
})

describe('inferFilenameFromH1Text', () => {
  it('returns slug of first H1', () => {
    expect(inferFilenameFromH1Text('# Hello World\n')).toBe('Hello_World')
  })

  it('strips invalid path chars', () => {
    expect(inferFilenameFromH1Text('# a / b * c\n')).toBe('a_b_c')
  })

  it('returns null when no H1', () => {
    expect(inferFilenameFromH1Text('## only h2\n')).toBe(null)
  })
})

describe('inlineCodeToWikilinkText', () => {
  it('converts inline code to wikilink', () => {
    expect(inlineCodeToWikilinkText('use `foo` here')).toBe('use [[foo]] here')
  })

  it('preserves fenced code', () => {
    const src = '```\n`x` is code\n```\n'
    expect(inlineCodeToWikilinkText(src)).toBe(src)
  })
})

import {
  splitParagraphsBySentenceCountText,
  reverseListBlockText,
  flipTableHeaderToFirstColText,
  boldNumericInHeadingsText,
  fillImageAltFromBasenameText,
  boldNumericToSupText,
} from './commands'

describe('splitParagraphsBySentenceCountText', () => {
  it('splits 4 sentences into pairs', () => {
    const src = 'A. B. C. D.\n'
    const out = splitParagraphsBySentenceCountText(src, 2)
    expect(out).toBe('A. B.\n\nC. D.\n')
  })

  it('leaves single-sentence paragraphs alone', () => {
    const src = 'Only one.\n'
    expect(splitParagraphsBySentenceCountText(src, 2)).toBe(src)
  })

  it('skips list items', () => {
    const src = '- a. b. c. d.\n'
    expect(splitParagraphsBySentenceCountText(src, 2)).toBe(src)
  })
})

describe('reverseListBlockText', () => {
  it('reverses a single bullet block', () => {
    expect(reverseListBlockText('- a\n- b\n- c\n')).toBe('- c\n- b\n- a\n')
  })

  it('keeps surrounding text intact', () => {
    const src = 'before\n- a\n- b\nafter\n'
    expect(reverseListBlockText(src)).toBe('before\n- b\n- a\nafter\n')
  })

  it('preserves fenced code', () => {
    const src = '```\n- a\n- b\n```\n'
    expect(reverseListBlockText(src)).toBe(src)
  })
})

describe('flipTableHeaderToFirstColText', () => {
  it('rotates 2x2 table into 2-row transpose', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const out = flipTableHeaderToFirstColText(src)
    const lines = out.trim().split('\n')
    expect(lines[0].includes('a')).toBe(true)
    expect(lines[0].includes('1')).toBe(true)
    expect(lines[lines.length - 1].includes('b')).toBe(true)
    expect(lines[lines.length - 1].includes('2')).toBe(true)
  })
})

describe('boldNumericInHeadingsText', () => {
  it('bolds 1.2 prefix in heading', () => {
    expect(boldNumericInHeadingsText('## 1.2 Title\n')).toBe('## **1.2** Title\n')
  })

  it('leaves non-heading numbers alone', () => {
    expect(boldNumericInHeadingsText('1.2 paragraph\n')).toBe('1.2 paragraph\n')
  })
})

describe('fillImageAltFromBasenameText', () => {
  it('fills alt from filename without ext', () => {
    expect(fillImageAltFromBasenameText('![](my-cat.png)')).toBe('![my cat](my-cat.png)')
  })

  it('handles paths', () => {
    expect(fillImageAltFromBasenameText('![](dir/icon_settings.svg)')).toBe(
      '![icon settings](dir/icon_settings.svg)',
    )
  })

  it('leaves filled alt alone', () => {
    expect(fillImageAltFromBasenameText('![Already](x.png)')).toBe('![Already](x.png)')
  })
})

describe('boldNumericToSupText', () => {
  it('converts bold numeric to <sup>', () => {
    expect(boldNumericToSupText('E=mc**2**')).toBe('E=mc<sup>2</sup>')
  })

  it('leaves bold text alone', () => {
    expect(boldNumericToSupText('**hello**')).toBe('**hello**')
  })
})

import {
  renameHierarchicalTagText,
  listToTaskListText,
  markAllTasksDoneText,
  escapeHtmlInCodeBlocksText,
  ensureBlankBeforeHeadingsText,
  collapseBlankLinesText,
} from './commands'

describe('renameHierarchicalTagText', () => {
  it('renames a/b to a/c', () => {
    expect(renameHierarchicalTagText('see #a/b here', 'a/b', 'a/c')).toBe('see #a/c here')
  })

  it('does not rename prefix match', () => {
    expect(renameHierarchicalTagText('#abc and #a', 'a', 'x')).toBe('#abc and #x')
  })
})

describe('listToTaskListText', () => {
  it('converts bullets to tasks', () => {
    expect(listToTaskListText('- a\n- b\n')).toBe('- [ ] a\n- [ ] b\n')
  })

  it('converts ordered items too', () => {
    expect(listToTaskListText('1. one\n2. two\n')).toBe('- [ ] one\n- [ ] two\n')
  })
})

describe('markAllTasksDoneText', () => {
  it('checks every unchecked task', () => {
    expect(markAllTasksDoneText('- [ ] a\n- [ ] b\n')).toBe('- [x] a\n- [x] b\n')
  })

  it('leaves done tasks alone', () => {
    expect(markAllTasksDoneText('- [x] a\n')).toBe('- [x] a\n')
  })
})

describe('escapeHtmlInCodeBlocksText', () => {
  it('escapes < > & inside fence', () => {
    const src = '```html\n<div>&amp;</div>\n```\n'
    const out = escapeHtmlInCodeBlocksText(src)
    expect(out).toContain('&lt;div&gt;')
    expect(out).toContain('&amp;amp;')
  })

  it('leaves non-fence text alone', () => {
    expect(escapeHtmlInCodeBlocksText('<a>')).toBe('<a>')
  })
})

describe('ensureBlankBeforeHeadingsText', () => {
  it('inserts blank line before heading when missing', () => {
    expect(ensureBlankBeforeHeadingsText('foo\n## bar\n')).toBe('foo\n\n## bar\n')
  })

  it('preserves existing blank', () => {
    expect(ensureBlankBeforeHeadingsText('foo\n\n## bar\n')).toBe('foo\n\n## bar\n')
  })
})

describe('collapseBlankLinesText', () => {
  it('collapses 3+ blanks to 2', () => {
    expect(collapseBlankLinesText('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('leaves single blank alone', () => {
    expect(collapseBlankLinesText('a\n\nb')).toBe('a\n\nb')
  })
})

import {
  linkifyIssueRefsText,
  boldToItalicText,
  italicToBoldText,
  sortParagraphsByLengthText,
  reverseTableRowsText,
  tabsToSpacesInCodeText,
  removeEmptyHeadingsText,
  imagesToCaptionedBlockText,
} from './commands'

describe('linkifyIssueRefsText', () => {
  it('converts #123 to markdown link', () => {
    expect(linkifyIssueRefsText('see #42 today', 'https://gh/repo/issues/')).toBe(
      'see [#42](https://gh/repo/issues/42) today',
    )
  })

  it('skips fenced code', () => {
    const src = '```\n#42\n```\n'
    expect(linkifyIssueRefsText(src, 'https://x/')).toBe(src)
  })
})

describe('boldToItalicText', () => {
  it('converts ** to *', () => {
    expect(boldToItalicText('**foo** and **bar**')).toBe('*foo* and *bar*')
  })
})

describe('italicToBoldText', () => {
  it('converts standalone * to **', () => {
    expect(italicToBoldText('hello *world*')).toBe('hello **world**')
  })

  it('does not double-convert bold', () => {
    expect(italicToBoldText('**already**')).toBe('**already**')
  })
})

describe('sortParagraphsByLengthText', () => {
  it('sorts by length ascending', () => {
    const src = 'longer one here\n\nshort\n\nmedium one'
    const out = sortParagraphsByLengthText(src)
    expect(out.startsWith('short')).toBe(true)
    expect(out.endsWith('longer one here')).toBe(true)
  })
})

describe('reverseTableRowsText', () => {
  it('reverses body but keeps header', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n| 3 | z |\n'
    const out = reverseTableRowsText(src)
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('| a | b |')
    expect(lines[2]).toBe('| 3 | z |')
    expect(lines[4]).toBe('| 1 | x |')
  })
})

describe('tabsToSpacesInCodeText', () => {
  it('replaces tabs inside code fence', () => {
    const src = '```js\n\tconst x = 1\n```\n'
    expect(tabsToSpacesInCodeText(src, 4)).toBe('```js\n    const x = 1\n```\n')
  })

  it('leaves outside text alone', () => {
    expect(tabsToSpacesInCodeText('\tplain\n')).toBe('\tplain\n')
  })
})

describe('removeEmptyHeadingsText', () => {
  it('removes empty heading line', () => {
    expect(removeEmptyHeadingsText('# \nbody\n')).toBe('body\n')
  })

  it('keeps non-empty heading', () => {
    expect(removeEmptyHeadingsText('# Title\n')).toBe('# Title\n')
  })
})

describe('imagesToCaptionedBlockText', () => {
  it('appends caption after image', () => {
    const out = imagesToCaptionedBlockText('![cat](cat.png)')
    expect(out).toContain('![cat](cat.png)')
    expect(out).toContain('<small><em>cat</em></small>')
  })
})

import {
  expandWikilinkToAliasText,
  dedupTaskLinesText,
  mp4LinkToVideoEmbedText,
  reindentSpaceWidthText,
  capitalizeSentencesAsciiText,
  unicodeArrowsText,
  inlineFootnotesV2Text,
} from './commands'

describe('expandWikilinkToAliasText', () => {
  it('adds alias', () => {
    expect(expandWikilinkToAliasText('see [[Foo]]')).toBe('see [[Foo|Foo]]')
  })

  it('leaves already-aliased alone', () => {
    expect(expandWikilinkToAliasText('see [[Foo|Bar]]')).toBe('see [[Foo|Bar]]')
  })
})

describe('dedupTaskLinesText', () => {
  it('removes duplicate task', () => {
    const src = '- [ ] a\n- [ ] a\n- [x] b\n'
    expect(dedupTaskLinesText(src)).toBe('- [ ] a\n- [x] b\n')
  })

  it('keeps different tasks', () => {
    const src = '- [ ] a\n- [ ] b\n'
    expect(dedupTaskLinesText(src)).toBe(src)
  })
})

describe('mp4LinkToVideoEmbedText', () => {
  it('converts mp4 link to <video>', () => {
    const out = mp4LinkToVideoEmbedText('[clip](https://x.com/a.mp4)')
    expect(out).toContain('<video controls src="https://x.com/a.mp4"')
  })

  it('leaves non-mp4 alone', () => {
    expect(mp4LinkToVideoEmbedText('[x](y.png)')).toBe('[x](y.png)')
  })
})

describe('reindentSpaceWidthText', () => {
  it('expands 2-space to 4-space', () => {
    expect(reindentSpaceWidthText('  foo\n    bar\n', 2, 4)).toBe('    foo\n        bar\n')
  })

  it('shrinks 4-space to 2-space', () => {
    expect(reindentSpaceWidthText('    foo\n', 4, 2)).toBe('  foo\n')
  })

  it('no-op when from === to', () => {
    expect(reindentSpaceWidthText('  x', 2, 2)).toBe('  x')
  })
})

describe('capitalizeSentencesAsciiText', () => {
  it('caps first letter of each sentence', () => {
    expect(capitalizeSentencesAsciiText('hello. world. how are you?')).toBe(
      'Hello. World. How are you?',
    )
  })

  it('does not touch CJK', () => {
    const source = String.fromCodePoint(0x4f60, 0x597d, 0x3002, 0x4e16, 0x754c, 0x3002)
    expect(capitalizeSentencesAsciiText(source)).toBe(source)
  })
})

describe('unicodeArrowsText', () => {
  it('converts -> to →', () => {
    expect(unicodeArrowsText('a -> b')).toBe('a → b')
  })

  it('converts => to ⇒', () => {
    expect(unicodeArrowsText('a => b')).toBe('a ⇒ b')
  })
})

describe('inlineFootnotesV2Text', () => {
  it('inlines footnote ref into body', () => {
    const src = 'see x[^1]\n\n[^1]: a note'
    const out = inlineFootnotesV2Text(src)
    expect(out).toContain('see x (a note)')
    expect(out).not.toContain('[^1]')
  })
})

import {
  orderedListToAsciiTreeText,
  doubleNewlineToBrText,
  sortFrontmatterArrayFieldText,
  autoTagByFilenameText,
  splitTableByRowCountText,
} from './commands'

describe('orderedListToAsciiTreeText', () => {
  it('uses └── for last item', () => {
    const out = orderedListToAsciiTreeText('1. a\n2. b\n3. c\n')
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('├── a')
    expect(lines[1]).toBe('├── b')
    expect(lines[2]).toBe('└── c')
  })

  it('handles nested indentation', () => {
    const out = orderedListToAsciiTreeText('1. a\n  1. b\n2. c\n')
    expect(out).toContain('├── a')
    expect(out).toContain('    └── b')
    expect(out).toContain('└── c')
  })
})

describe('doubleNewlineToBrText', () => {
  it('converts blank line to <br>', () => {
    expect(doubleNewlineToBrText('foo\n\nbar')).toBe('foo\n<br>\nbar')
  })

  it('preserves code fence content', () => {
    const src = 'pre\n\n```\n\n\n```\npost\n'
    const out = doubleNewlineToBrText(src)
    expect(out).toContain('```\n\n\n```')
  })
})

describe('sortFrontmatterArrayFieldText', () => {
  it('sorts inline array', () => {
    const src = '---\ntags: [c, a, b]\n---\nbody\n'
    const out = sortFrontmatterArrayFieldText(src, 'tags')
    expect(out).toContain('tags: [a, b, c]')
  })

  it('sorts block list', () => {
    const src = '---\ntags:\n  - c\n  - a\n  - b\n---\nbody\n'
    const out = sortFrontmatterArrayFieldText(src, 'tags')
    expect(out).toContain('  - a\n  - b\n  - c')
  })
})

describe('autoTagByFilenameText', () => {
  it('adds tag from filename prefix', () => {
    const out = autoTagByFilenameText('body', 'proj-foo.md')
    expect(out).toContain('tags: [proj]')
  })

  it('does not double-add tag', () => {
    const src = '---\ntags: [proj]\n---\nbody\n'
    expect(autoTagByFilenameText(src, 'proj-x.md')).toBe(src)
  })
})

describe('splitTableByRowCountText', () => {
  it('splits 5 rows into 3+2', () => {
    const src = '| n |\n| --- |\n| 1 |\n| 2 |\n| 3 |\n| 4 |\n| 5 |\n'
    const out = splitTableByRowCountText(src, 3)
    expect(out.match(/\| --- \|/g)?.length).toBe(2)
  })

  it('leaves small tables alone', () => {
    const src = '| n |\n| --- |\n| 1 |\n'
    expect(splitTableByRowCountText(src, 5)).toBe(src)
  })
})

import {
  relativeMdLinksToWikilinkText,
  sortH2SectionsAlphaText,
  setextToAtxText,
  dedupBulletListText,
  renumberOrderedListsFromOneText,
} from './commands'

describe('relativeMdLinksToWikilinkText', () => {
  it('converts relative .md link to wikilink', () => {
    expect(relativeMdLinksToWikilinkText('see [hi](foo.md)')).toContain('[[foo|hi]]')
  })

  it('leaves external links alone', () => {
    const src = '[g](https://x.com)'
    expect(relativeMdLinksToWikilinkText(src)).toBe(src)
  })

  it('skips inside fence', () => {
    const src = '```\n[a](b.md)\n```'
    expect(relativeMdLinksToWikilinkText(src)).toBe(src)
  })
})

describe('sortH2SectionsAlphaText', () => {
  it('sorts H2 sections by title', () => {
    const src = '# Title\nintro\n\n## B\nbody-b\n\n## A\nbody-a\n'
    const out = sortH2SectionsAlphaText(src)
    expect(out.indexOf('## A')).toBeLessThan(out.indexOf('## B'))
  })

  it('preserves preamble', () => {
    const src = 'pre\n## Z\nz\n## A\na\n'
    expect(sortH2SectionsAlphaText(src).startsWith('pre\n')).toBe(true)
  })
})

describe('setextToAtxText', () => {
  it('converts H1 setext', () => {
    const src = 'Title\n=====\nbody\n'
    expect(setextToAtxText(src)).toContain('# Title')
  })

  it('converts H2 setext', () => {
    const src = 'Sub\n---\nbody\n'
    expect(setextToAtxText(src)).toContain('## Sub')
  })

  it('leaves frontmatter separator alone', () => {
    const src = '---\nkey: v\n---\nbody\n'
    expect(setextToAtxText(src)).toBe(src)
  })
})

describe('dedupBulletListText', () => {
  it('removes duplicate bullets', () => {
    const src = '- a\n- a\n- b\n'
    const out = dedupBulletListText(src)
    expect(out.match(/- a/g)?.length).toBe(1)
  })

  it('keeps non-bullet duplicates', () => {
    const src = 'word\nword\n'
    expect(dedupBulletListText(src)).toBe(src)
  })
})

describe('renumberOrderedListsFromOneText', () => {
  it('renumbers from 1', () => {
    const src = '5. a\n6. b\n7. c\n'
    expect(renumberOrderedListsFromOneText(src)).toContain('1. a')
  })
})

import {
  rewrapBlockquotesText,
  promoteAllHeadingsText,
  demoteAllHeadingsText,
  orderedListToChecklistText,
  checklistToOrderedText,
  collapseDuplicateHeadingsText,
  wikilinkToFullMdLinkText,
  padFencedCodeBlocksText,
} from './commands'

describe('rewrapBlockquotesText', () => {
  it('merges multi-line blockquote', () => {
    const src = '> hello\n> world\n'
    expect(rewrapBlockquotesText(src)).toContain('> hello world')
  })

  it('preserves non-quote lines', () => {
    const src = '> a\n> b\n\nparagraph\n'
    const out = rewrapBlockquotesText(src)
    expect(out).toContain('> a b')
    expect(out).toContain('paragraph')
  })

  it('skips inside fence', () => {
    const src = '```\n> a\n> b\n```'
    expect(rewrapBlockquotesText(src)).toBe(src)
  })
})

describe('promoteAllHeadingsText', () => {
  it('demotes by adding #', () => {
    expect(promoteAllHeadingsText('# A\n')).toContain('## A')
  })

  it('caps at H6', () => {
    expect(promoteAllHeadingsText('###### A\n')).toContain('###### A')
  })
})

describe('demoteAllHeadingsText', () => {
  it('promotes by removing #', () => {
    expect(demoteAllHeadingsText('## A\n')).toContain('# A')
  })

  it('leaves H1 alone', () => {
    expect(demoteAllHeadingsText('# A\n')).toBe('# A\n')
  })
})

describe('orderedListToChecklistText', () => {
  it('converts numbered to task', () => {
    const src = '1. a\n2. b\n'
    const out = orderedListToChecklistText(src)
    expect(out).toContain('- [ ] a')
    expect(out).toContain('- [ ] b')
  })

  it('preserves indent', () => {
    expect(orderedListToChecklistText('  1. a\n')).toContain('  - [ ] a')
  })
})

describe('checklistToOrderedText', () => {
  it('converts task to numbered', () => {
    const src = '- [ ] a\n- [ ] b\n'
    const out = checklistToOrderedText(src)
    expect(out).toContain('1. a')
    expect(out).toContain('2. b')
  })

  it('resets on blank line', () => {
    const src = '- [ ] a\n\n- [ ] x\n'
    const out = checklistToOrderedText(src)
    expect(out).toContain('1. a')
    expect(out).toContain('1. x')
  })
})

describe('collapseDuplicateHeadingsText', () => {
  it('removes adjacent duplicates', () => {
    const src = '## A\n## A\nbody\n'
    expect(collapseDuplicateHeadingsText(src).match(/## A/g)?.length).toBe(1)
  })

  it('keeps different headings', () => {
    const src = '## A\n## B\n'
    expect(collapseDuplicateHeadingsText(src)).toBe(src)
  })
})

describe('wikilinkToFullMdLinkText', () => {
  it('converts plain wikilink', () => {
    expect(wikilinkToFullMdLinkText('[[Foo]]')).toBe('[Foo](Foo.md)')
  })

  it('handles alias', () => {
    expect(wikilinkToFullMdLinkText('[[Foo|bar]]')).toBe('[bar](Foo.md)')
  })

  it('skips fence', () => {
    const src = '```\n[[Foo]]\n```'
    expect(wikilinkToFullMdLinkText(src)).toBe(src)
  })
})

describe('padFencedCodeBlocksText', () => {
  it('adds blank before fence', () => {
    const src = 'text\n```\nfoo\n```\n'
    expect(padFencedCodeBlocksText(src)).toContain('text\n\n```')
  })

  it('leaves padded fence alone', () => {
    const src = 'text\n\n```\nfoo\n```\n\nrest\n'
    const out = padFencedCodeBlocksText(src)
    expect(out.match(/\n\n```\n/g)?.length).toBe(1)
  })
})

import {
  mergeAdjacentTablesText,
  sortFmKeysAlphaV2Text,
  blockquoteToCalloutNoteText,
  priorityMarkersToWarningText,
  stripWikilinksText,
} from './commands'

describe('mergeAdjacentTablesText', () => {
  it('merges two same-column tables', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| a | b |\n| --- | --- |\n| 3 | 4 |\n'
    const out = mergeAdjacentTablesText(src)
    expect(out.match(/\| --- \| --- \|/g)?.length).toBe(1)
    expect(out).toContain('| 1 | 2 |')
    expect(out).toContain('| 3 | 4 |')
  })

  it('leaves different-column tables alone', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| a |\n| --- |\n| 3 |\n'
    expect(mergeAdjacentTablesText(src).match(/\| --- /g)?.length).toBe(3)
  })
})

describe('sortFmKeysAlphaV2Text', () => {
  it('sorts keys alpha', () => {
    const src = '---\nb: 2\na: 1\n---\nbody\n'
    const out = sortFmKeysAlphaV2Text(src)
    expect(out.indexOf('a:')).toBeLessThan(out.indexOf('b:'))
  })

  it('no frontmatter is noop', () => {
    expect(sortFmKeysAlphaV2Text('body\n')).toBe('body\n')
  })
})

describe('blockquoteToCalloutNoteText', () => {
  it('prepends [!note] header', () => {
    const src = '> hi\n> world\n'
    expect(blockquoteToCalloutNoteText(src)).toContain('> [!note]')
  })

  it('leaves existing callouts alone', () => {
    const src = '> [!warning]\n> hi\n'
    expect(blockquoteToCalloutNoteText(src)).toBe(src)
  })
})

describe('priorityMarkersToWarningText', () => {
  it('converts [!] task', () => {
    expect(priorityMarkersToWarningText('- [!] do it\n')).toContain('⚠️')
  })

  it('leaves normal tasks alone', () => {
    expect(priorityMarkersToWarningText('- [ ] x\n')).toBe('- [ ] x\n')
  })
})

describe('stripWikilinksText', () => {
  it('strips plain wikilink', () => {
    expect(stripWikilinksText('see [[Foo]]')).toBe('see Foo')
  })

  it('uses alias', () => {
    expect(stripWikilinksText('see [[Foo|bar]]')).toBe('see bar')
  })

  it('skips fences', () => {
    const src = '```\n[[Foo]]\n```'
    expect(stripWikilinksText(src)).toBe(src)
  })
})

import {
  wrapParagraphsHtmlText,
  addHeadingStatusBadgeText,
  orderedListToWikilinkListText,
  stripEmphasisText,
  listToDefinitionListText,
} from './commands'

describe('wrapParagraphsHtmlText', () => {
  it('wraps paragraph in <p>', () => {
    const src = 'hello world\n'
    expect(wrapParagraphsHtmlText(src)).toContain('<p>hello world</p>')
  })

  it('skips headings', () => {
    const src = '# Title\n'
    expect(wrapParagraphsHtmlText(src)).toBe(src)
  })

  it('skips lists', () => {
    const src = '- a\n- b\n'
    expect(wrapParagraphsHtmlText(src)).toBe(src)
  })
})

describe('addHeadingStatusBadgeText', () => {
  it('adds badge to heading', () => {
    const src = '# Hi\n'
    expect(addHeadingStatusBadgeText(src, 'todo')).toContain('# [TODO] Hi')
  })

  it('skips if already badged', () => {
    const src = '# [TODO] Hi\n'
    expect(addHeadingStatusBadgeText(src, 'todo')).toBe(src)
  })
})

describe('orderedListToWikilinkListText', () => {
  it('converts ordered to wikilink list', () => {
    const src = '1. Foo\n2. Bar\n'
    const out = orderedListToWikilinkListText(src)
    expect(out).toContain('- [[Foo]]')
    expect(out).toContain('- [[Bar]]')
  })
})

describe('stripEmphasisText', () => {
  it('strips bold', () => {
    expect(stripEmphasisText('**hi**')).toBe('hi')
  })

  it('strips italic', () => {
    expect(stripEmphasisText('*hi*')).toBe('hi')
  })

  it('strips underscore italic', () => {
    expect(stripEmphasisText('_hi_')).toBe('hi')
  })
})

describe('listToDefinitionListText', () => {
  it('converts list to def list', () => {
    const src = '- foo: bar\n- baz: qux\n'
    const out = listToDefinitionListText(src)
    expect(out).toContain('foo')
    expect(out).toContain(': bar')
  })
})

import {
  appendTagToParagraphsText,
  boldifyTagsText,
  asciiTasksToUnicodeText,
  checkedTaskToEmojiText,
  groupH3UnderH2DetailsText,
} from './commands'

describe('appendTagToParagraphsText', () => {
  it('appends tag to last line of paragraph', () => {
    const src = 'hello\nworld\n'
    expect(appendTagToParagraphsText(src, 'todo')).toContain('world #todo')
  })

  it('skips already tagged', () => {
    const src = 'hello #todo\n'
    expect(appendTagToParagraphsText(src, 'todo')).toBe(src)
  })

  it('skips headings', () => {
    const src = '# Title\n'
    expect(appendTagToParagraphsText(src, 'todo')).toBe(src)
  })
})

describe('boldifyTagsText', () => {
  it('bolds standalone tag', () => {
    expect(boldifyTagsText('see #foo here')).toContain('**#foo**')
  })

  it('skips inside fence', () => {
    const src = '```\n#foo\n```'
    expect(boldifyTagsText(src)).toBe(src)
  })
})

describe('asciiTasksToUnicodeText', () => {
  it('converts unchecked', () => {
    expect(asciiTasksToUnicodeText('- [ ] do x\n')).toContain('☐ do x')
  })

  it('converts checked', () => {
    expect(asciiTasksToUnicodeText('- [x] done\n')).toContain('☒ done')
  })
})

describe('checkedTaskToEmojiText', () => {
  it('converts checked', () => {
    expect(checkedTaskToEmojiText('- [x] done\n')).toContain('- ✅ done')
  })

  it('leaves unchecked alone', () => {
    expect(checkedTaskToEmojiText('- [ ] x\n')).toBe('- [ ] x\n')
  })
})

describe('groupH3UnderH2DetailsText', () => {
  it('wraps h3 in details', () => {
    const src = '## A\n### B\nbody\n'
    const out = groupH3UnderH2DetailsText(src)
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>B</summary>')
    expect(out).toContain('</details>')
  })

  it('leaves h2 only alone', () => {
    const src = '## A\nbody\n'
    expect(groupH3UnderH2DetailsText(src)).toBe(src)
  })
})

import {
  annotateHeadingsWithProgressText,
  tagsToWikilinkText,
  asciiSymbolsToUnicodeText,
} from './commands'

describe('annotateHeadingsWithProgressText', () => {
  it('adds done/total counts', () => {
    const src = '## A\n- [x] x\n- [ ] y\n'
    expect(annotateHeadingsWithProgressText(src)).toContain('## A (1/2)')
  })

  it('skips sections with no tasks', () => {
    expect(annotateHeadingsWithProgressText('## A\nbody\n')).toBe('## A\nbody\n')
  })

  it('does not double-annotate', () => {
    const src = '## A (1/2)\n- [x] x\n- [ ] y\n'
    expect(annotateHeadingsWithProgressText(src)).toBe(src)
  })
})

describe('tagsToWikilinkText', () => {
  it('converts standalone tag', () => {
    expect(tagsToWikilinkText('see #foo here')).toBe('see [[foo]] here')
  })

  it('skips headings', () => {
    expect(tagsToWikilinkText('# Title\n')).toBe('# Title\n')
  })

  it('skips inside fence', () => {
    const src = '```\n#foo\n```'
    expect(tagsToWikilinkText(src)).toBe(src)
  })
})

describe('asciiSymbolsToUnicodeText', () => {
  it('converts (c) to ©', () => {
    expect(asciiSymbolsToUnicodeText('(c) 2026')).toContain('©')
  })

  it('converts (tm)', () => {
    expect(asciiSymbolsToUnicodeText('Brand(tm)')).toContain('™')
  })

  it('converts ...', () => {
    expect(asciiSymbolsToUnicodeText('wait...')).toContain('…')
  })
})

import {
  appendTableColumnStatsText,
  listToOutlinerText,
  urlsToWikilinkText,
  sentencesPerLineText,
  stripHtmlTagsText,
} from './commands'

describe('appendTableColumnStatsText', () => {
  it('appends stats line after table', () => {
    const src = '| a | b |\n| --- | --- |\n| x | 1 |\n| y | 2 |\n| z | 3 |'
    const out = appendTableColumnStatsText(src, 1)
    expect(out).toContain('sum: 6')
    expect(out).toContain('avg: 2.00')
    expect(out).toContain('min: 1')
    expect(out).toContain('max: 3')
  })

  it('ignores tables with no numeric values in column', () => {
    const src = '| a | b |\n| --- | --- |\n| x | foo |\n| y | bar |'
    expect(appendTableColumnStatsText(src, 1)).toBe(src)
  })

  it('leaves non-table content alone', () => {
    expect(appendTableColumnStatsText('# Heading\n\nparagraph', 0)).toBe('# Heading\n\nparagraph')
  })
})

describe('listToOutlinerText', () => {
  it('numbers a flat list 1, 2, 3', () => {
    const out = listToOutlinerText('- a\n- b\n- c')
    expect(out).toContain('1. a')
    expect(out).toContain('2. b')
    expect(out).toContain('3. c')
  })

  it('numbers nested children with dotted path', () => {
    const out = listToOutlinerText('- a\n  - a.1\n  - a.2\n- b')
    expect(out).toContain('1. a')
    expect(out).toContain('1.1. a.1')
    expect(out).toContain('1.2. a.2')
    expect(out).toContain('2. b')
  })

  it('skips fenced code', () => {
    const src = '```\n- a\n- b\n```'
    expect(listToOutlinerText(src)).toBe(src)
  })
})

describe('urlsToWikilinkText', () => {
  it('wraps bare URL in wikilink syntax', () => {
    const out = urlsToWikilinkText('see https://example.com here')
    expect(out).toContain('[[https://example.com]]')
  })

  it('handles multiple URLs in a line', () => {
    const out = urlsToWikilinkText('a https://a.com and https://b.com end')
    expect(out).toContain('[[https://a.com]]')
    expect(out).toContain('[[https://b.com]]')
  })

  it('skips inside fence', () => {
    const src = '```\nhttps://x.com\n```'
    expect(urlsToWikilinkText(src)).toBe(src)
  })
})

describe('sentencesPerLineText', () => {
  it('splits paragraph on sentence boundary', () => {
    const out = sentencesPerLineText('Hello world. This is fine. End.')
    const parts = out.split('\n')
    expect(parts.length).toBeGreaterThanOrEqual(3)
  })

  it('leaves list lines alone', () => {
    const src = '- one. two.\n- three.'
    expect(sentencesPerLineText(src)).toBe(src)
  })

  it('leaves headings alone', () => {
    expect(sentencesPerLineText('# Hi. Bye.')).toBe('# Hi. Bye.')
  })
})

describe('stripHtmlTagsText', () => {
  it('removes simple inline tags', () => {
    expect(stripHtmlTagsText('Hello <b>world</b>')).toBe('Hello world')
  })

  it('removes nested tags', () => {
    expect(stripHtmlTagsText('<div><span>x</span></div>')).toBe('x')
  })

  it('skips inside fence', () => {
    const src = '```\n<b>kept</b>\n```'
    expect(stripHtmlTagsText(src)).toBe(src)
  })
})

import {
  emojiShortcodesText,
  unifyBulletDashText,
  tableColToWikilinkText,
  dedupAdjacentParagraphsV2Text,
  footnotesToInlineText,
} from './commands'

describe('emojiShortcodesText', () => {
  it('converts :smile: to emoji', () => {
    expect(emojiShortcodesText('Hello :smile:')).toContain('😄')
  })

  it('converts multiple shortcodes', () => {
    const out = emojiShortcodesText(':fire: and :rocket:')
    expect(out).toContain('🔥')
    expect(out).toContain('🚀')
  })

  it('keeps unknown shortcodes intact', () => {
    expect(emojiShortcodesText(':nonexistent:')).toBe(':nonexistent:')
  })

  it('skips inside inline code', () => {
    expect(emojiShortcodesText('`:fire:`')).toBe('`:fire:`')
  })

  it('skips inside fence', () => {
    const src = '```\n:smile:\n```'
    expect(emojiShortcodesText(src)).toBe(src)
  })
})

describe('unifyBulletDashText', () => {
  it('converts * to -', () => {
    expect(unifyBulletDashText('* a\n* b')).toBe('- a\n- b')
  })

  it('converts + to -', () => {
    expect(unifyBulletDashText('+ a\n+ b')).toBe('- a\n- b')
  })

  it('preserves indented bullets', () => {
    expect(unifyBulletDashText('  * a')).toBe('  - a')
  })

  it('skips inside fence', () => {
    const src = '```\n* a\n```'
    expect(unifyBulletDashText(src)).toBe(src)
  })
})

describe('tableColToWikilinkText', () => {
  it('wraps column cells in wikilinks', () => {
    const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
    const out = tableColToWikilinkText(src, 0)
    expect(out).toContain('[[Alice]]')
    expect(out).toContain('[[Bob]]')
  })

  it('skips already-wikilinked cells', () => {
    const src = '| Name | Age |\n| --- | --- |\n| [[Alice]] | 30 |'
    const out = tableColToWikilinkText(src, 0)
    expect((out.match(/\[\[Alice\]\]/g) ?? []).length).toBe(1)
  })

  it('leaves non-table content alone', () => {
    expect(tableColToWikilinkText('# H\n\npara', 0)).toBe('# H\n\npara')
  })
})

describe('dedupAdjacentParagraphsV2Text', () => {
  it('removes consecutive identical paragraphs', () => {
    const out = dedupAdjacentParagraphsV2Text('Hello\n\nHello\n\nWorld')
    const parts = out.split('\n\n')
    expect(parts.filter((p) => p === 'Hello').length).toBe(1)
  })

  it('keeps distinct paragraphs', () => {
    const out = dedupAdjacentParagraphsV2Text('A\n\nB\n\nC')
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).toContain('C')
  })

  it('preserves non-adjacent duplicates', () => {
    const out = dedupAdjacentParagraphsV2Text('A\n\nB\n\nA')
    expect((out.match(/A/g) ?? []).length).toBe(2)
  })
})

describe('footnotesToInlineText', () => {
  it('inlines footnote definitions', () => {
    const src = 'Hello[^1].\n\n[^1]: world definition'
    const out = footnotesToInlineText(src)
    expect(out).toContain('(world definition)')
    expect(out).not.toContain('[^1]:')
  })

  it('keeps reference if no definition', () => {
    const src = 'Hello[^missing].'
    expect(footnotesToInlineText(src)).toContain('[^missing]')
  })
})

import {
  computeReadingProfileText,
  reverseOutlineText,
  checklistToDefinitionListText,
  markLongParagraphsText,
  boldifyRfcKeywordsText,
  frontmatterDatesToIsoText,
  renameTableColumnText,
  sortTasksByPriorityEmojiText,
} from './commands'

describe('computeReadingProfileText', () => {
  it('counts words/chars/sentences/paragraphs', () => {
    const src = 'Hello world. This is fine.\n\nSecond para here.'
    const out = computeReadingProfileText(src)
    expect(out).toContain('| Words |')
    expect(out).toContain('| Paragraphs | 2 |')
  })

  it('skips fenced code', () => {
    const src = 'paragraph\n\n```\nignored code here\n```'
    const out = computeReadingProfileText(src)
    expect(out).toContain('| Paragraphs | 1 |')
  })
})

describe('reverseOutlineText', () => {
  it('extracts headings as nested list', () => {
    const src = '# A\n\n## B\n\n### C'
    const out = reverseOutlineText(src)
    expect(out).toContain('- A')
    expect(out).toContain('  - B')
    expect(out).toContain('    - C')
  })

  it('skips headings inside fence', () => {
    const src = '```\n# nope\n```'
    expect(reverseOutlineText(src)).toBe('')
  })
})

describe('checklistToDefinitionListText', () => {
  it('converts term :: def', () => {
    const out = checklistToDefinitionListText('- [ ] term :: definition here')
    expect(out).toContain('term')
    expect(out).toContain(': definition here')
  })

  it('leaves non-pattern lines alone', () => {
    expect(checklistToDefinitionListText('- [ ] plain task')).toBe('- [ ] plain task')
  })
})

describe('markLongParagraphsText', () => {
  it('flags long paragraphs', () => {
    const long = 'x'.repeat(500)
    const out = markLongParagraphsText(long, 100)
    expect(out).toContain('[!warning]')
  })

  it('leaves short paragraphs alone', () => {
    expect(markLongParagraphsText('short', 100)).toBe('short')
  })

  it('does not flag list items', () => {
    const long = '- ' + 'x'.repeat(500)
    expect(markLongParagraphsText(long, 100)).toBe(long)
  })
})

describe('boldifyRfcKeywordsText', () => {
  it('bolds MUST', () => {
    expect(boldifyRfcKeywordsText('It MUST work.')).toContain('**MUST**')
  })

  it('bolds MUST NOT before MUST', () => {
    expect(boldifyRfcKeywordsText('It MUST NOT work.')).toContain('**MUST NOT**')
  })

  it('skips inside fence', () => {
    const src = '```\nMUST not change\n```'
    expect(boldifyRfcKeywordsText(src)).toBe(src)
  })
})

describe('frontmatterDatesToIsoText', () => {
  it('converts YYYY/M/D to ISO', () => {
    const src = '---\ndate: 2026/3/5\n---\n\nbody'
    const out = frontmatterDatesToIsoText(src)
    expect(out).toContain('date: 2026-03-05')
  })

  it('pads ISO short dates', () => {
    const src = '---\ndate: 2026-3-5\n---\n\nbody'
    const out = frontmatterDatesToIsoText(src)
    expect(out).toContain('date: 2026-03-05')
  })

  it('leaves content without frontmatter alone', () => {
    expect(frontmatterDatesToIsoText('# Hi')).toBe('# Hi')
  })
})

describe('renameTableColumnText', () => {
  it('renames first column header', () => {
    const src = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const out = renameTableColumnText(src, 0, 'NewA')
    expect(out).toContain('| NewA |')
    expect(out).not.toContain('| A |')
  })

  it('leaves data rows alone', () => {
    const src = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    expect(renameTableColumnText(src, 0, 'X')).toContain('| 1 | 2 |')
  })
})

describe('sortTasksByPriorityEmojiText', () => {
  it('sorts 🔴 before 🟢', () => {
    const src = '- [ ] 🟢 low\n- [ ] 🔴 critical\n- [ ] 🟡 medium'
    const out = sortTasksByPriorityEmojiText(src)
    const idxRed = out.indexOf('🔴')
    const idxGreen = out.indexOf('🟢')
    expect(idxRed).toBeLessThan(idxGreen)
  })

  it('puts unprioritized tasks last', () => {
    const src = '- [ ] plain\n- [ ] 🔴 first'
    const out = sortTasksByPriorityEmojiText(src)
    expect(out.indexOf('🔴')).toBeLessThan(out.indexOf('plain'))
  })
})

import {
  appendTableTotalsRowText,
  bubbleUncheckedTasksTopText,
  stripAllMarkdownText,
  listToMermaidPieText,
  normalizeTableWhitespaceText,
  swapParagraphsText,
} from './commands'

describe('appendTableTotalsRowText', () => {
  it('appends row with sums', () => {
    const src = '| A | B |\n| --- | --- |\n| 1 | 10 |\n| 2 | 20 |'
    const out = appendTableTotalsRowText(src)
    expect(out).toContain('Σ3')
    expect(out).toContain('Σ30')
  })

  it('leaves rows with no numeric column with blank cell', () => {
    const src = '| A |\n| --- |\n| foo |\n| bar |'
    const out = appendTableTotalsRowText(src)
    const tableLines = out.split('\n')
    expect(tableLines[tableLines.length - 1]).toContain('|')
  })

  it('skips tables with no data rows', () => {
    const src = '| A | B |\n| --- | --- |'
    expect(appendTableTotalsRowText(src)).toBe(src)
  })
})

describe('bubbleUncheckedTasksTopText', () => {
  it('moves unchecked tasks before checked', () => {
    const src = '- [x] done\n- [ ] todo'
    const out = bubbleUncheckedTasksTopText(src)
    expect(out.indexOf('[ ]')).toBeLessThan(out.indexOf('[x]'))
  })

  it('keeps non-task content', () => {
    const src = '# Heading\n- [ ] todo'
    expect(bubbleUncheckedTasksTopText(src)).toContain('# Heading')
  })
})

describe('stripAllMarkdownText', () => {
  it('strips bold/italic/code', () => {
    expect(stripAllMarkdownText('**bold** and *italic* and `code`')).toBe('bold and italic and code')
  })

  it('strips heading marker', () => {
    expect(stripAllMarkdownText('# Title')).toBe('Title')
  })

  it('strips links to text', () => {
    expect(stripAllMarkdownText('see [name](url)')).toBe('see name')
  })

  it('strips wikilinks to display text', () => {
    expect(stripAllMarkdownText('[[file|alias]]')).toBe('alias')
  })
})

describe('listToMermaidPieText', () => {
  it('converts list to pie chart with default value 1', () => {
    const out = listToMermaidPieText('- a\n- b')
    expect(out).toContain('```mermaid')
    expect(out).toContain('pie title')
    expect(out).toContain('"a" : 1')
  })

  it('parses `: N` for values', () => {
    const out = listToMermaidPieText('- a : 30\n- b : 70')
    expect(out).toContain('"a" : 30')
    expect(out).toContain('"b" : 70')
  })
})

describe('normalizeTableWhitespaceText', () => {
  it('trims and re-adds single space', () => {
    const src = '|  a   |   b  |\n| --- | --- |'
    const out = normalizeTableWhitespaceText(src)
    expect(out.split('\n')[0]).toBe('| a | b |')
  })

  it('leaves non-table lines alone', () => {
    expect(normalizeTableWhitespaceText('# Hi')).toBe('# Hi')
  })
})

describe('swapParagraphsText', () => {
  it('swaps 1 and 3', () => {
    const out = swapParagraphsText('A\n\nB\n\nC', 1, 3)
    expect(out).toBe('C\n\nB\n\nA')
  })

  it('returns source if indices out of bounds', () => {
    expect(swapParagraphsText('A\n\nB', 1, 9)).toBe('A\n\nB')
  })

  it('returns source if a == b', () => {
    expect(swapParagraphsText('A\n\nB', 1, 1)).toBe('A\n\nB')
  })
})

import {
  cycleCheckboxTriStateText,
  trimTrailingWhitespaceText,
  sortFrontmatterBySpecOrderText,
  firstTableRowToListText,
  sortDateSectionsDescText,
} from './commands'

describe('cycleCheckboxTriStateText', () => {
  it('cycles [ ] → [/]', () => {
    expect(cycleCheckboxTriStateText('- [ ] todo')).toBe('- [/] todo')
  })

  it('cycles [/] → [x]', () => {
    expect(cycleCheckboxTriStateText('- [/] doing')).toBe('- [x] doing')
  })

  it('cycles [x] → [ ]', () => {
    expect(cycleCheckboxTriStateText('- [x] done')).toBe('- [ ] done')
  })
})

describe('trimTrailingWhitespaceText', () => {
  it('strips trailing spaces', () => {
    expect(trimTrailingWhitespaceText('foo   \nbar')).toBe('foo\nbar')
  })

  it('strips trailing tabs', () => {
    expect(trimTrailingWhitespaceText('foo\t\nbar')).toBe('foo\nbar')
  })

  it('preserves internal spaces', () => {
    expect(trimTrailingWhitespaceText('a  b   ')).toBe('a  b')
  })
})

describe('sortFrontmatterBySpecOrderText', () => {
  it('puts title before tags', () => {
    const src = '---\ntags: [a]\ntitle: Hi\n---\n\nbody'
    const out = sortFrontmatterBySpecOrderText(src)
    const titleIdx = out.indexOf('title:')
    const tagsIdx = out.indexOf('tags:')
    expect(titleIdx).toBeLessThan(tagsIdx)
  })

  it('puts unknown keys after known ones', () => {
    const src = '---\nzzz: x\ntitle: A\n---\n\nbody'
    const out = sortFrontmatterBySpecOrderText(src)
    expect(out.indexOf('title:')).toBeLessThan(out.indexOf('zzz:'))
  })

  it('leaves content without frontmatter alone', () => {
    expect(sortFrontmatterBySpecOrderText('# Hi')).toBe('# Hi')
  })
})

describe('firstTableRowToListText', () => {
  it('converts first row to bullets', () => {
    const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
    const out = firstTableRowToListText(src)
    expect(out).toContain('- **Name**: Alice')
    expect(out).toContain('- **Age**: 30')
  })

  it('keeps non-table lines', () => {
    const src = '# H\n\npara'
    expect(firstTableRowToListText(src)).toBe(src)
  })
})

describe('sortDateSectionsDescText', () => {
  it('sorts dated H2 sections desc', () => {
    const src = '## 2026-01-01\n\nA\n\n## 2026-03-01\n\nC\n\n## 2026-02-01\n\nB'
    const out = sortDateSectionsDescText(src)
    expect(out.indexOf('2026-03-01')).toBeLessThan(out.indexOf('2026-02-01'))
    expect(out.indexOf('2026-02-01')).toBeLessThan(out.indexOf('2026-01-01'))
  })

  it('puts undated sections last', () => {
    const src = '## Other\n\nx\n\n## 2026-01-01\n\nA'
    const out = sortDateSectionsDescText(src)
    expect(out.indexOf('2026-01-01')).toBeLessThan(out.indexOf('Other'))
  })
})

import {
  imagesToFigureText,
  dedupFootnoteDefinitionsText,
  demoteH3ToH4Text,
  sortCalloutsByTypeText,
  collapseExtraBlankLinesText,
} from './commands'

describe('imagesToFigureText', () => {
  it('converts image to figure', () => {
    const out = imagesToFigureText('![alt text](pic.png)')
    expect(out).toContain('<figure>')
    expect(out).toContain('<img src="pic.png"')
    expect(out).toContain('<figcaption>alt text</figcaption>')
  })

  it('omits figcaption when alt is empty', () => {
    const out = imagesToFigureText('![](pic.png)')
    expect(out).not.toContain('figcaption')
  })

  it('skips inside fence', () => {
    const src = '```\n![alt](pic.png)\n```'
    expect(imagesToFigureText(src)).toBe(src)
  })
})

describe('dedupFootnoteDefinitionsText', () => {
  it('keeps first definition only', () => {
    const src = '[^1]: first\n[^1]: dup'
    const out = dedupFootnoteDefinitionsText(src)
    expect(out).toContain('first')
    expect(out).not.toContain('dup')
  })

  it('keeps multiple distinct definitions', () => {
    const src = '[^1]: a\n[^2]: b'
    expect(dedupFootnoteDefinitionsText(src)).toBe(src)
  })
})

describe('demoteH3ToH4Text', () => {
  it('demotes ### to ####', () => {
    expect(demoteH3ToH4Text('### Title')).toBe('#### Title')
  })

  it('leaves other heading levels alone', () => {
    expect(demoteH3ToH4Text('## H2\n### H3')).toBe('## H2\n#### H3')
  })

  it('skips fenced code', () => {
    const src = '```\n### nope\n```'
    expect(demoteH3ToH4Text(src)).toBe(src)
  })
})

describe('sortCalloutsByTypeText', () => {
  it('sorts adjacent callouts alphabetically', () => {
    const src = '> [!warning] W\n> body\n> [!info] I\n> body'
    const out = sortCalloutsByTypeText(src)
    expect(out.indexOf('[!info]')).toBeLessThan(out.indexOf('[!warning]'))
  })

  it('leaves non-callout content alone', () => {
    expect(sortCalloutsByTypeText('para\n\n# H')).toBe('para\n\n# H')
  })
})

describe('collapseExtraBlankLinesText', () => {
  it('collapses 5 newlines to 2', () => {
    expect(collapseExtraBlankLinesText('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('keeps single blank line untouched', () => {
    expect(collapseExtraBlankLinesText('a\n\nb')).toBe('a\n\nb')
  })
})

import {
  refLinksToInlineText,
  listToMermaidGraphLrText,
  normalizeOrderedListStartAtOneText,
  headingMapText,
} from './commands'

describe('refLinksToInlineText', () => {
  it('converts ref-style link', () => {
    const src = 'see [foo][1].\n\n[1]: https://example.com'
    const out = refLinksToInlineText(src)
    expect(out).toContain('[foo](https://example.com)')
    expect(out).not.toContain('[1]:')
  })

  it('uses label as id when id is empty', () => {
    const src = 'see [foo][].\n\n[foo]: https://example.com'
    const out = refLinksToInlineText(src)
    expect(out).toContain('[foo](https://example.com)')
  })

  it('leaves ref intact when no definition', () => {
    expect(refLinksToInlineText('see [foo][missing].')).toContain('[foo][missing]')
  })
})

describe('listToMermaidGraphLrText', () => {
  it('produces graph LR with chained nodes', () => {
    const out = listToMermaidGraphLrText('- a\n- b\n- c')
    expect(out).toContain('graph LR')
    expect(out).toContain('n1["a"]')
    expect(out).toContain('n1 --> n2')
    expect(out).toContain('n2 --> n3')
  })

  it('leaves non-list lines alone', () => {
    expect(listToMermaidGraphLrText('# H')).toBe('# H')
  })
})

describe('normalizeOrderedListStartAtOneText', () => {
  it('renumbers from 1', () => {
    const out = normalizeOrderedListStartAtOneText('5. a\n6. b\n7. c')
    expect(out).toBe('1. a\n2. b\n3. c')
  })

  it('handles separate blocks independently', () => {
    const out = normalizeOrderedListStartAtOneText('5. a\n6. b\n\n9. x\n10. y')
    expect(out).toContain('1. a\n2. b')
    expect(out).toContain('1. x\n2. y')
  })

  it('skips fenced code', () => {
    const src = '```\n5. nope\n```'
    expect(normalizeOrderedListStartAtOneText(src)).toBe(src)
  })
})

describe('headingMapText', () => {
  it('emits one line per heading', () => {
    const out = headingMapText('# A\n## B\n### C')
    expect(out).toContain('- H1 A')
    expect(out).toContain('- H2 B')
    expect(out).toContain('- H3 C')
    expect(out).toContain('[[#A]]')
  })

  it('skips fenced code', () => {
    const src = '```\n# nope\n```'
    expect(headingMapText(src)).toBe('')
  })
})

import {
  tocWithAnchorsText,
  sortH2SectionsByWordCountDescText,
  foldH2AsDetailsText,
  paragraphsToOrderedListText,
  ddmmyyyyToIsoText,
  capitalizeHeadingsText,
} from './commands'

describe('tocWithAnchorsText', () => {
  it('produces nested links', () => {
    const out = tocWithAnchorsText('# A\n## B\n### C')
    expect(out).toContain('- [A](#a)')
    expect(out).toContain('  - [B](#b)')
    expect(out).toContain('    - [C](#c)')
  })

  it('slugs spaces to dashes', () => {
    const out = tocWithAnchorsText('# Hello World')
    expect(out).toContain('](#hello-world)')
  })

  it('skips fence', () => {
    expect(tocWithAnchorsText('```\n# nope\n```')).toBe('')
  })
})

describe('sortH2SectionsByWordCountDescText', () => {
  it('puts longest section first', () => {
    const src = '## Short\n\none\n\n## Long\n\none two three four five six'
    const out = sortH2SectionsByWordCountDescText(src)
    expect(out.indexOf('## Long')).toBeLessThan(out.indexOf('## Short'))
  })

  it('keeps preamble before sections', () => {
    const src = 'preamble\n\n## A\n\nx'
    expect(sortH2SectionsByWordCountDescText(src)).toContain('preamble')
  })
})

describe('foldH2AsDetailsText', () => {
  it('wraps H2 sections in details/summary', () => {
    const out = foldH2AsDetailsText('## Title\n\nbody')
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>Title</summary>')
    expect(out).toContain('</details>')
  })

  it('closes prior section when new H2 starts', () => {
    const out = foldH2AsDetailsText('## A\n\nx\n\n## B\n\ny')
    const opens = (out.match(/<details>/g) ?? []).length
    const closes = (out.match(/<\/details>/g) ?? []).length
    expect(opens).toBe(2)
    expect(closes).toBe(2)
  })
})

describe('paragraphsToOrderedListText', () => {
  it('converts paragraphs to numbered list', () => {
    const out = paragraphsToOrderedListText('first\n\nsecond\n\nthird')
    expect(out).toContain('1. first')
    expect(out).toContain('2. second')
    expect(out).toContain('3. third')
  })

  it('joins multi-line paragraph into single line', () => {
    const out = paragraphsToOrderedListText('line1\nline2\n\nthird')
    expect(out).toContain('1. line1 line2')
  })
})

describe('ddmmyyyyToIsoText', () => {
  it('converts DD/MM/YYYY to ISO', () => {
    expect(ddmmyyyyToIsoText('on 05/03/2026')).toContain('2026-03-05')
  })

  it('pads single digits', () => {
    expect(ddmmyyyyToIsoText('5/3/2026')).toContain('2026-03-05')
  })

  it('skips fence', () => {
    const src = '```\n05/03/2026\n```'
    expect(ddmmyyyyToIsoText(src)).toBe(src)
  })
})

describe('capitalizeHeadingsText', () => {
  it('uppercases first letter', () => {
    expect(capitalizeHeadingsText('# hello')).toBe('# Hello')
  })

  it('leaves already-capital heading alone', () => {
    expect(capitalizeHeadingsText('# Hello')).toBe('# Hello')
  })

  it('skips fence', () => {
    expect(capitalizeHeadingsText('```\n# hi\n```')).toBe('```\n# hi\n```')
  })
})

import {
  smartQuotesToStraightText,
  sortListByLengthDescText,
  asterisksToUnderscoresText,
  underscoresToAsterisksText,
  wikilinkImagesToMdText,
  mdImagesToWikilinkText,
} from './commands'

describe('smartQuotesToStraightText', () => {
  it('replaces curly double quotes', () => {
    expect(smartQuotesToStraightText('“hello”')).toBe('"hello"')
  })

  it('replaces curly single quotes', () => {
    expect(smartQuotesToStraightText('‘hi’')).toBe("'hi'")
  })

  it('leaves straight quotes alone', () => {
    expect(smartQuotesToStraightText('"hi"')).toBe('"hi"')
  })
})

describe('sortListByLengthDescText', () => {
  it('sorts a contiguous bullet list by length desc', () => {
    const input = '- a\n- bbb\n- cc\n'
    const out = sortListByLengthDescText(input)
    expect(out).toBe('- bbb\n- cc\n- a\n')
  })

  it('leaves non-list lines alone', () => {
    const input = 'paragraph\n- a\n- bbbb\nend\n'
    const out = sortListByLengthDescText(input)
    expect(out).toContain('- bbbb\n- a')
  })
})

describe('asterisksToUnderscoresText', () => {
  it('converts bold', () => {
    expect(asterisksToUnderscoresText('**hi**')).toBe('__hi__')
  })

  it('converts italic', () => {
    expect(asterisksToUnderscoresText('*hi*')).toBe('_hi_')
  })

  it('skips fence', () => {
    expect(asterisksToUnderscoresText('```\n**x**\n```')).toBe('```\n**x**\n```')
  })
})

describe('underscoresToAsterisksText', () => {
  it('converts bold', () => {
    expect(underscoresToAsterisksText('__hi__')).toBe('**hi**')
  })

  it('converts italic', () => {
    expect(underscoresToAsterisksText('_hi_')).toBe('*hi*')
  })
})

describe('wikilinkImagesToMdText', () => {
  it('converts wikilink image to markdown', () => {
    expect(wikilinkImagesToMdText('![[a.png|caption]]')).toBe('![caption](a.png)')
  })

  it('handles no alt', () => {
    expect(wikilinkImagesToMdText('![[b.jpg]]')).toBe('![](b.jpg)')
  })
})

describe('mdImagesToWikilinkText', () => {
  it('converts markdown image to wikilink', () => {
    expect(mdImagesToWikilinkText('![alt](file.png)')).toBe('![[file.png|alt]]')
  })

  it('handles empty alt', () => {
    expect(mdImagesToWikilinkText('![](file.png)')).toBe('![[file.png]]')
  })
})

import {
  sectionLineCountReportText,
  bulletListToBlockquoteText,
  normalizeCalloutTypeCaseText,
  countFootnotesText,
  splitLongParagraphAtSentencesText,
} from './commands'

describe('sectionLineCountReportText', () => {
  it('returns info for empty doc', () => {
    expect(sectionLineCountReportText('hello')).toContain('The document has no headings.')
  })

  it('counts lines per section', () => {
    const src = '# A\nline1\nline2\n# B\nline3'
    const out = sectionLineCountReportText(src)
    expect(out).toContain('A: 2')
    expect(out).toContain('B: 1')
  })
})

describe('bulletListToBlockquoteText', () => {
  it('converts bullets to blockquote', () => {
    expect(bulletListToBlockquoteText('- a\n- b')).toBe('> a\n> b')
  })

  it('skips fence', () => {
    expect(bulletListToBlockquoteText('```\n- a\n```')).toBe('```\n- a\n```')
  })
})

describe('normalizeCalloutTypeCaseText', () => {
  it('lowercases callout type', () => {
    expect(normalizeCalloutTypeCaseText('> [!NOTE] hi')).toBe('> [!note] hi')
  })

  it('preserves rest of line', () => {
    expect(normalizeCalloutTypeCaseText('> [!Tip]+ x')).toBe('> [!tip]+ x')
  })
})

describe('countFootnotesText', () => {
  it('counts both', () => {
    const src = 'text[^1]\n[^1]: note\n'
    expect(countFootnotesText(src)).toEqual({ defs: 1, refs: 1 })
  })

  it('skips inline code', () => {
    const src = 'text `[^x]` only\n'
    expect(countFootnotesText(src)).toEqual({ defs: 0, refs: 0 })
  })
})

describe('splitLongParagraphAtSentencesText', () => {
  it('leaves short paragraphs alone', () => {
    expect(splitLongParagraphAtSentencesText('short.')).toBe('short.')
  })

  it('splits a long paragraph by sentence', () => {
    const long = 'a. '.repeat(120) + 'end.'
    const out = splitLongParagraphAtSentencesText(long, 100)
    expect(out.split('\n').length).toBeGreaterThan(2)
  })
})

import {
  blockquoteToParagraphText,
  sortTableByColumnAscText,
  snakeCaseHeadingsToTitleCaseText,
  paragraphsToOrderedListReversedText,
  unifyDashesText,
  normalizeTaskListIndentText,
} from './commands'

describe('blockquoteToParagraphText', () => {
  it('removes simple > prefix', () => {
    expect(blockquoteToParagraphText('> hi\n> ho')).toBe('hi\nho')
  })

  it('preserves callouts', () => {
    expect(blockquoteToParagraphText('> [!note] x')).toBe('> [!note] x')
  })
})

describe('sortTableByColumnAscText', () => {
  it('sorts numeric column ascending', () => {
    const src = '| n |\n| --- |\n| 3 |\n| 1 |\n| 2 |'
    const out = sortTableByColumnAscText(src, 0)
    expect(out).toBe('| n |\n| --- |\n| 1 |\n| 2 |\n| 3 |')
  })

  it('ignores non-tables', () => {
    expect(sortTableByColumnAscText('plain text', 0)).toBe('plain text')
  })
})

describe('snakeCaseHeadingsToTitleCaseText', () => {
  it('converts heading', () => {
    expect(snakeCaseHeadingsToTitleCaseText('# hello_world here')).toBe('# Hello World Here')
  })

  it('skips fence', () => {
    expect(snakeCaseHeadingsToTitleCaseText('```\n# a_b\n```')).toBe('```\n# a_b\n```')
  })
})

describe('paragraphsToOrderedListReversedText', () => {
  it('numbers desc', () => {
    expect(paragraphsToOrderedListReversedText('a\n\nb\n\nc')).toBe('3. a\n2. b\n1. c')
  })
})

describe('unifyDashesText', () => {
  it('replaces double hyphen with em-dash', () => {
    expect(unifyDashesText('foo--bar')).toBe('foo—bar')
  })

  it('leaves single hyphen alone', () => {
    expect(unifyDashesText('a-b')).toBe('a-b')
  })

  it('skips list line', () => {
    expect(unifyDashesText('- a--b')).toBe('- a--b')
  })
})

describe('normalizeTaskListIndentText', () => {
  it('rounds tab indent to 2-space', () => {
    expect(normalizeTaskListIndentText('\t- [ ] x')).toBe('  - [ ] x')
  })

  it('preserves checkbox state', () => {
    expect(normalizeTaskListIndentText('- [x] x')).toBe('- [x] x')
  })
})

import {
  nbspInDatesText,
  dedupConsecutiveBulletsText,
  renumberOrderedListFromText,
  swapInlineLinkTextAndUrlText,
  headingsToSentenceCaseText,
  normalizeWikilinkLowercaseText,
} from './commands'

describe('nbspInDatesText', () => {
  it('replaces date spaces with nbsp', () => {
    const out = nbspInDatesText('March 5, 2026')
    expect(out.includes(' ')).toBe(true)
  })

  it('leaves other text alone', () => {
    expect(nbspInDatesText('hello world')).toBe('hello world')
  })
})

describe('dedupConsecutiveBulletsText', () => {
  it('drops adjacent dup bullet', () => {
    expect(dedupConsecutiveBulletsText('- a\n- a\n- b')).toBe('- a\n- b')
  })

  it('keeps gap-separated dups', () => {
    expect(dedupConsecutiveBulletsText('- a\nother\n- a')).toBe('- a\nother\n- a')
  })
})

describe('renumberOrderedListFromText', () => {
  it('renumbers starting at given number', () => {
    expect(renumberOrderedListFromText('1. a\n2. b', 5)).toBe('5. a\n6. b')
  })

  it('resets after gap', () => {
    expect(renumberOrderedListFromText('1. a\n\n1. x', 10)).toBe('10. a\n\n10. x')
  })
})

describe('swapInlineLinkTextAndUrlText', () => {
  it('swaps text and url', () => {
    expect(swapInlineLinkTextAndUrlText('[text](url)')).toBe('[url](text)')
  })
})

describe('headingsToSentenceCaseText', () => {
  it('sentence-cases heading', () => {
    expect(headingsToSentenceCaseText('# HELLO WORLD')).toBe('# Hello world')
  })
})

describe('normalizeWikilinkLowercaseText', () => {
  it('lowercases target', () => {
    expect(normalizeWikilinkLowercaseText('[[FooBar]]')).toBe('[[foobar]]')
  })

  it('preserves alias', () => {
    expect(normalizeWikilinkLowercaseText('[[FooBar|Foo Bar]]')).toBe('[[foobar|Foo Bar]]')
  })
})

import {
  orderedListToChecklistTextV2,
  indentTaskSubtreeText,
  capitalizeFirstWordPerSentenceText,
  sentenceToTitleCaseText,
  sortFrontmatterAliasesTextV2,
  normalizeCalloutIndentText,
} from './commands'

describe('orderedListToChecklistTextV2', () => {
  it('converts numbered list to checkboxes', () => {
    expect(orderedListToChecklistTextV2('1. a\n2. b')).toBe('- [ ] a\n- [ ] b')
  })

  it('skips fence', () => {
    expect(orderedListToChecklistTextV2('```\n1. a\n```')).toBe('```\n1. a\n```')
  })
})

describe('indentTaskSubtreeText', () => {
  it('indents task lines by 2 spaces', () => {
    expect(indentTaskSubtreeText('- [ ] one')).toBe('  - [ ] one')
  })

  it('leaves non-tasks alone', () => {
    expect(indentTaskSubtreeText('- bullet')).toBe('- bullet')
  })
})

describe('capitalizeFirstWordPerSentenceText', () => {
  it('capitalizes first lowercase', () => {
    expect(capitalizeFirstWordPerSentenceText('hello world')).toBe('Hello world')
  })

  it('capitalizes after period', () => {
    expect(capitalizeFirstWordPerSentenceText('Hi. there.')).toBe('Hi. There.')
  })
})

describe('sentenceToTitleCaseText', () => {
  it('title-cases heading skipping stopwords', () => {
    expect(sentenceToTitleCaseText('# the great gatsby of america')).toBe('# The Great Gatsby of America')
  })
})

describe('sortFrontmatterAliasesTextV2', () => {
  it('sorts aliases alphabetically', () => {
    const src = '---\naliases:\n  - charlie\n  - alpha\n  - bravo\n---\nbody'
    const out = sortFrontmatterAliasesTextV2(src)
    expect(out).toContain('- alpha\n  - bravo\n  - charlie')
  })

  it('leaves other fields alone', () => {
    const src = '---\ntitle: foo\n---'
    expect(sortFrontmatterAliasesTextV2(src)).toBe(src)
  })
})

describe('normalizeCalloutIndentText', () => {
  it('collapses extra spaces after >', () => {
    expect(normalizeCalloutIndentText('>   hello')).toBe('> hello')
  })

  it('preserves nested level count', () => {
    expect(normalizeCalloutIndentText('> > > nested')).toBe('>>> nested')
  })
})

import {
  paragraphToNumberedFootnoteText,
  massRenameWikilinkTargetText,
  foldBulletSubitemsText,
  extractInlineUrlsText,
  sortListByFirstEmojiText,
} from './commands'

describe('paragraphToNumberedFootnoteText', () => {
  it('numbers footnotes per paragraph', () => {
    const out = paragraphToNumberedFootnoteText('hello\n\nworld')
    expect(out).toContain('hello [^1]')
    expect(out).toContain('world [^2]')
    expect(out).toContain('[^1]:')
    expect(out).toContain('[^2]:')
  })

  it('skips list / heading', () => {
    expect(paragraphToNumberedFootnoteText('# title')).toBe('# title')
  })
})

describe('massRenameWikilinkTargetText', () => {
  it('renames matching target', () => {
    expect(massRenameWikilinkTargetText('[[old]] [[other]]', 'old', 'new')).toBe('[[new]] [[other]]')
  })

  it('preserves alias', () => {
    expect(massRenameWikilinkTargetText('[[old|alias]]', 'old', 'new')).toBe('[[new|alias]]')
  })
})

describe('foldBulletSubitemsText', () => {
  it('removes nested bullets', () => {
    expect(foldBulletSubitemsText('- top\n  - sub1\n  - sub2\n- next')).toBe('- top\n- next')
  })
})

describe('extractInlineUrlsText', () => {
  it('appends URLs section', () => {
    const out = extractInlineUrlsText('see https://example.com here')
    expect(out).toContain('## URLs')
    expect(out).toContain('- https://example.com')
  })

  it('no-op when no URLs', () => {
    expect(extractInlineUrlsText('plain')).toBe('plain')
  })
})

describe('sortListByFirstEmojiText', () => {
  it('sorts adjacent list by first emoji', () => {
    const src = '- 🚀 a\n- 🍎 b\n- 🐱 c'
    const out = sortListByFirstEmojiText(src)
    // alphabetical UTF-16 ordering — just assert the b (apple) shows up before the a (rocket)
    expect(out.indexOf('🍎')).toBeLessThan(out.indexOf('🚀'))
  })
})

import {
  tableToCsvWithHeaderText,
  removeBrokenInlineLinksText,
  wrapBulletsInQuotesText,
  prefixAllBulletsText,
  lineNumbersAsCommentsText,
} from './commands'

describe('tableToCsvWithHeaderText', () => {
  it('converts a markdown table to CSV code block', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
    const out = tableToCsvWithHeaderText(src)
    expect(out).toContain('```csv')
    expect(out).toContain('a,b')
    expect(out).toContain('1,2')
    expect(out).toContain('3,4')
  })

  it('quotes cells with commas', () => {
    const src = '| a | b |\n| --- | --- |\n| 1, 2 | 3 |\n| 4 | 5 |'
    const out = tableToCsvWithHeaderText(src)
    expect(out).toContain('"1, 2"')
  })
})

describe('removeBrokenInlineLinksText', () => {
  it('replaces empty link with just text', () => {
    expect(removeBrokenInlineLinksText('see [docs]() here')).toBe('see docs here')
  })

  it('leaves real links alone', () => {
    expect(removeBrokenInlineLinksText('[ok](https://e.com)')).toBe('[ok](https://e.com)')
  })
})

describe('wrapBulletsInQuotesText', () => {
  it('wraps bullet content in quotes', () => {
    expect(wrapBulletsInQuotesText('- hello\n- world')).toBe('- "hello"\n- "world"')
  })

  it('skips already-quoted', () => {
    expect(wrapBulletsInQuotesText('- "hi"')).toBe('- "hi"')
  })
})

describe('prefixAllBulletsText', () => {
  it('adds prefix to every bullet', () => {
    expect(prefixAllBulletsText('- a\n- b', '[TODO] ')).toBe('- [TODO] a\n- [TODO] b')
  })

  it('preserves indent', () => {
    expect(prefixAllBulletsText('  - a', '✅ ')).toBe('  - ✅ a')
  })
})

describe('lineNumbersAsCommentsText', () => {
  it('prepends padded line numbers as comments', () => {
    const src = 'one\ntwo\nthree'
    const out = lineNumbersAsCommentsText(src)
    expect(out).toBe('<!--L1--> one\n<!--L2--> two\n<!--L3--> three')
  })
})

import {
  expandTabIndentToSpacesText,
  replaceFirstHeadingWithFrontmatterTitleText,
  isoDatesToDottedText,
  reverseAdjacentBulletsText,
} from './commands'

describe('expandTabIndentToSpacesText', () => {
  it('expands tab to 2 spaces by default', () => {
    expect(expandTabIndentToSpacesText('\t- a')).toBe('  - a')
  })

  it('respects custom width', () => {
    expect(expandTabIndentToSpacesText('\t\t- a', 4)).toBe('        - a')
  })

  it('skips fence', () => {
    expect(expandTabIndentToSpacesText('```\n\tcode\n```')).toBe('```\n\tcode\n```')
  })
})

describe('replaceFirstHeadingWithFrontmatterTitleText', () => {
  it('replaces h1 with frontmatter title', () => {
    const src = '---\ntitle: My note\n---\n\n# old heading\nbody'
    const out = replaceFirstHeadingWithFrontmatterTitleText(src)
    expect(out).toContain('# My note')
  })

  it('no-op when no frontmatter', () => {
    expect(replaceFirstHeadingWithFrontmatterTitleText('# only')).toBe('# only')
  })
})

describe('isoDatesToDottedText', () => {
  it('converts ISO to dotted', () => {
    expect(isoDatesToDottedText('2026-06-07')).toBe('2026.06.07')
  })

  it('leaves non-dates alone', () => {
    expect(isoDatesToDottedText('hello')).toBe('hello')
  })
})

describe('reverseAdjacentBulletsText', () => {
  it('reverses contiguous bullet group', () => {
    expect(reverseAdjacentBulletsText('- a\n- b\n- c')).toBe('- c\n- b\n- a')
  })

  it('reverses each group separately', () => {
    const src = '- a\n- b\nx\n- c\n- d'
    expect(reverseAdjacentBulletsText(src)).toBe('- b\n- a\nx\n- d\n- c')
  })
})

import {
  dedupAdjacentIdenticalLinesText,
  paragraphsToDashListText,
  slugifyText,
  setextToAtxHeadingsText,
} from './commands'

describe('dedupAdjacentIdenticalLinesText', () => {
  it('removes adjacent identical lines', () => {
    expect(dedupAdjacentIdenticalLinesText('a\na\nb')).toBe('a\nb')
  })

  it('keeps non-adjacent dups', () => {
    expect(dedupAdjacentIdenticalLinesText('a\nb\na')).toBe('a\nb\na')
  })
})

describe('paragraphsToDashListText', () => {
  it('wraps paragraphs in dash bullets', () => {
    expect(paragraphsToDashListText('hello\n\nworld')).toBe('- hello\n\n- world')
  })

  it('skips headings', () => {
    expect(paragraphsToDashListText('# title\n\nbody')).toBe('# title\n\n- body')
  })
})

describe('slugifyText', () => {
  it('lowercases and joins with dash', () => {
    expect(slugifyText('Hello World!')).toBe('hello-world')
  })

  it('removes leading and trailing dashes', () => {
    expect(slugifyText('  foo bar  ')).toBe('foo-bar')
  })
})

describe('setextToAtxHeadingsText', () => {
  it('converts h1 setext', () => {
    expect(setextToAtxHeadingsText('Title\n=====')).toBe('# Title')
  })

  it('converts h2 setext', () => {
    expect(setextToAtxHeadingsText('Sub\n---')).toBe('## Sub')
  })

  it('leaves bullet lists alone', () => {
    expect(setextToAtxHeadingsText('item\n---')).toBe('## item')
  })

  it('skips fence', () => {
    expect(setextToAtxHeadingsText('```\nTitle\n=====\n```')).toBe('```\nTitle\n=====\n```')
  })
})

import {
  paragraphsToMermaidMindmapText,
  tasksToWikilinkInTasksSectionText,
  sortSectionsByHeadingTitleText,
} from './commands'

describe('paragraphsToMermaidMindmapText', () => {
  it('wraps paragraphs in mindmap', () => {
    const out = paragraphsToMermaidMindmapText('idea one\n\nidea two')
    expect(out).toContain('```mermaid')
    expect(out).toContain('mindmap')
    expect(out).toContain('idea one')
    expect(out).toContain('idea two')
  })

  it('no-op on empty', () => {
    expect(paragraphsToMermaidMindmapText('')).toBe('')
  })
})

describe('tasksToWikilinkInTasksSectionText', () => {
  it('wraps task text in wikilink under tasks heading', () => {
    const src = '## Tasks\n- [ ] do thing\n## Other\n- [ ] skip'
    const out = tasksToWikilinkInTasksSectionText(src)
    expect(out).toContain('- [ ] [[do thing]]')
    expect(out).toContain('- [ ] skip')
  })
})

describe('sortSectionsByHeadingTitleText', () => {
  it('sorts h2 sections by title', () => {
    const src = '## B\nb\n\n## A\na'
    const out = sortSectionsByHeadingTitleText(src)
    expect(out.indexOf('## A')).toBeLessThan(out.indexOf('## B'))
  })

  it('preserves frontmatter', () => {
    const src = '---\ntitle: x\n---\n## B\n\n## A'
    const out = sortSectionsByHeadingTitleText(src)
    expect(out.startsWith('---\ntitle: x\n---')).toBe(true)
  })
})

import {
  paragraphsToFishboneMermaidText as _fishText,
  normalizeBulletTrailingPunctuationText as _trimPunctText,
  foldCalloutsToSummaryText as _foldText,
  atxHeadingsToBoldParagraphText as _atxBoldText,
  duplicateParagraphsReportText as _dupReportText,
} from './commands'

describe('batch199-text-helpers', () => {
  it('paragraphsToFishboneMermaidText returns mermaid LR graph', () => {
    const out = _fishText('cause one\n\ncause two\n\ncause three')
    expect(out).toContain('```mermaid')
    expect(out).toContain('graph LR')
    expect(out).toContain('Problem')
    expect(out).toContain('cause one')
  })

  it('normalizeBulletTrailingPunctuationText strips trailing .;,', () => {
    expect(_trimPunctText('- item one.\n- item two;\n- item three,')).toBe(
      '- item one\n- item two\n- item three',
    )
  })

  it('normalizeBulletTrailingPunctuationText skips fenced code', () => {
    const src = '- a.\n```\n- b.\n```\n- c.'
    expect(_trimPunctText(src)).toBe('- a\n```\n- b.\n```\n- c')
  })

  it('foldCalloutsToSummaryText collapses open callouts', () => {
    expect(_foldText('> [!note] hello\n> body')).toContain('[!note]-')
    expect(_foldText('> [!warning]+ warn\n> body')).toContain('[!warning]-')
  })

  it('atxHeadingsToBoldParagraphText converts headings', () => {
    expect(_atxBoldText('# Title\nbody\n## Sub\n')).toBe('**Title**\nbody\n**Sub**\n')
  })

  it('atxHeadingsToBoldParagraphText skips fenced code', () => {
    expect(_atxBoldText('# A\n```\n# Code\n```\n# B')).toBe('**A**\n```\n# Code\n```\n**B**')
  })

  it('duplicateParagraphsReportText appends report when dups exist', () => {
    const src = 'hello world\n\nfoo bar\n\nhello world'
    const out = _dupReportText(src)
    expect(out).toContain('## ⚠️ Duplicated paragraphs')
    expect(out).toContain('hello world')
  })

  it('duplicateParagraphsReportText returns input when no dups', () => {
    const src = 'unique a\n\nunique b'
    expect(_dupReportText(src)).toBe(src)
  })
})

import {
  paragraphsToNumberedQaText as _qaText,
  capitalizeWikilinkTargetsText as _capWikiText,
  calloutTypeToAdmonitionKindText as _calloutMapText,
  headingsToBookmarkReportText as _bookmarkText,
} from './commands'

describe('batch200-text-helpers', () => {
  it('paragraphsToNumberedQaText emits Q/A pairs', () => {
    const out = _qaText('first question\n\nsecond question')
    expect(out).toContain('**Q1**: first question')
    expect(out).toContain('**A1**:')
    expect(out).toContain('**Q2**: second question')
  })

  it('paragraphsToNumberedQaText skips empty blocks', () => {
    const out = _qaText('q1\n\n\n\nq2')
    expect(out).toContain('Q1')
    expect(out).toContain('Q2')
    expect(out).not.toContain('Q3')
  })

  it('capitalizeWikilinkTargetsText capitalizes first letters', () => {
    expect(_capWikiText('see [[some note]] and [[other/page]]')).toBe(
      'see [[Some Note]] and [[Other/Page]]',
    )
  })

  it('capitalizeWikilinkTargetsText preserves alias', () => {
    expect(_capWikiText('[[some note|alias]]')).toBe('[[Some Note|alias]]')
  })

  it('calloutTypeToAdmonitionKindText maps synonyms', () => {
    expect(_calloutMapText('> [!summary]+ ok')).toBe('> [!abstract]+ ok')
    expect(_calloutMapText('> [!important] x')).toBe('> [!warning] x')
    expect(_calloutMapText('> [!hint]- y')).toBe('> [!tip]- y')
  })

  it('calloutTypeToAdmonitionKindText keeps unknown types', () => {
    expect(_calloutMapText('> [!custom] body')).toBe('> [!custom] body')
  })

  it('headingsToBookmarkReportText appends bookmark list', () => {
    const out = _bookmarkText('# Hello World\n\nbody\n\n## Sub Title')
    expect(out).toContain('## 🔖 Bookmarks')
    expect(out).toContain('[Hello World](#hello-world)')
    expect(out).toContain('[Sub Title](#sub-title)')
  })

  it('headingsToBookmarkReportText returns input when no headings', () => {
    expect(_bookmarkText('just text')).toBe('just text')
  })
})

import {
  normalizeImageAltToFilenameText as _altText,
  paragraphsToDropdownSummaryText as _dropdownText,
  bulletsToGanttTimelineText as _ganttText,
  capitalizeTaskDescriptionsText as _taskCapText,
} from './commands'

describe('batch201-text-helpers', () => {
  it('normalizeImageAltToFilenameText fills empty alt from URL basename', () => {
    expect(_altText('![](images/cute-cat.png)')).toBe('![cute cat](images/cute-cat.png)')
  })

  it('normalizeImageAltToFilenameText preserves existing alt', () => {
    expect(_altText('![my photo](a/b.png)')).toBe('![my photo](a/b.png)')
  })

  it('normalizeImageAltToFilenameText skips fenced code', () => {
    expect(_altText('```\n![](x.png)\n```')).toBe('```\n![](x.png)\n```')
  })

  it('paragraphsToDropdownSummaryText wraps blocks in details', () => {
    const out = _dropdownText('Topic A\n\nTopic B\nbody')
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>Topic A</summary>')
    expect(out).toContain('<summary>Topic B</summary>')
  })

  it('bulletsToGanttTimelineText emits mermaid gantt', () => {
    const out = _ganttText('- Task1 (2026-02-01, 3d)\n- Task2')
    expect(out).toContain('```mermaid')
    expect(out).toContain('gantt')
    expect(out).toContain('Task1 :t1, 2026-02-01, 3d')
    expect(out).toContain('Task2 :t2, 2026-01-01, 1d')
  })

  it('bulletsToGanttTimelineText returns source when no bullets', () => {
    expect(_ganttText('just text')).toBe('just text')
  })

  it('capitalizeTaskDescriptionsText capitalizes first letter', () => {
    expect(_taskCapText('- [ ] write tests\n- [x] done item')).toBe(
      '- [ ] Write tests\n- [x] Done item',
    )
  })

  it('capitalizeTaskDescriptionsText leaves non-task lines', () => {
    expect(_taskCapText('- bullet item')).toBe('- bullet item')
  })
})

import {
  atxToSetextTopTwoLevelsText as _setextText,
  demoteFirstHeadingByOneText as _demoteFirstText,
  sortTableRowsByFirstColDescText as _sortDescText,
  paragraphWordCountBadgeText as _wordBadgeText,
  paragraphsToTwoColCalloutText as _twoColText,
  normalizeEmphasisInBulletsText as _bulletEmphasisText,
} from './commands'

describe('batch202-text-helpers', () => {
  it('atxToSetextTopTwoLevelsText converts H1/H2 only', () => {
    const out = _setextText('# Title\n## Subtitle\n### Sub2\nbody')
    expect(out).toContain('=====')
    expect(out).toContain('--------')
    expect(out).toContain('### Sub2')
  })

  it('atxToSetextTopTwoLevelsText skips fences', () => {
    const out = _setextText('```\n# Code\n```\n# Real')
    expect(out).toContain('```\n# Code\n```')
    expect(out).toContain('Real')
    expect(out).toContain('====')
  })

  it('demoteFirstHeadingByOneText adds one #', () => {
    expect(_demoteFirstText('# Title\n## Sub')).toBe('## Title\n## Sub')
  })

  it('demoteFirstHeadingByOneText leaves H6 alone', () => {
    expect(_demoteFirstText('###### Deep\n# After')).toBe('###### Deep\n## After')
  })

  it('sortTableRowsByFirstColDescText sorts by first col desc', () => {
    const src = '| name | age |\n|---|---|\n| Bob | 30 |\n| Alice | 25 |\n| Carol | 40 |'
    const out = _sortDescText(src)
    const rows = out.split('\n').slice(2)
    expect(rows[0]).toContain('Carol')
    expect(rows[1]).toContain('Bob')
    expect(rows[2]).toContain('Alice')
  })

  it('paragraphWordCountBadgeText adds badge to text paragraphs only', () => {
    const out = _wordBadgeText('plain paragraph here\n\n# Heading\n\n- bullet item')
    expect(out).toContain('(3 words)')
    expect(out).not.toContain('# Heading\n<sub>')
    expect(out).not.toContain('- bullet item\n<sub>')
  })

  it('paragraphsToTwoColCalloutText pairs blocks', () => {
    const out = _twoColText('first\n\nsecond\n\nthird\n\nfourth')
    expect(out).toContain('> [!info] Compare')
    expect((out.match(/Compare/g) ?? []).length).toBe(2)
  })

  it('normalizeEmphasisInBulletsText normalizes __ to ** and _ to *', () => {
    expect(_bulletEmphasisText('- __bold__ and _ital_')).toBe('- **bold** and *ital*')
  })

  it('normalizeEmphasisInBulletsText leaves non-bullet lines', () => {
    expect(_bulletEmphasisText('plain __keep__')).toBe('plain __keep__')
  })
})

import {
  paragraphsToNumberedHeadingsText as _numHeadText,
  sentenceCaseBulletsText as _scBulletsText,
  tableRowsToWikilinksText as _rowsToWikiText,
  prependBlockIdToLinesText as _blockIdText,
} from './commands'

describe('batch203-text-helpers', () => {
  it('paragraphsToNumberedHeadingsText numbers blocks', () => {
    const out = _numHeadText('First topic\nbody\n\nsecond')
    expect(out).toContain('## 1. First topic')
    expect(out).toContain('## 2. second')
  })

  it('paragraphsToNumberedHeadingsText returns input when empty', () => {
    expect(_numHeadText('')).toBe('')
  })

  it('sentenceCaseBulletsText uppercases first letter', () => {
    expect(_scBulletsText('- lowercase start')).toBe('- Lowercase start')
  })

  it('sentenceCaseBulletsText handles checkbox bullets', () => {
    expect(_scBulletsText('- [ ] do the thing')).toBe('- [ ] Do the thing')
  })

  it('sentenceCaseBulletsText capitalizes after period', () => {
    expect(_scBulletsText('- first one. second one.')).toBe('- First one. Second one.')
  })

  it('tableRowsToWikilinksText wraps named column', () => {
    const src = '| name | age |\n|---|---|\n| Alice | 30 |\n| Bob | 25 |'
    const out = _rowsToWikiText(0)(src)
    expect(out).toContain('[[Alice]]')
    expect(out).toContain('[[Bob]]')
    expect(out).not.toContain('[[30]]')
  })

  it('tableRowsToWikilinksText preserves already-wikilinked', () => {
    const src = '| name |\n|---|\n| [[Existing]] |'
    expect(_rowsToWikiText(0)(src)).toContain('[[Existing]]')
    expect(_rowsToWikiText(0)(src)).not.toContain('[[[[')
  })

  it('prependBlockIdToLinesText adds block ids', () => {
    const out = _blockIdText('hello\nworld')
    expect(out).toMatch(/hello \^b\d{4}/)
    expect(out).toMatch(/world \^b\d{4}/)
  })

  it('prependBlockIdToLinesText skips headings and fences', () => {
    const out = _blockIdText('# Heading\n```\ncode\n```\nbody')
    expect(out).toContain('# Heading')
    expect(out).not.toMatch(/# Heading \^b/)
    expect(out).not.toMatch(/code \^b/)
    expect(out).toMatch(/body \^b/)
  })
})

import {
  paragraphsToDefinitionListText as _dlText,
  paragraphsToOrderedListWithSubitemsText as _olSubText,
  capitalizeSectionTitlesText as _capTitleText,
} from './commands'

describe('batch204-text-helpers', () => {
  it('paragraphsToDefinitionListText emits term and definitions', () => {
    const out = _dlText('Term1\ndef one\ndef two\n\nTerm2\ndef three')
    expect(out).toContain('Term1')
    expect(out).toContain(': def one')
    expect(out).toContain(': def two')
    expect(out).toContain('Term2')
    expect(out).toContain(': def three')
  })

  it('paragraphsToDefinitionListText handles term without defs', () => {
    expect(_dlText('LoneTerm')).toContain('LoneTerm\n:')
  })

  it('paragraphsToOrderedListWithSubitemsText nests sub-items', () => {
    const out = _olSubText('First\nsub a\nsub b\n\nSecond\nsub c')
    expect(out).toContain('1. First')
    expect(out).toContain('   - sub a')
    expect(out).toContain('   - sub b')
    expect(out).toContain('2. Second')
  })

  it('capitalizeSectionTitlesText capitalizes each word in heading', () => {
    expect(_capTitleText('## hello world from kition')).toBe('## Hello World From Kition')
  })

  it('capitalizeSectionTitlesText leaves body text alone', () => {
    expect(_capTitleText('## title here\nbody stays lowercase')).toBe(
      '## Title Here\nbody stays lowercase',
    )
  })

  it('capitalizeSectionTitlesText skips fences', () => {
    expect(_capTitleText('```\n## fenced\n```')).toContain('## fenced')
  })
})

import {
  paragraphsToSummaryBlockText as _sumBlockText,
  normalizeListSpacingText as _listSpaceText,
  capitalizeAfterColonInHeadingsText as _colonCapText,
  replaceTabsInTablesWithPipesText as _tabsToPipesText,
  sortSectionsByDatePrefixText as _sortByDateText,
} from './commands'

describe('batch206-text-helpers', () => {
  it('paragraphsToSummaryBlockText emits callout summary', () => {
    const out = _sumBlockText('First topic\nbody\n\nsecond')
    expect(out).toContain('> [!summary] Summary')
    expect(out).toContain('> - First topic')
    expect(out).toContain('> - second')
  })

  it('paragraphsToSummaryBlockText returns input when empty', () => {
    expect(_sumBlockText('')).toBe('')
  })

  it('normalizeListSpacingText collapses single blank between items', () => {
    expect(_listSpaceText('- a\n\n- b\n\n- c')).toBe('- a\n- b\n- c')
  })

  it('normalizeListSpacingText leaves fenced lists alone', () => {
    expect(_listSpaceText('```\n- a\n\n- b\n```')).toBe('```\n- a\n\n- b\n```')
  })

  it('capitalizeAfterColonInHeadingsText fixes lowercase after colon', () => {
    expect(_colonCapText('## Section: hello world')).toBe('## Section: Hello world')
  })

  it('capitalizeAfterColonInHeadingsText leaves body lines alone', () => {
    expect(_colonCapText('Body: lower stays')).toBe('Body: lower stays')
  })

  it('replaceTabsInTablesWithPipesText converts tab rows to pipe', () => {
    expect(_tabsToPipesText('a\tb\tc')).toBe('| a | b | c |')
  })

  it('replaceTabsInTablesWithPipesText leaves pipe-tables alone', () => {
    expect(_tabsToPipesText('| a | b |\t')).toBe('| a | b |\t')
  })

  it('sortSectionsByDatePrefixText orders H2 dated sections ascending', () => {
    const src = '## 2026-03-01 newer\nbody1\n\n## 2026-01-01 older\nbody2'
    const out = _sortByDateText(src)
    const i1 = out.indexOf('2026-01-01')
    const i2 = out.indexOf('2026-03-01')
    expect(i1).toBeGreaterThanOrEqual(0)
    expect(i1).toBeLessThan(i2)
  })

  it('sortSectionsByDatePrefixText returns input when 0-1 section', () => {
    expect(_sortByDateText('## 2026-01-01 only')).toContain('only')
  })
})

import {
  paragraphsToAsciiBoxText as _asciiBoxText,
  paragraphsToLetterPrefixedListText as _letterListText,
  convertHeadingNumberingToRomanText as _romanText,
  smartIndentBulletByLevelText as _indentBulletText,
  paragraphsToTaskAssignedTableText as _taskTableText,
  bracketAroundNumbersInBulletsText as _bracketNumText,
} from './commands'

describe('batch208-text-helpers', () => {
  it('paragraphsToAsciiBoxText wraps each block in box drawing', () => {
    const out = _asciiBoxText('hello\nworld\n\nfoo')
    expect(out).toContain('+--')
    expect(out).toContain('| hello')
    expect(out).toContain('| foo')
  })

  it('paragraphsToLetterPrefixedListText starts with a)', () => {
    const out = _letterListText('first\n\nsecond\n\nthird')
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^a\) /)
    expect(lines[1]).toMatch(/^b\) /)
    expect(lines[2]).toMatch(/^c\) /)
  })

  it('paragraphsToLetterPrefixedListText cycles after z', () => {
    const blocks = Array.from({ length: 27 }, (_, i) => `p${i}`).join('\n\n')
    const out = _letterListText(blocks)
    const last = out.split('\n').pop()!
    expect(last).toMatch(/^a\) p26/)
  })

  it('convertHeadingNumberingToRomanText converts numbered headings', () => {
    const out = _romanText('# 1. intro\n## 2. body\n### 4. end')
    expect(out).toBe('# I. intro\n## II. body\n### IV. end')
  })

  it('convertHeadingNumberingToRomanText skips code fences', () => {
    const src = '```\n## 1. inside\n```\n## 2. outside'
    const out = _romanText(src)
    expect(out).toContain('## 1. inside')
    expect(out).toContain('## II. outside')
  })

  it('convertHeadingNumberingToRomanText leaves non-numbered headings alone', () => {
    expect(_romanText('# Hello')).toBe('# Hello')
  })

  it('smartIndentBulletByLevelText normalizes odd-space indents to multiples of 2', () => {
    const src = '- a\n   - b\n      - c'
    const out = _indentBulletText(src)
    const lines = out.split('\n')
    expect(lines[0]).toBe('- a')
    expect(lines[1]).toBe('    - b')
    expect(lines[2]).toBe('      - c')
  })

  it('smartIndentBulletByLevelText leaves code fences untouched', () => {
    const src = '```\n - a\n```'
    const out = _indentBulletText(src)
    expect(out).toContain(' - a')
  })

  it('paragraphsToTaskAssignedTableText produces 3-col table', () => {
    const out = _taskTableText('do laundry\nfile taxes')
    expect(out).toContain('| Task | Owner | Due Date |')
    expect(out).toContain('| do laundry | TBD | TBD |')
    expect(out).toContain('| file taxes | TBD | TBD |')
  })

  it('bracketAroundNumbersInBulletsText wraps bare numbers in brackets', () => {
    const src = '- step 3 done'
    expect(_bracketNumText(src)).toBe('- step [3] done')
  })

  it('bracketAroundNumbersInBulletsText preserves already-bracketed numbers', () => {
    const src = '- [42] already'
    expect(_bracketNumText(src)).toBe('- [42] already')
  })

  it('bracketAroundNumbersInBulletsText skips code blocks', () => {
    const src = '- step 3\n```\n- step 5\n```'
    const out = _bracketNumText(src)
    expect(out).toContain('- step [3]')
    expect(out).toContain('- step 5')
  })
})

import {
  paragraphsToHeatmapTableText as _heatmapText,
  bulletsToFooterReferencesText as _footerRefsText,
  paragraphsToCardsText as _cardsText,
  tableRowsToBulletPointsText as _tableToBulletsText,
  uppercaseAcronymsInTextText as _acronymsText,
} from './commands'

describe('batch209-text-helpers', () => {
  it('paragraphsToHeatmapTableText emits 4-week table with day headers', () => {
    const src = Array.from({ length: 28 }, (_, i) => `d${i}`).join('\n')
    const out = _heatmapText(src)
    expect(out).toContain('| Week | Mon | Tue | Wed | Thu | Fri | Sat | Sun |')
    expect(out).toContain('Week 1')
    expect(out).toContain('Week 4')
  })

  it('paragraphsToHeatmapTableText fills missing days with dot', () => {
    const out = _heatmapText('only')
    expect(out).toContain('only')
    expect(out).toContain('·')
  })

  it('bulletsToFooterReferencesText extracts inline links to footer refs', () => {
    const src = '- [openai](https://openai.com) is a research lab\n- [google](https://google.com) is a search engine'
    const out = _footerRefsText(src)
    expect(out).toContain('- [openai][1]')
    expect(out).toContain('- [google][2]')
    expect(out).toContain('[1]: https://openai.com "openai"')
    expect(out).toContain('[2]: https://google.com "google"')
  })

  it('bulletsToFooterReferencesText returns source unchanged if no links', () => {
    const src = '- just text'
    expect(_footerRefsText(src)).toBe(src)
  })

  it('bulletsToFooterReferencesText skips code fences', () => {
    const src = '```\n- [a](https://x)\n```'
    expect(_footerRefsText(src)).toBe(src)
  })

  it('paragraphsToCardsText wraps each block as a callout card', () => {
    const out = _cardsText('Title 1\nBody 1\n\nTitle 2\nBody 2')
    expect(out).toContain('> [!card] Title 1')
    expect(out).toContain('> Body 1')
    expect(out).toContain('> [!card] Title 2')
  })

  it('tableRowsToBulletPointsText converts simple table to bullets', () => {
    const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
    const out = _tableToBulletsText(src)
    expect(out).toContain('- **Name**: Alice · **Age**: 30')
    expect(out).toContain('- **Name**: Bob · **Age**: 25')
  })

  it('tableRowsToBulletPointsText leaves non-table lines alone', () => {
    const src = '# heading\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n# footer'
    const out = _tableToBulletsText(src)
    expect(out).toContain('# heading')
    expect(out).toContain('# footer')
    expect(out).toContain('- **A**: 1 · **B**: 2')
  })

  it('uppercaseAcronymsInTextText upcases known acronyms', () => {
    expect(_acronymsText('use the api with json over https')).toBe(
      'use the API with JSON over HTTPS',
    )
  })

  it('uppercaseAcronymsInTextText skips fenced code', () => {
    const src = '```\nlowercase api\n```\nuse api'
    const out = _acronymsText(src)
    expect(out).toContain('lowercase api')
    expect(out).toContain('use API')
  })

  it('uppercaseAcronymsInTextText leaves arbitrary words alone', () => {
    expect(_acronymsText('hello world')).toBe('hello world')
  })

  it('uppercaseAcronymsInTextText accepts custom acronym list', () => {
    expect(_acronymsText('foo bar baz', ['foo', 'baz'])).toBe('FOO bar BAZ')
  })
})

import {
  tagKanbanLanesByLabelText as _kanbanLabel,
  relabelCalloutTypeText as _calloutRelabel,
  countSentencesPerParagraphText as _sentCountText,
  sentencesToOrderedListText as _sentToOrderedText,
  tasksToBoardSwimlaneText as _swimlaneText,
  moveLinesByPatternToTopText as _moveToTopText,
} from './commands'

describe('batch210-text-helpers', () => {
  it('tagKanbanLanesByLabelText prefixes label to H2 lanes', () => {
    const out = _kanbanLabel('## Todo\n## In Progress\n## Done')
    expect(out).toBe('## 🏷️ Todo\n## 🏷️ In Progress\n## 🏷️ Done')
  })

  it('tagKanbanLanesByLabelText is idempotent', () => {
    const once = _kanbanLabel('## Todo')
    const twice = _kanbanLabel(once)
    expect(once).toBe(twice)
  })

  it('relabelCalloutTypeText swaps callout kind', () => {
    const src = '> [!warning] heads up\n> body'
    expect(_calloutRelabel(src, 'warning', 'caution')).toContain('> [!caution]')
  })

  it('relabelCalloutTypeText handles +/- modifier', () => {
    const src = '> [!info]+ details'
    const out = _calloutRelabel(src, 'info', 'note')
    expect(out).toBe('> [!note]+ details')
  })

  it('countSentencesPerParagraphText annotates each paragraph', () => {
    const src = 'Hello world. This is two.'
    const out = _sentCountText(src)
    expect(out).toContain('<!-- sentences: 2 -->')
  })

  it('countSentencesPerParagraphText skips headings', () => {
    const src = '# Title'
    const out = _sentCountText(src)
    expect(out).not.toContain('<!-- sentences')
  })

  it('sentencesToOrderedListText splits at . ! ?', () => {
    const out = _sentToOrderedText('First. Second! Third?')
    expect(out).toBe('1. First.\n2. Second!\n3. Third?')
  })

  it('sentencesToOrderedListText handles cjk punctuation', () => {
    const out = _sentToOrderedText(String.fromCodePoint(0x4f60, 0x597d, 0x3002, 0x4e16, 0x754c, 0xff01, 0x518d, 0x89c1, 0xff1f))
    expect(out.split('\n')).toHaveLength(3)
  })

  it('tasksToBoardSwimlaneText groups tasks by checkbox state', () => {
    const src = '- [ ] a\n- [x] b\n- [-] c\n- [/] d'
    const out = _swimlaneText(src)
    expect(out).toContain('## TODO\n- a')
    expect(out).toContain('## DOING\n- d')
    expect(out).toContain('## DONE\n- b')
    expect(out).toContain('## BLOCKED\n- c')
  })

  it('tasksToBoardSwimlaneText ignores non-task lines', () => {
    const src = '# title\n\n- [ ] task'
    const out = _swimlaneText(src)
    expect(out).toContain('## TODO\n- task')
    expect(out).not.toContain('title')
  })

  it('moveLinesByPatternToTopText reorders matching lines first', () => {
    const src = '- [ ] a\n- [ ] b !!\n- [ ] c'
    const out = _moveToTopText(src, /!!/)
    const idxB = out.indexOf('b !!')
    const idxA = out.indexOf('] a')
    expect(idxB).toBeLessThan(idxA)
  })

  it('moveLinesByPatternToTopText preserves order within group', () => {
    const src = 'high1 !!\nmid\nhigh2 !!\nlow'
    const out = _moveToTopText(src, /!!/)
    expect(out.indexOf('high1')).toBeLessThan(out.indexOf('high2'))
    expect(out.indexOf('high2')).toBeLessThan(out.indexOf('mid'))
    expect(out.indexOf('mid')).toBeLessThan(out.indexOf('low'))
  })
})

import {
  mergeTablesByFirstColumnText as _mergeTables,
  listDedupCaseInsensitiveText as _listDedupCi,
  annotateLinksWithDomainText as _annotateDomain,
  paragraphsToReverseTimelineText as _reverseTimeline,
  quoteRangeToBlockquoteText as _rangeToQuote,
  paragraphsToFaqTextWithCount as _faqCount,
} from './commands'

describe('batch211-text-helpers', () => {
  it('mergeTablesByFirstColumnText unions columns by key', () => {
    const src =
      '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n\n' +
      '| Name | City |\n| --- | --- |\n| Alice | Tokyo |\n| Carol | Berlin |'
    const out = _mergeTables(src)
    expect(out).toContain('| Name | Age | City |')
    expect(out).toMatch(/\| Alice \| 30 \| Tokyo \|/)
    expect(out).toMatch(/\| Bob \| 25 \|\s*\|/)
    expect(out).toMatch(/\| Carol \|\s*\| Berlin \|/)
  })

  it('mergeTablesByFirstColumnText leaves single table alone', () => {
    const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |'
    expect(_mergeTables(src)).toBe(src)
  })

  it('listDedupCaseInsensitiveText drops repeated bullets ignoring case', () => {
    const src = '- Apple\n- apple\n- BANANA\n- banana\n- Pear'
    const out = _listDedupCi(src)
    const lines = out.split('\n')
    expect(lines).toEqual(['- Apple', '- BANANA', '- Pear'])
  })

  it('listDedupCaseInsensitiveText respects code fences', () => {
    const src = '- a\n- a\n```\n- a\n- a\n```'
    const out = _listDedupCi(src)
    expect(out.split('\n').filter((l) => l === '- a')).toHaveLength(3)
  })

  it('annotateLinksWithDomainText appends host to link text', () => {
    const src = '[Anthropic](https://anthropic.com/about)'
    expect(_annotateDomain(src)).toBe('[Anthropic — anthropic.com](https://anthropic.com/about)')
  })

  it('annotateLinksWithDomainText is idempotent', () => {
    const once = _annotateDomain('[Anthropic](https://anthropic.com)')
    const twice = _annotateDomain(once)
    expect(twice).toBe(once)
  })

  it('paragraphsToReverseTimelineText reverses and prefixes T-N', () => {
    const src = 'first\n\nsecond\n\nthird'
    const out = _reverseTimeline(src)
    expect(out).toMatch(/### T-0\nthird/)
    expect(out).toMatch(/### T-2\nfirst/)
  })

  it('quoteRangeToBlockquoteText prefixes each line', () => {
    const out = _rangeToQuote('a\nb\n\nc')
    expect(out).toBe('> a\n> b\n>\n> c')
  })

  it('quoteRangeToBlockquoteText accepts custom prefix', () => {
    const out = _rangeToQuote('hi', '>> ')
    expect(out).toBe('>> hi')
  })

  it('paragraphsToFaqTextWithCount numbers questions', () => {
    const src = 'How to install?\nRun npm install.\n\nHow to test?\nRun npm test.'
    const out = _faqCount(src)
    expect(out).toContain('### Q1: How to install?')
    expect(out).toContain('### Q2: How to test?')
    expect(out).toContain('Run npm install.')
  })

  it('paragraphsToFaqTextWithCount handles single block', () => {
    const out = _faqCount('Lonely line')
    expect(out.startsWith('### Q1:')).toBe(true)
  })
})

import {
  numbersToSparklineText as _sparkline,
  countTagOccurrencesText as _tagCount,
  normalizeHorizontalRulesToDashesText as _hrNorm,
  paragraphsToCalloutByLengthText as _calloutByLen,
  stripWikilinkAliasText as _stripAlias,
  listToBulletStarText as _bulletStar,
  joinShortLinesText as _joinShortLines,
} from './commands'

describe('batch212-text-helpers', () => {
  it('numbersToSparklineText appends bars from numeric line', () => {
    const out = _sparkline('1 4 8 2 6')
    expect(out).toMatch(/^1 4 8 2 6 {2}[▁▂▃▄▅▆▇█]{5}$/)
  })

  it('numbersToSparklineText leaves lines with <2 nums untouched', () => {
    expect(_sparkline('only 42')).toBe('only 42')
    expect(_sparkline('no numbers')).toBe('no numbers')
  })

  it('countTagOccurrencesText returns sorted table', () => {
    const out = _tagCount('#foo bar #foo #baz #foo and #baz')
    const lines = out.split('\n')
    expect(lines[0]).toContain('Tag')
    expect(lines[2]).toContain('#foo')
    expect(lines[2]).toContain('3')
    expect(lines[3]).toContain('#baz')
  })

  it('countTagOccurrencesText says no tags when empty', () => {
    expect(_tagCount('plain text')).toBe('_No tags_')
  })

  it('normalizeHorizontalRulesText collapses ___ and *** to ---', () => {
    expect(_hrNorm('___\n***\n----\nrest')).toBe('---\n---\n---\nrest')
  })

  it('normalizeHorizontalRulesText leaves bullet * alone', () => {
    expect(_hrNorm('* item')).toBe('* item')
  })

  it('paragraphsToCalloutByLengthText picks kind by length', () => {
    const short = 'short bit'
    const mid = 'a'.repeat(100)
    const long = 'a'.repeat(250)
    const out = _calloutByLen(`${short}\n\n${mid}\n\n${long}`)
    expect(out).toContain('> [!note]')
    expect(out).toContain('> [!info]')
    expect(out).toContain('> [!tip]')
  })

  it('stripWikilinkAliasText removes |alias', () => {
    expect(_stripAlias('see [[Page|alias text]] now')).toBe('see [[Page]] now')
  })

  it('stripWikilinkAliasText leaves plain wikilink', () => {
    expect(_stripAlias('[[Page]]')).toBe('[[Page]]')
  })

  it('listToBulletStarText converts - / + to *', () => {
    expect(_bulletStar('- one\n+ two\n  - nested')).toBe('* one\n* two\n  * nested')
  })

  it('joinShortLinesText merges adjacent short lines', () => {
    const src = 'foo\nbar\nbaz'
    expect(_joinShortLines(src)).toBe('foo bar baz')
  })

  it('joinShortLinesText preserves headings and bullets', () => {
    const src = '# Title\n- item\nnot list'
    const out = _joinShortLines(src)
    expect(out).toContain('# Title')
    expect(out).toContain('- item')
    expect(out).toContain('not list')
  })
})

import {
  normalizeHashtagSpacingText as _hashSpace,
  trimTrailingPunctuationInHeadingsText as _trimHeadPunct,
  lineRangeToCheckboxesText as _toChecks,
  paragraphsToCheatSheetText as _cheatSheet,
  uppercaseFirstLetterPerLineText as _upperFirst,
} from './commands'

describe('batch213-text-helpers', () => {
  it('normalizeHashtagSpacingText inserts space before tag', () => {
    expect(_hashSpace('hello#world')).toBe('hello #world')
  })

  it('normalizeHashtagSpacingText leaves leading tags alone', () => {
    expect(_hashSpace('#foo and #bar')).toBe('#foo and #bar')
  })

  it('normalizeHashtagSpacingText skips code fences', () => {
    expect(_hashSpace('```\nx#y\n```')).toBe('```\nx#y\n```')
  })

  it('trimTrailingPunctuationInHeadingsText strips final punctuation', () => {
    expect(_trimHeadPunct('# Hello.')).toBe('# Hello')
    const title = String.fromCodePoint(0x6807, 0x9898)
    expect(_trimHeadPunct(`## ${title}${String.fromCodePoint(0x3002)}`)).toBe(`## ${title}`)
    expect(_trimHeadPunct('### Tip!')).toBe('### Tip')
  })

  it('trimTrailingPunctuationInHeadingsText leaves body lines alone', () => {
    expect(_trimHeadPunct('not a heading.')).toBe('not a heading.')
  })

  it('lineRangeToCheckboxesText wraps loose lines in checkboxes', () => {
    expect(_toChecks('a\nb')).toBe('- [ ] a\n- [ ] b')
  })

  it('lineRangeToCheckboxesText leaves existing tasks alone', () => {
    expect(_toChecks('- [ ] keep\n- [x] done')).toBe('- [ ] keep\n- [x] done')
  })

  it('lineRangeToCheckboxesText adds checkbox to plain bullet', () => {
    expect(_toChecks('- item')).toBe('- [ ] item')
  })

  it('paragraphsToCheatSheetText emits term : definition format', () => {
    const src = 'Term\ndefinition body\n\nAnother\nmore text'
    const out = _cheatSheet(src)
    expect(out).toContain('**Term**\n: definition body')
    expect(out).toContain('**Another**\n: more text')
  })

  it('uppercaseFirstLetterPerLineText capitalizes plain lines', () => {
    expect(_upperFirst('hello\nworld')).toBe('Hello\nWorld')
  })

  it('uppercaseFirstLetterPerLineText keeps bullet prefix', () => {
    expect(_upperFirst('- hello\n* world')).toBe('- Hello\n* World')
  })

  it('uppercaseFirstLetterPerLineText keeps heading prefix', () => {
    expect(_upperFirst('# title\n## subtitle')).toBe('# Title\n## Subtitle')
  })
})

import {
  normalizeColonSpacingText as _colonSpace,
  indentBlockquoteByOneText as _bqIndent,
  paragraphsToFlashFictionText as _flashFiction,
  paragraphsToOneLinerSummariesText as _oneLiner,
  reverseListOrderText as _listReverse,
} from './commands'

describe('batch214-text-helpers', () => {
  it('normalizeColonSpacingText inserts space after colon', () => {
    expect(_colonSpace('name:Alice')).toBe('name: Alice')
  })

  it('normalizeColonSpacingText preserves http:// urls', () => {
    expect(_colonSpace('see https://x/y')).toBe('see https://x/y')
    expect(_colonSpace('go http://abc/def')).toBe('go http://abc/def')
  })

  it('normalizeColonSpacingText leaves multi-already-spaced alone', () => {
    expect(_colonSpace('name: Alice')).toBe('name: Alice')
  })

  it('normalizeColonSpacingText skips code fences', () => {
    expect(_colonSpace('```\nfoo:bar\n```')).toBe('```\nfoo:bar\n```')
  })

  it('indentBlockquoteByOneText prepends > to blockquote lines', () => {
    expect(_bqIndent('> a\n> b\nplain')).toBe('>> a\n>> b\nplain')
  })

  it('paragraphsToFlashFictionText annotates word count', () => {
    const out = _flashFiction('one two three\n\nfour five')
    expect(out).toContain('### #1 · 3 words')
    expect(out).toContain('### #2 · 2 words')
  })

  it('paragraphsToOneLinerSummariesText trims to 12 words', () => {
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    const out = _oneLiner(long)
    expect(out.endsWith('…')).toBe(true)
    const words = out.replace(/^- /, '').replace('…', '').split(' ')
    expect(words).toHaveLength(12)
  })

  it('paragraphsToOneLinerSummariesText keeps short paragraphs whole', () => {
    expect(_oneLiner('short one')).toBe('- short one')
  })

  it('reverseListOrderText reverses bullet groups', () => {
    const out = _listReverse('- a\n- b\n- c')
    expect(out).toBe('- c\n- b\n- a')
  })

  it('reverseListOrderText reverses ordered lists', () => {
    const out = _listReverse('1. a\n2. b\n3. c')
    expect(out).toBe('3. c\n2. b\n1. a')
  })

  it('reverseListOrderText preserves non-list lines and group boundaries', () => {
    const out = _listReverse('# Title\n- a\n- b\n\n- x\n- y')
    expect(out).toBe('# Title\n- b\n- a\n\n- y\n- x')
  })
})

import {
  paragraphsToGlossaryIndexText as _glossaryIdx,
  normalizeTrailingWhitespaceText as _trailWs,
  bulletsToPriorityMatrixText as _prioMatrix,
  linesToQuoteCardsText as _quoteCards,
} from './commands'

describe('batch215-text-helpers', () => {
  it('paragraphsToGlossaryIndexText extracts term and sorts', () => {
    const out = _glossaryIdx('Banana: yellow fruit\n\nApple: red fruit')
    expect(out.startsWith('## Glossary Index')).toBe(true)
    const idxA = out.indexOf('Apple')
    const idxB = out.indexOf('Banana')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(-1)
    expect(idxA).toBeLessThan(idxB)
  })

  it('paragraphsToGlossaryIndexText splits on first whitespace as fallback', () => {
    const out = _glossaryIdx('foobar is a thing')
    expect(out).toContain('**foobar** — is a thing')
  })

  it('normalizeTrailingWhitespaceText strips trailing spaces and tabs', () => {
    const out = _trailWs('hello   \nworld\t\t\nfoo')
    expect(out).toBe('hello\nworld\nfoo')
  })

  it('normalizeTrailingWhitespaceText preserves leading whitespace', () => {
    const out = _trailWs('  indented   ')
    expect(out).toBe('  indented')
  })

  it('bulletsToPriorityMatrixText buckets by markers', () => {
    const src = '- !!! urgent thing\n- !! important thing\n- ! normal\n- low effort'
    const out = _prioMatrix(src)
    expect(out).toContain('### P0')
    expect(out).toContain('- urgent thing')
    expect(out).toContain('### P1')
    expect(out).toContain('- important thing')
    expect(out).toContain('### P3')
    expect(out).toContain('- low effort')
  })

  it('bulletsToPriorityMatrixText handles #p0 tag', () => {
    const out = _prioMatrix('- ship the thing #p0')
    expect(out).toContain('### P0')
    expect(out).toContain('- ship the thing')
  })

  it('bulletsToPriorityMatrixText shows empty placeholders for empty buckets', () => {
    const out = _prioMatrix('- regular task')
    expect(out).toContain('### P0 — Urgent and Important\n- (empty)')
  })

  it('linesToQuoteCardsText wraps each line as quote card', () => {
    const out = _quoteCards('hello\nworld')
    expect(out).toContain('> 💬')
    expect(out).toContain('> hello')
    expect(out).toContain('> world')
    expect((out.match(/---/g) || []).length).toBe(2)
  })

  it('linesToQuoteCardsText returns source when empty', () => {
    expect(_quoteCards('   \n\n  ')).toBe('   \n\n  ')
  })
})

import {
  paragraphsToPullQuotesText as _pullQuotes,
  paragraphsToStudyCardsText as _studyCards,
  normalizeOrderedListToDashesText as _olToDash,
  paragraphsToTLDRWithBulletsText as _tldrBullets,
  bulletsToSWOTByEmojiText as _swotEmoji,
  linesReverseWithIndexText as _revIdx,
} from './commands'

describe('batch216-text-helpers', () => {
  it('paragraphsToPullQuotesText alternates raw and quote', () => {
    const out = _pullQuotes('first para\n\nsecond para\n\nthird para')
    expect(out).toContain('first para')
    expect(out).toContain('> 🪶 *second para*')
    expect(out).toContain('third para')
    expect(out).not.toContain('> 🪶 *third para*')
  })

  it('paragraphsToStudyCardsText splits Q : A on colon', () => {
    const out = _studyCards('What is React: A UI library')
    expect(out).toContain('### Q1. What is React')
    expect(out).toContain('A UI library')
    expect(out).toContain('<details>')
  })

  it('paragraphsToStudyCardsText shows placeholder when no separator', () => {
    const out = _studyCards('just a statement')
    expect(out).toContain('### Q1. just a statement')
    expect(out).toContain('(to be completed)')
  })

  it('normalizeOrderedListToDashesText converts numbered to dash', () => {
    const out = _olToDash('1. apple\n2. banana\n   3. nested\nnot a list')
    expect(out).toBe('- apple\n- banana\n   - nested\nnot a list')
  })

  it('paragraphsToTLDRWithBulletsText extracts first sentence and 3 bullets', () => {
    const src = 'opener sentence. continued.\n\np2 first. p2 rest.\n\np3 first.\n\np4 first.\n\np5 first.'
    const out = _tldrBullets(src)
    expect(out).toContain('> [!tip]+ TL;DR')
    expect(out).toContain('> opener sentence.')
    expect((out.match(/^- /gm) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('bulletsToSWOTByEmojiText buckets by emoji and prefix', () => {
    const src = '- 💪 strong team\n- ⚠️ tight budget\n- 🚀 new market\n- 🔴 competitor X'
    const out = _swotEmoji(src)
    expect(out).toContain('### Strengths')
    expect(out).toContain('- strong team')
    expect(out).toContain('### Weaknesses')
    expect(out).toContain('- tight budget')
    expect(out).toContain('### Threats')
    expect(out).toContain('- competitor X')
  })

  it('bulletsToSWOTByEmojiText supports S:/W:/T: prefix', () => {
    const out = _swotEmoji('- S: skilled team\n- W: limited runway')
    expect(out).toContain('- skilled team')
    expect(out).toContain('- limited runway')
  })

  it('linesReverseWithIndexText reverses and numbers', () => {
    const out = _revIdx('a\nb\nc')
    expect(out).toBe('1. c\n2. b\n3. a')
  })

  it('linesReverseWithIndexText returns source on empty', () => {
    expect(_revIdx('  ')).toBe('  ')
  })
})

import {
  paragraphsToHeadlinesText as _headlines,
  linesShuffleText as _shuffle,
  paragraphsToKeyTakeawaysText as _takeaways,
  bulletsByDayOfWeekText as _dow,
  paragraphsToOnePagerText as _onePager,
  normalizeBlankLinesMax1Text as _maxBlank,
} from './commands'

describe('batch217-text-helpers', () => {
  it('paragraphsToHeadlinesText truncates to 60 chars with ellipsis', () => {
    const long = 'a'.repeat(80)
    const out = _headlines(long)
    expect(out).toContain('1. ')
    const numbered = out.split('\n').find((l) => l.startsWith('1. ')) ?? ''
    expect(numbered.length).toBeLessThanOrEqual(64)
    expect(numbered.endsWith('…')).toBe(true)
  })

  it('paragraphsToHeadlinesText strips trailing punctuation', () => {
    const out = _headlines('Short headline. extra')
    expect(out).toContain('1. Short headline')
    expect(out).not.toContain('1. Short headline.')
  })

  it('linesShuffleText preserves all lines', () => {
    const src = 'a\nb\nc\nd\ne'
    const out = _shuffle(src)
    expect(out.split('\n').sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('linesShuffleText returns source on empty', () => {
    expect(_shuffle('\n\n')).toBe('\n\n')
  })

  it('paragraphsToKeyTakeawaysText emits one bullet per paragraph', () => {
    const out = _takeaways('First idea. Detail.\n\nSecond idea.')
    expect(out).toContain('## Key Takeaways')
    expect(out).toContain('- First idea.')
    expect(out).toContain('- Second idea.')
    expect((out.match(/^- /gm) || []).length).toBe(2)
  })

  it('bulletsByDayOfWeekText cycles 7 days', () => {
    const src = Array.from({ length: 9 }, (_, i) => `- task ${i + 1}`).join('\n')
    const out = _dow(src)
    expect(out).toContain('- **Monday** — task 1')
    expect(out).toContain('- **Sunday** — task 7')
    expect(out).toContain('- **Monday** — task 8')
    expect(out).toContain('- **Tuesday** — task 9')
  })

  it('bulletsByDayOfWeekText returns source if no bullets', () => {
    expect(_dow('just text')).toBe('just text')
  })

  it('paragraphsToOnePagerText fills slots in order', () => {
    const out = _onePager('summary line\n\nbecause reason\n\nstep 1\n\nrisk A')
    expect(out).toContain('### TL;DR\nsummary line')
    expect(out).toContain('### Why\nbecause reason')
    expect(out).toContain('### How\nstep 1')
    expect(out).toContain('### Risks\nrisk A')
  })

  it('paragraphsToOnePagerText uses placeholder for missing slots', () => {
    const out = _onePager('only summary')
    expect(out).toContain('### Why\n_(to be completed)_')
    expect(out).toContain('### How\n_(to be completed)_')
    expect(out).toContain('### Risks\n_(to be completed)_')
  })

  it('normalizeBlankLinesMax1Text collapses 3+ blanks to 1', () => {
    const out = _maxBlank('a\n\n\n\nb\n\nc')
    expect(out).toBe('a\n\nb\n\nc')
  })

  it('normalizeBlankLinesMax1Text preserves single blank', () => {
    expect(_maxBlank('a\n\nb')).toBe('a\n\nb')
  })
})

import {
  paragraphsToActionRegisterText as _actionReg,
  linesToTableWithIndexText as _linesIdxTable,
  paragraphsToTalkOutlineText as _talkOutline,
  tagStatsTop5Text as _tagTop5,
  paragraphsToPodcastNotesText as _podcast,
  normalizeFenceLanguageText as _fenceLang,
  joinLinesAsSentencesText as _joinSent,
} from './commands'

describe('batch218-text-helpers', () => {
  it('paragraphsToActionRegisterText emits table row per paragraph', () => {
    const out = _actionReg('first task. extra\n\nsecond task')
    expect(out).toContain('| # | Action | Owner | Due | Status |')
    expect(out).toContain('| 1 | first task. | TBD | TBD | Not started |')
    expect(out).toContain('| 2 | second task | TBD | TBD | Not started |')
  })

  it('linesToTableWithIndexText escapes pipes', () => {
    const out = _linesIdxTable('apple | red\nbanana')
    expect(out).toContain('| 1 | apple \\| red |')
    expect(out).toContain('| 2 | banana |')
  })

  it('paragraphsToTalkOutlineText fills 4 slots', () => {
    const out = _talkOutline('hook\n\nproblem\n\nsolution\n\nask')
    expect(out).toContain('### 🪝 Hook\nhook')
    expect(out).toContain('### ❓ Problem\nproblem')
    expect(out).toContain('### 💡 Solution\nsolution')
    expect(out).toContain('### 🙏 Ask\nask')
  })

  it('tagStatsTop5Text counts and sorts by count desc', () => {
    const out = _tagTop5('hello #a #b #a body #c #a (#b) #d #e #f')
    expect(out).toContain('## Top 5 Tags')
    const aLine = out.split('\n').find((l) => l.startsWith('- #a'))
    expect(aLine).toContain('3 occurrences')
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.length).toBe(5)
  })

  it('tagStatsTop5Text shows placeholder when no tags', () => {
    const out = _tagTop5('plain text')
    expect(out).toContain('_(no tags)_')
  })

  it('paragraphsToPodcastNotesText adds timestamps spaced 5 min', () => {
    const out = _podcast('intro\n\nmain point\n\nclosing')
    expect(out).toContain('[00:00]')
    expect(out).toContain('[05:00]')
    expect(out).toContain('[10:00]')
  })

  it('normalizeFenceLanguageText adds txt to empty fence', () => {
    const out = _fenceLang('```\ncode\n```')
    expect(out).toBe('```txt\ncode\n```')
  })

  it('normalizeFenceLanguageText preserves existing language', () => {
    const out = _fenceLang('```js\ncode\n```')
    expect(out).toBe('```js\ncode\n```')
  })

  it('normalizeFenceLanguageText skips closing fence', () => {
    const out = _fenceLang('```python\nx=1\n```\n\n```\ny=2\n```')
    expect(out).toContain('```python\n')
    expect(out).toContain('```txt\n')
  })

  it('joinLinesAsSentencesText adds periods and joins', () => {
    const out = _joinSent('first thought\nsecond thought.\nthird')
    expect(out).toBe('first thought. second thought. third.')
  })

  it('joinLinesAsSentencesText returns source on empty', () => {
    expect(_joinSent('  ')).toBe('  ')
  })
})

import {
  paragraphsToStoryPitchText as _storyPitch,
  bulletsNestByDepthMarkerText as _nestDepth,
  paragraphsToFAQShortText as _faqShort,
  renumberOrderedListText as _renumOL,
  paragraphsToMemoText as _memo,
  wrapLinesInParensText as _wrapParens,
} from './commands'

describe('batch219-text-helpers', () => {
  it('paragraphsToStoryPitchText extracts logline', () => {
    const out = _storyPitch('A boy meets a robot.\n\nSecond paragraph.\n\nThird.')
    expect(out).toContain('### Logline')
    expect(out).toContain('> A boy meets a robot.')
    expect(out).toContain('### Synopsis')
  })

  it('bulletsNestByDepthMarkerText nests by > depth', () => {
    const src = '> top\n>> mid\n>>> deep'
    const out = _nestDepth(src)
    expect(out).toBe('- top\n  - mid\n    - deep')
  })

  it('bulletsNestByDepthMarkerText flattens plain bullets', () => {
    const out = _nestDepth('- plain')
    expect(out).toBe('- plain')
  })

  it('paragraphsToFAQShortText splits Q/A on colon', () => {
    const out = _faqShort('What is X: A tool')
    expect(out).toContain('**Q: What is X**')
    expect(out).toContain('A: A tool')
  })

  it('paragraphsToFAQShortText placeholder when no separator', () => {
    const out = _faqShort('just a statement here')
    expect(out).toContain('**Q: just a statement here**')
    expect(out).toContain('_(to be completed)_')
  })

  it('renumberOrderedListText restarts numbering at 1', () => {
    const src = '5. first\n7. second\n9. third'
    const out = _renumOL(src)
    expect(out).toBe('1. first\n2. second\n3. third')
  })

  it('renumberOrderedListText handles nested indented lists', () => {
    const src = '1. a\n  1. nested a1\n  1. nested a2\n1. b'
    const out = _renumOL(src)
    expect(out).toBe('1. a\n  1. nested a1\n  2. nested a2\n2. b')
  })

  it('paragraphsToMemoText includes today date', () => {
    const out = _memo('first para\n\nsecond para')
    expect(out).toContain('**TO**:')
    expect(out).toContain('**FROM**:')
    expect(out).toMatch(/\*\*DATE\*\*: \d{4}-\d{2}-\d{2}/)
    expect(out).toContain('first para')
    expect(out).toContain('second para')
  })

  it('wrapLinesInParensText wraps each non-empty line', () => {
    const out = _wrapParens('hello\n\nworld')
    expect(out).toBe('(hello)\n\n(world)')
  })

  it('wrapLinesInParensText preserves empty lines', () => {
    expect(_wrapParens('a\n\n\nb')).toBe('(a)\n\n\n(b)')
  })
})

import {
  paragraphsToArgumentStructureText as _argStruct,
  bulletsToBingoCardText as _bingo,
  paragraphsToAphorismCardsText as _aphorism,
  linesToIndexedFAQText as _idxFaq,
  normalizeBulletMarkerToDotText as _dotBullet,
  paragraphsToThesisStatementText as _thesis,
  stripDiacriticsText as _stripD,
} from './commands'

describe('batch220-text-helpers', () => {
  it('paragraphsToArgumentStructureText fills 5 slots', () => {
    const out = _argStruct('claim\n\nreason\n\nevidence\n\ncounter\n\nrebuttal')
    expect(out).toContain('### Claim\nclaim')
    expect(out).toContain('### Reason\nreason')
    expect(out).toContain('### Evidence\nevidence')
    expect(out).toContain('### Counterargument\ncounter')
    expect(out).toContain('### Rebuttal\nrebuttal')
  })

  it('paragraphsToArgumentStructureText uses placeholder for missing', () => {
    const out = _argStruct('claim only')
    expect(out).toContain('### Reason\n_(to be completed)_')
  })

  it('bulletsToBingoCardText emits 5x5 grid with FREE in middle', () => {
    const items = Array.from({ length: 30 }, (_, i) => `- item ${i + 1}`).join('\n')
    const out = _bingo(items)
    expect(out).toContain('## Bingo Card')
    expect(out).toContain('★ FREE ★')
    expect(out.split('\n').filter((l) => l.startsWith('| ')).length).toBe(6)
  })

  it('bulletsToBingoCardText pads with dashes when too few', () => {
    const out = _bingo('- only one item')
    expect(out).toContain('only one item')
    expect(out).toContain('—')
  })

  it('paragraphsToAphorismCardsText extracts first sentence per paragraph', () => {
    const out = _aphorism('Wisdom is short. More words.\n\nKindness is free.')
    expect(out).toContain('> [!quote]')
    expect(out).toContain('> Wisdom is short.')
    expect(out).toContain('> Kindness is free.')
  })

  it('linesToIndexedFAQText numbers each line as Q', () => {
    const out = _idxFaq('what is X\nwhy is Y')
    expect(out).toContain('1. **Q: what is X**')
    expect(out).toContain('2. **Q: why is Y**')
    expect(out).toContain('A: _(to be completed)_')
  })

  it('normalizeBulletMarkerToDotText replaces * bullet with •', () => {
    const out = _dotBullet('* one\n  * two\n- three')
    expect(out).toBe('• one\n  • two\n- three')
  })

  it('paragraphsToThesisStatementText produces composed sentence', () => {
    const out = _thesis('Remote work boosts productivity.\n\nFewer interruptions.')
    expect(out).toContain('**Claim**: Remote work boosts productivity.')
    expect(out).toContain('**Reason**: Fewer interruptions.')
    expect(out).toContain('**Thesis**: Remote work boosts productivity, because Fewer interruptions.')
  })

  it('stripDiacriticsText removes accents', () => {
    expect(_stripD('café résumé')).toBe('cafe resume')
  })

  it('stripDiacriticsText preserves ascii', () => {
    expect(_stripD('hello world')).toBe('hello world')
  })

  it('stripDiacriticsText preserves CJK', () => {
    const greeting = String.fromCodePoint(0x4f60, 0x597d)
    expect(_stripD(`${greeting} héllo`)).toBe(`${greeting} hello`)
  })
})

import {
  paragraphsToSalesPitchText as _salesPitch,
  bulletsToRadarChartText as _radar,
  paragraphsToStandupStatusText as _standupStatus,
  linesToReadingListText as _readList,
  paragraphsToTwitterThreadText as _twitterThread,
  normalizeMarkdownLinksToRefStyleText as _linksRef,
  headingsToTitleCaseText as _titleCase,
} from './commands'

describe('batch221-text-helpers', () => {
  it('paragraphsToSalesPitchText fills 4 slots', () => {
    const out = _salesPitch('the pain\n\nour fix\n\nthe value\n\nbook a demo')
    expect(out).toContain('### ❓ Problem\nthe pain')
    expect(out).toContain('### 💡 Solution\nour fix')
    expect(out).toContain('### 💎 Value\nthe value')
    expect(out).toContain('### 🚀 Call to Action\nbook a demo')
  })

  it('bulletsToRadarChartText extracts name and score', () => {
    const out = _radar('- speed: 8\n- quality: 7\n- price 9')
    expect(out).toContain('| Dimension | Score | Visualization |')
    expect(out).toContain('| speed | 8 |')
    expect(out).toContain('| quality | 7 |')
    expect(out).toContain('| price | 9 |')
  })

  it('bulletsToRadarChartText returns source if no scored bullets', () => {
    expect(_radar('- plain item')).toBe('- plain item')
  })

  it('paragraphsToStandupStatusText fills 3 slots', () => {
    const out = _standupStatus('finished feature X\n\nworking on Y\n\nwaiting on review')
    expect(out).toContain('### Yesterday\nfinished feature X')
    expect(out).toContain('### Today\nworking on Y')
    expect(out).toContain('### Blockers\nwaiting on review')
  })

  it('paragraphsToStandupStatusText placeholder for blockers when missing', () => {
    const out = _standupStatus('yesterday\n\ntoday')
    expect(out).toContain('### Blockers\n_(none)_')
  })

  it('linesToReadingListText creates checklist', () => {
    const out = _readList('Atomic Habits\nDeep Work')
    expect(out).toContain('- [ ] **Atomic Habits** — _author TBD_')
    expect(out).toContain('- [ ] **Deep Work** — _author TBD_')
  })

  it('paragraphsToTwitterThreadText numbers as N/total', () => {
    const out = _twitterThread('first tweet\n\nsecond tweet\n\nthird tweet')
    expect(out).toContain('### 1/3')
    expect(out).toContain('### 2/3')
    expect(out).toContain('### 3/3')
  })

  it('paragraphsToTwitterThreadText truncates over 280', () => {
    const long = 'x'.repeat(300)
    const out = _twitterThread(long)
    expect(out).toContain('...')
  })

  it('normalizeMarkdownLinksToRefStyleText extracts refs', () => {
    const src = 'see [docs](https://example.com) and [other](https://x.com)'
    const out = _linksRef(src)
    expect(out).toContain('[docs][1]')
    expect(out).toContain('[other][2]')
    expect(out).toContain('[1]: https://example.com')
    expect(out).toContain('[2]: https://x.com')
  })

  it('normalizeMarkdownLinksToRefStyleText dedups same url', () => {
    const out = _linksRef('[a](https://x.com) and [b](https://x.com)')
    expect(out).toContain('[a][1]')
    expect(out).toContain('[b][1]')
    expect(out.split('[1]: https://x.com').length).toBe(2)
  })

  it('normalizeMarkdownLinksToRefStyleText returns source if no links', () => {
    expect(_linksRef('plain text')).toBe('plain text')
  })

  it('headingsToTitleCaseText capitalizes major words', () => {
    expect(_titleCase('# the quick brown fox')).toBe('# The Quick Brown Fox')
  })

  it('headingsToTitleCaseText lowercases minor words mid-title', () => {
    expect(_titleCase('## A tale of two cities')).toBe('## A Tale of Two Cities')
  })

  it('headingsToTitleCaseText preserves non-heading lines', () => {
    expect(_titleCase('the cat sat')).toBe('the cat sat')
  })

  it('headingsToTitleCaseText preserves CJK', () => {
    const greeting = String.fromCodePoint(0x4f60, 0x597d)
    expect(_titleCase(`# ${greeting} world`)).toBe(`# ${greeting} World`)
  })
})

import {
  paragraphsToMeetingSummaryText as _meetSum,
  linesToHaikuText as _haiku,
  paragraphsToQuoteSandwichText as _quoteSw,
  bulletsToSwimLaneText as _swimLane,
  normalizeHeadingSpacingText as _headSp,
  headingsToNumberedTOCLinksText as _numToc,
  paragraphsToDemoScriptText as _demoScript,
  linesToABCPriorityText as _abcPrio,
  paragraphsToTestimonialWallText as _testimWall,
  bulletsToCommitmentLadderText as _commitLadder,
  paragraphsToSoundbitesText as _soundbites,
  normalizeEmphasisMarkersText as _emphMarks,
  paragraphsToStickyNoteBoardText as _stickyBoard,
  linesToParetoBarText as _pareto,
  paragraphsToCustomerJourneyMomentsText as _journeyMoments,
  bulletsToGitGraphMermaidText as _gitGraph,
  paragraphsToUserPersonaText as _persona,
  normalizeUnicodeWhitespaceText as _uniWs,
  paragraphsToExecutiveTalkingPointsText as _talkPts,
  linesToTierListText as _tierList,
  paragraphsToPressReleaseText as _pressRel,
  bulletsToChecklistSignedOffText as _signedCk,
  paragraphsToKPITreeNarrativeText as _kpiTree,
  normalizeOrderedListMarkersText as _olMarks,
  paragraphsToFAQRichAnswersText as _faqRich,
  linesToBalancedTreeAsciiText as _balTree,
  paragraphsToMeetingAgendaFromTopicsText as _agenda,
  bulletsToOutlineNumberedText as _outlineNum,
  paragraphsToPressHeadlineCandidatesText as _hlCand,
  normalizeEmptyBulletItemsText as _emptyBul,
} from './commands'

describe('batch222-text-helpers', () => {
  it('paragraphsToMeetingSummaryText buckets decisions/actions/notes', () => {
    const src = 'Decision: Use Postgres\n\nAction: Email legal (Alex)\n\nEveryone was engaged'
    const out = _meetSum(src)
    expect(out).toContain('### Decisions')
    expect(out).toContain('- Use Postgres')
    expect(out).toContain('### Action Items')
    expect(out).toContain('- [ ] Email legal')
    expect(out).toContain('(Alex)')
    expect(out).toContain('### Notes')
    expect(out).toContain('- Everyone was engaged')
  })

  it('paragraphsToMeetingSummaryText shows empty placeholders for empty buckets', () => {
    const out = _meetSum('decision: only one')
    expect(out).toContain('### Action Items\n- _(none)_')
    expect(out).toContain('### Notes\n- _(none)_')
  })

  it('linesToHaikuText estimates syllables for English', () => {
    const out = _haiku('hello world')
    expect(out).toContain('## Haiku Draft')
    expect(out).toMatch(/approximately \d+ syllables/)
  })

  it('linesToHaikuText estimates syllables for CJK', () => {
    const source = String.fromCodePoint(0x53e4, 0x6c60, 0x86d9, 0x8dc3)
    const out = _haiku(source)
    const line = out.split('\n').find((l) => l.includes(source)) ?? ''
    expect(line).toContain('approximately 4 syllables')
  })

  it('paragraphsToQuoteSandwichText groups in 3s', () => {
    const out = _quoteSw('intro one\n\nquote text\n\nanalysis here')
    expect(out).toContain('**Context**: intro one')
    expect(out).toContain('> quote text')
    expect(out).toContain('**Analysis**: analysis here')
    expect(out).toContain('---')
  })

  it('bulletsToSwimLaneText emits mermaid sequenceDiagram', () => {
    const src = '- Client: send request -> Server\n- Server: process\n- Server: respond -> Client'
    const out = _swimLane(src)
    expect(out).toContain('```mermaid')
    expect(out).toContain('sequenceDiagram')
    expect(out).toContain('participant Client')
    expect(out).toContain('participant Server')
    expect(out).toContain('Client->>+Server: send request')
  })

  it('bulletsToSwimLaneText returns source on no matches', () => {
    expect(_swimLane('- plain bullet')).toBe('- plain bullet')
  })

  it('normalizeHeadingSpacingText collapses multiple spaces', () => {
    expect(_headSp('#   title  ')).toBe('# title')
    expect(_headSp('##no-space')).toBe('## no-space')
  })

  it('normalizeHeadingSpacingText leaves non-headings alone', () => {
    expect(_headSp('plain   text  ')).toBe('plain   text  ')
  })

  it('headingsToNumberedTOCLinksText numbers and indents by level', () => {
    const src = '# Top\n## Sub\n### Deep'
    const out = _numToc(src)
    expect(out).toContain('## Table of Contents')
    expect(out).toContain('1. [Top](#top)')
    expect(out).toContain('  2. [Sub](#sub)')
    expect(out).toContain('    3. [Deep](#deep)')
    expect(out).toContain('# Top')
  })

  it('headingsToNumberedTOCLinksText returns source if no headings', () => {
    expect(_numToc('plain body')).toBe('plain body')
  })
})

describe('batch223-text-helpers', () => {
  it('paragraphsToDemoScriptText emits timed scenes', () => {
    const out = _demoScript('open the app\n\nclick the button')
    expect(out).toContain('## Demo Script')
    expect(out).toContain('[00:30] Scene 1')
    expect(out).toContain('[01:00] Scene 2')
    expect(out).toContain('**Narration**: open the app')
  })

  it('paragraphsToDemoScriptText returns source if empty', () => {
    expect(_demoScript('   ')).toBe('   ')
  })

  it('linesToABCPriorityText buckets by importance markers', () => {
    const src = '- !!! ship release\n- !! review docs\n- minor cleanup\n- #a hotfix bug'
    const out = _abcPrio(src)
    expect(out).toContain('### Class A - Must do')
    expect(out).toContain('- [A] ship release')
    expect(out).toContain('- [A] hotfix bug')
    expect(out).toContain('### Class B - Should do')
    expect(out).toContain('- [B] review docs')
    expect(out).toContain('### Class C - Could do')
    expect(out).toContain('- [C] minor cleanup')
  })

  it('linesToABCPriorityText returns source if no bullets', () => {
    expect(_abcPrio('plain text only')).toBe('plain text only')
  })

  it('paragraphsToTestimonialWallText parses author when dash present', () => {
    const src = 'great product — Alice CEO\n\nfast support'
    const out = _testimWall(src)
    expect(out).toContain('> "great product"')
    expect(out).toContain('> — Alice CEO')
    expect(out).toContain('> "fast support"')
    expect(out).toContain('> — Anonymous user')
  })

  it('bulletsToCommitmentLadderText nests with increasing indent', () => {
    const src = '- run\n- bike\n- swim'
    const out = _commitLadder(src)
    expect(out).toContain('- [ ] **Lv1** · run')
    expect(out).toContain('  - [ ] **Lv2** · bike')
    expect(out).toContain('    - [ ] **Lv3** · swim')
  })

  it('bulletsToCommitmentLadderText returns source on no bullets', () => {
    expect(_commitLadder('no bullets here')).toBe('no bullets here')
  })

  it('paragraphsToSoundbitesText picks a sentence and wraps it', () => {
    const src = 'Tiny. We make software for tiny teams that scale into great companies. Yep.'
    const out = _soundbites(src)
    expect(out).toContain('```')
    expect(out).toContain('💬 ')
    expect(out).toContain('## Quote Cards')
  })

  it('normalizeEmphasisMarkersText converts _x_ to *x* and skips fenced code', () => {
    const src = 'this _is_ __strong__\n```\nkeep _underscore_ here\n```\nback _italic_ end'
    const out = _emphMarks(src)
    expect(out).toContain('this *is* **strong**')
    expect(out).toContain('keep _underscore_ here')
    expect(out).toContain('back *italic* end')
  })

  it('normalizeEmphasisMarkersText leaves snake_case identifiers alone', () => {
    expect(_emphMarks('var some_thing_else = 1')).toBe('var some_thing_else = 1')
  })

  it('paragraphsToTestimonialWallText empty input returns source', () => {
    expect(_testimWall('')).toBe('')
  })
})

describe('batch224-text-helpers', () => {
  it('paragraphsToStickyNoteBoardText emits color-coded sticky notes', () => {
    const out = _stickyBoard('first idea\n\nsecond idea')
    expect(out).toContain('## Sticky Note Board')
    expect(out).toContain('🟨 **Note 1**')
    expect(out).toContain('🟦 **Note 2**')
    expect(out).toContain('> first idea')
    expect(out).toContain('> second idea')
  })

  it('paragraphsToStickyNoteBoardText returns source on empty', () => {
    expect(_stickyBoard('')).toBe('')
  })

  it('linesToParetoBarText sorts descending and computes cumulative', () => {
    const src = 'bugs: 10\nfeatures 30\ndocs: 5\nrefactor: 20'
    const out = _pareto(src)
    expect(out).toContain('## Pareto Ranking')
    const features = out.indexOf('features')
    const refactor = out.indexOf('refactor')
    const bugs = out.indexOf('bugs')
    const docs = out.indexOf('docs')
    expect(features).toBeLessThan(refactor)
    expect(refactor).toBeLessThan(bugs)
    expect(bugs).toBeLessThan(docs)
    expect(out).toContain('cum 100.0%')
  })

  it('linesToParetoBarText returns source when no numbers', () => {
    expect(_pareto('plain words only')).toBe('plain words only')
  })

  it('paragraphsToCustomerJourneyMomentsText cycles phases', () => {
    const src = 'see ad\n\nread reviews\n\nbuy product'
    const out = _journeyMoments(src)
    expect(out).toContain('👀 Awareness')
    expect(out).toContain('🤔 Consideration')
    expect(out).toContain('🛒 Decision')
    expect(out).toContain('**User action**: see ad')
    expect(out).toContain('**User action**: buy product')
  })

  it('bulletsToGitGraphMermaidText emits mermaid gitGraph with commits', () => {
    const src = '- fix login\n- add dashboard\n- patch bug\n- ship release\n- post mortem\n- celebrate'
    const out = _gitGraph(src)
    expect(out).toContain('```mermaid')
    expect(out).toContain('gitGraph')
    expect(out).toContain('commit id: "fix login"')
    expect(out).toContain('branch feature')
    expect(out).toContain('merge feature')
  })

  it('bulletsToGitGraphMermaidText returns source on no bullets', () => {
    expect(_gitGraph('no bullets at all')).toBe('no bullets at all')
  })

  it('paragraphsToUserPersonaText generates dicebear avatar', () => {
    const out = _persona('Sarah is a busy product manager')
    expect(out).toContain('## User Personas')
    expect(out).toContain('### Persona 1')
    expect(out).toContain('dicebear.com')
    expect(out).toContain('**Profile**: Sarah is a busy product manager')
    expect(out).toContain('**Goals**:')
  })

  it('normalizeUnicodeWhitespaceText replaces NBSP and full-width space', () => {
    const src = 'a b　c'
    const out = _uniWs(src)
    expect(out).toBe('a b c')
  })

  it('normalizeUnicodeWhitespaceText strips zero-width chars', () => {
    const src = 'visi​ble‌text'
    const out = _uniWs(src)
    expect(out).toBe('visibletext')
  })

  it('normalizeUnicodeWhitespaceText leaves plain ascii unchanged', () => {
    expect(_uniWs('plain text 123')).toBe('plain text 123')
  })
})

describe('batch225-text-helpers', () => {
  it('paragraphsToExecutiveTalkingPointsText numbers points', () => {
    const out = _talkPts('revenue up 20%\n\nchurn down 5%')
    expect(out).toContain('## Executive Talking Points')
    expect(out).toContain('### 1.')
    expect(out).toContain('### 2.')
    expect(out).toContain('**Core message**: revenue up 20%')
    expect(out).toContain('Call to action')
  })

  it('paragraphsToExecutiveTalkingPointsText empty input returns source', () => {
    expect(_talkPts('')).toBe('')
  })

  it('linesToTierListText buckets by tier keywords/emoji', () => {
    const src = '- ⭐⭐⭐ Vim\n- 👍 VS Code\n- C tier: Sublime\n- 👎 Notepad'
    const out = _tierList(src)
    expect(out).toContain('🏆 S Exceptional')
    expect(out).toContain('- Vim')
    expect(out).toContain('🥇 A Excellent')
    expect(out).toContain('- VS Code')
    expect(out).toContain('🥉 C Average')
    expect(out).toContain('- Sublime')
    expect(out).toContain('⚫ D Retire')
    expect(out).toContain('- Notepad')
  })

  it('linesToTierListText returns source when no bullets', () => {
    expect(_tierList('plain words')).toBe('plain words')
  })

  it('paragraphsToPressReleaseText emits headline + boilerplate', () => {
    const out = _pressRel('Acme Launches Widget X\n\nFirst-of-its-kind product launch\n\nBody text here')
    expect(out).toContain('# For Immediate Release')
    expect(out).toContain('## Acme Launches Widget X')
    expect(out).toContain('**First-of-its-kind product launch**')
    expect(out).toContain('Body text here')
    expect(out).toContain('## About Us')
    expect(out).toContain('## Media Contact')
    expect(out).toContain('###')
  })

  it('bulletsToChecklistSignedOffText builds 6-column signed table', () => {
    const src = '- finalize design\n- get legal review\n- ship to prod'
    const out = _signedCk(src)
    expect(out).toContain('## Sign-off Checklist')
    expect(out).toContain('| # | Item | Complete | Owner | Date | Signature |')
    expect(out).toContain('| 1 | finalize design | [ ]')
    expect(out).toContain('| 3 | ship to prod | [ ]')
  })

  it('bulletsToChecklistSignedOffText returns source on no bullets', () => {
    expect(_signedCk('text only')).toBe('text only')
  })

  it('paragraphsToKPITreeNarrativeText puts first paragraph as north star', () => {
    const out = _kpiTree('Total active users\n\nDaily new signups\n\nRetention rate')
    expect(out).toContain('North Star Metric')
    expect(out).toContain('> Total active users')
    expect(out).toContain('Supporting Metric Branches')
    expect(out).toContain('#### Branch 1')
    expect(out).toContain('#### Branch 2')
    expect(out).toContain('Daily new signups')
    expect(out).toContain('Retention rate')
  })

  it('normalizeOrderedListMarkersText converts 1) to 1.', () => {
    const src = '1) first\n2) second\n  3) nested\n```\n1) keep in code\n```\n4) last'
    const out = _olMarks(src)
    expect(out).toContain('1. first')
    expect(out).toContain('2. second')
    expect(out).toContain('  3. nested')
    expect(out).toContain('1) keep in code')
    expect(out).toContain('4. last')
  })

  it('normalizeOrderedListMarkersText leaves 1. alone', () => {
    expect(_olMarks('1. already correct')).toBe('1. already correct')
  })

  it('paragraphsToKPITreeNarrativeText empty returns source', () => {
    expect(_kpiTree('')).toBe('')
  })
})

describe('batch226-text-helpers', () => {
  it('paragraphsToFAQRichAnswersText splits Q? A into tip callout', () => {
    const out = _faqRich('How do I login? Use your email and password')
    expect(out).toContain('### ❓ How do I login?')
    expect(out).toContain('> [!tip] Short answer')
    expect(out).toContain('> Use your email and password')
    expect(out).toContain('**Details**:')
  })

  it('paragraphsToFAQRichAnswersText returns source on empty', () => {
    expect(_faqRich('')).toBe('')
  })

  it('linesToBalancedTreeAsciiText emits a text block', () => {
    const src = '- root\n- left\n- right\n- a\n- b\n- c\n- d'
    const out = _balTree(src)
    expect(out).toContain('```text')
    expect(out).toContain('root')
    expect(out).toContain('left')
    expect(out).toContain('right')
    expect(out).toContain('```')
  })

  it('paragraphsToMeetingAgendaFromTopicsText computes total duration', () => {
    const src = 'open\n\nupdates\n\nQ&A\n\nwrap up'
    const out = _agenda(src)
    expect(out).toContain('## Meeting Agenda')
    expect(out).toContain('| # | Duration | Topic | Facilitator | Expected Outcome |')
    expect(out).toContain('| 1 | 5 min | open')
    expect(out).toContain('| 4 | 5 min | wrap up')
    expect(out).toContain('**Total duration**: 30 min')
  })

  it('bulletsToOutlineNumberedText numbers by indent depth', () => {
    const src = '- root\n  - child\n  - sibling\n    - grand\n- root2'
    const out = _outlineNum(src)
    expect(out).toContain('1. root')
    expect(out).toContain('  1.1. child')
    expect(out).toContain('  1.2. sibling')
    expect(out).toContain('    1.2.1. grand')
    expect(out).toContain('2. root2')
  })

  it('bulletsToOutlineNumberedText returns source on no bullets', () => {
    expect(_outlineNum('plain text')).toBe('plain text')
  })

  it('paragraphsToPressHeadlineCandidatesText emits 4 styles per paragraph', () => {
    const out = _hlCand('Acme ships new feature')
    expect(out).toContain('### Candidate 1')
    expect(out).toContain('- **Direct**:')
    expect(out).toContain('- **Curiosity**:')
    expect(out).toContain('- **Data**:')
    expect(out).toContain('- **Comparison**:')
  })

  it('paragraphsToPressHeadlineCandidatesText empty returns source', () => {
    expect(_hlCand('')).toBe('')
  })

  it('normalizeEmptyBulletItemsText removes empty bullets', () => {
    const src = '- real item\n- \n- another item\n- [ ] \n1. \n- final'
    const out = _emptyBul(src)
    expect(out).toContain('- real item')
    expect(out).toContain('- another item')
    expect(out).toContain('- final')
    expect(out).not.toMatch(/^- $/m)
    expect(out).not.toMatch(/^- \[ \] $/m)
    expect(out).not.toMatch(/^1\. $/m)
  })

  it('normalizeEmptyBulletItemsText preserves code fence content', () => {
    const src = 'before\n```\n- \n```\nafter'
    const out = _emptyBul(src)
    expect(out).toContain('- ')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('paragraphsToFAQRichAnswersText handles bare question without answer', () => {
    const out = _faqRich('What is markdown')
    expect(out).toContain('### ❓ What is markdown')
    expect(out).toContain('**Answer**:')
  })
})
