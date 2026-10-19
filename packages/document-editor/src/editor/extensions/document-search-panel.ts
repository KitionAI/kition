import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

type MatchRange = { from: number; to: number }

const SVG_NS = 'http://www.w3.org/2000/svg'

function createIcon(paths: string[]): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('focusable', 'false')

  for (const pathData of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', pathData)
    icon.append(path)
  }

  return icon
}

function createIconButton(
  name: string,
  label: string,
  paths: string[],
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.name = name
  button.className = 'document-find-panel__icon-button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.append(createIcon(paths))
  button.addEventListener('click', onClick)
  return button
}

function firstMatchAtOrAfter(query: SearchQuery, view: EditorView): MatchRange | null {
  if (!query.valid || !query.search) return null

  const from = view.state.selection.main.from
  const next = query.getCursor(view.state, from).next()
  if (!next.done) return next.value

  const wrapped = query.getCursor(view.state, 0, from).next()
  return wrapped.done ? null : wrapped.value
}

function getMatchPosition(query: SearchQuery, view: EditorView): { current: number; total: number } {
  if (!query.valid || !query.search) return { current: 0, total: 0 }

  const selection = view.state.selection.main
  let current = 0
  let total = 0
  const cursor = query.getCursor(view.state)

  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1
    if (next.value.from === selection.from && next.value.to === selection.to) {
      current = total
    }
  }

  return { current, total }
}

class DocumentSearchPanel implements Panel {
  readonly dom: HTMLFormElement
  readonly top = true

  private readonly searchInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly status: HTMLSpanElement
  private readonly previousButton: HTMLButtonElement
  private readonly nextButton: HTMLButtonElement
  private readonly replaceToggle: HTMLButtonElement
  private readonly replaceButton: HTMLButtonElement
  private readonly replaceAllButton: HTMLButtonElement
  private readonly replaceRow: HTMLDivElement
  private query: SearchQuery
  private replaceOpen = false

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state)

    this.dom = document.createElement('form')
    this.dom.className = 'document-find-panel'
    this.dom.setAttribute('role', 'search')
    this.dom.addEventListener('submit', (event) => event.preventDefault())

    const searchRow = document.createElement('div')
    searchRow.className = 'document-find-panel__row'

    this.searchInput = document.createElement('input')
    this.searchInput.className = 'cm-textfield document-find-panel__input'
    this.searchInput.name = 'search'
    this.searchInput.type = 'text'
    this.searchInput.value = this.query.search
    this.searchInput.placeholder = 'Find'
    this.searchInput.autocomplete = 'off'
    this.searchInput.spellcheck = false
    this.searchInput.setAttribute('aria-label', 'Find in document')
    this.searchInput.setAttribute('main-field', 'true')
    this.searchInput.addEventListener('input', () => this.commitSearch())
    this.searchInput.addEventListener('keydown', (event) => this.handleSearchKeydown(event))

    this.status = document.createElement('span')
    this.status.className = 'document-find-panel__status'
    this.status.setAttribute('aria-live', 'polite')

    this.previousButton = createIconButton(
      'previous',
      'Previous match',
      ['M12 19V5', 'm5 12 7-7 7 7'],
      () => findPrevious(this.view),
    )
    this.nextButton = createIconButton(
      'next',
      'Next match',
      ['M12 5v14', 'm19 12-7 7-7-7'],
      () => findNext(this.view),
    )
    this.replaceToggle = createIconButton(
      'toggleReplace',
      'Show replace',
      [
        'm17 2 4 4-4 4',
        'M3 11V9a3 3 0 0 1 3-3h15',
        'm7 22-4-4 4-4',
        'M21 13v2a3 3 0 0 1-3 3H3',
      ],
      () => this.toggleReplace(),
    )
    this.replaceToggle.setAttribute('aria-expanded', 'false')

    const closeButton = createIconButton(
      'close',
      'Close search',
      ['M18 6 6 18', 'M6 6l12 12'],
      () => closeSearchPanel(this.view),
    )

    searchRow.append(
      this.searchInput,
      this.status,
      this.previousButton,
      this.nextButton,
      this.replaceToggle,
      closeButton,
    )

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'document-find-panel__replace-row'
    this.replaceRow.hidden = true

    this.replaceInput = document.createElement('input')
    this.replaceInput.className = 'cm-textfield document-find-panel__input'
    this.replaceInput.name = 'replace'
    this.replaceInput.type = 'text'
    this.replaceInput.value = this.query.replace
    this.replaceInput.placeholder = 'Replace with'
    this.replaceInput.autocomplete = 'off'
    this.replaceInput.spellcheck = false
    this.replaceInput.setAttribute('aria-label', 'Replace with')
    this.replaceInput.addEventListener('input', () => this.commitReplacement())
    this.replaceInput.addEventListener('keydown', (event) => this.handleReplaceKeydown(event))

    this.replaceButton = document.createElement('button')
    this.replaceButton.type = 'button'
    this.replaceButton.name = 'replace'
    this.replaceButton.className = 'document-find-panel__text-button'
    this.replaceButton.textContent = 'Replace'
    this.replaceButton.addEventListener('click', () => replaceNext(this.view))

    this.replaceAllButton = document.createElement('button')
    this.replaceAllButton.type = 'button'
    this.replaceAllButton.name = 'replaceAll'
    this.replaceAllButton.className = 'document-find-panel__text-button'
    this.replaceAllButton.textContent = 'All'
    this.replaceAllButton.setAttribute('aria-label', 'Replace all')
    this.replaceAllButton.addEventListener('click', () => replaceAll(this.view))

    this.replaceRow.append(this.replaceInput, this.replaceButton, this.replaceAllButton)
    this.dom.append(searchRow, this.replaceRow)
    this.updateStatus()
  }

  mount(): void {
    this.searchInput.focus()
    this.searchInput.select()
  }

  update(update: ViewUpdate): void {
    const nextQuery = getSearchQuery(update.state)
    const queryChanged = !nextQuery.eq(this.query)

    if (queryChanged) {
      this.query = nextQuery
      if (this.searchInput.value !== nextQuery.search) this.searchInput.value = nextQuery.search
      if (this.replaceInput.value !== nextQuery.replace) this.replaceInput.value = nextQuery.replace
    }

    if (queryChanged || update.docChanged || update.selectionSet) this.updateStatus()
  }

  private commitSearch(): void {
    const query = this.createQuery(this.searchInput.value, this.replaceInput.value)
    this.query = query

    const match = firstMatchAtOrAfter(query, this.view)
    if (match) {
      this.view.dispatch({
        effects: [
          setSearchQuery.of(query),
          EditorView.scrollIntoView(match.from, { y: 'center' }),
        ],
        selection: { anchor: match.from, head: match.to },
      })
      return
    }

    this.view.dispatch({ effects: setSearchQuery.of(query) })
  }

  private commitReplacement(): void {
    const query = this.createQuery(this.searchInput.value, this.replaceInput.value)
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
  }

  private createQuery(searchValue: string, replaceValue: string): SearchQuery {
    return new SearchQuery({
      search: searchValue,
      replace: replaceValue,
      caseSensitive: this.query.caseSensitive,
      literal: this.query.literal,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
      test: this.query.test,
    })
  }

  private updateStatus(): void {
    const { current, total } = getMatchPosition(this.query, this.view)
    const hasMatches = total > 0

    if (!this.query.search) this.status.textContent = ''
    else if (!this.query.valid) this.status.textContent = 'Invalid query'
    else if (!hasMatches) this.status.textContent = 'No results'
    else this.status.textContent = `${current || 1} of ${total}`

    this.previousButton.disabled = !hasMatches
    this.nextButton.disabled = !hasMatches
    this.replaceButton.disabled = !hasMatches
    this.replaceAllButton.disabled = !hasMatches
  }

  private toggleReplace(): void {
    this.replaceOpen = !this.replaceOpen
    this.replaceRow.hidden = !this.replaceOpen
    this.replaceToggle.classList.toggle('is-active', this.replaceOpen)
    this.replaceToggle.setAttribute('aria-expanded', String(this.replaceOpen))
    this.replaceToggle.setAttribute('aria-label', this.replaceOpen ? 'Hide replace' : 'Show replace')
    this.replaceToggle.title = this.replaceOpen ? 'Hide replace' : 'Show replace'
    if (this.replaceOpen) this.replaceInput.focus()
  }

  private handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) findPrevious(this.view)
      else findNext(this.view)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(this.view)
    }
  }

  private handleReplaceKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      replaceNext(this.view)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(this.view)
    }
  }
}

export function documentSearchExtension() {
  return search({
    top: true,
    createPanel: (view) => new DocumentSearchPanel(view),
  })
}
