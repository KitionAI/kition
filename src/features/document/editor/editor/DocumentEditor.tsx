   
                 
  
                                              
                                                                                         
  
                                                      
                                                  
   

import { markdown, markdownLanguage as gfmMarkdownLanguage } from '@codemirror/lang-markdown'
import { languages as codeLanguages } from '@codemirror/language-data'
import { type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { forwardRef, useMemo } from 'react'

import { cn } from '@/lib/utils'

import { useBufferedCodeMirrorValue } from '../hooks/useBufferedCodeMirrorValue'
import type { WikilinkParsed } from '../lib/wikilink-parser'
import type { TagParsed } from '../lib/tag-parser'
import {
  autoBracketExtension,
  blockIdExtension,
  clickPositionFixExtension,
  commentExtension,
  dataviewFieldExtension,
  documentSearchExtension,
  editorContextMenuExtension,
  embedTransclusionExtension,
  focusModeExtension,
  footnotePreviewExtension,
  frontmatterWidgetExtension,
  headingFoldIndicatorExtension,
  highlightExtension,
  livePreviewExtension,
  mathPreviewExtension,
  mediaDecoExtension,
  documentKeymap,
  pasteImageExtension,
  pasteLinkExtension,
  preserveHighlightExtension,
  slashCommandExtension,
  snippetExpandExtension,
  spellcheckExtension,
  tagExtension,
  typewriterModeExtension,
  wikilinkExtension,
  wikilinkHoverPreviewExtension,
  wikilinkResolverFacet,
  type EmbedLoader,
  type SuggestProviders,
  type WikilinkCreate,
  type WikilinkExtensionOptions,
  type WikilinkNavigate,
} from './extensions'
import { searchHitFlashExtension } from '@/features/search/ui/searchHitFlash'

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  searchKeymap: true,
                                                                      
                                                           
                                                            
                                                    
                                               
                                                                         
  syntaxHighlighting: false,
} as const

   
                                                                 
                                                     
                                                                
                                                             
                                                                   
                                                         
                              
  
                                                             
                                                 
                                                                      
                                                      
                              
  
                                                  
                                    
   
const markdownExtension = markdown({ base: gfmMarkdownLanguage, codeLanguages })

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'inherit',
  },
  '&.cm-focused': { outline: 'none' },
                                                                           
  // `view-content > .markdown-source-view.mod-cm6 > .cm-editor > .cm-scroller { padding: var(--file-margins) }`),
                                                                        
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.75',
    padding: '1.25rem 1.75rem',
  },
  '.cm-content': {
    padding: '0',
    caretColor: 'currentColor',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
                                                                         
                                                                      
                                                                           
                                                                
                                           
                                                      
                                           
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'hsl(var(--primary) / 0.3)',
  },
})

export type CursorInfo = {
  /** 1-based line */
  line: number
  /** 1-based column */
  col: number
  /** total selected character count across all ranges */
  selectionLength: number
                                                           
  selectionText: string
}

export type DocumentEditorProps = {
  value: string
  readOnly?: boolean
  /** Whether the content DOM is focusable/editable. Default true. */
  editable?: boolean
  onChange: (value: string) => void
  placeholder?: string
  className?: string
                         
  sourcePath?: string
  /** Keep live-preview source markers hidden even while focused. */
  revealSourceOnFocus?: boolean
  /** Use CodeMirror's custom selection layer. Disable for rendered reading views. */
  drawSelection?: boolean
                                   
  resolveWikilink?: WikilinkExtensionOptions['resolve']
                              
  onWikilinkNavigate?: WikilinkNavigate
                          
  onCreateMissingNote?: WikilinkCreate
                         
  onTagNavigate?: (tag: TagParsed) => void
                          
  onCursorLineChange?: (line: number) => void
                      
  onCursorChange?: (info: CursorInfo) => void
                               
  suggestProviders?: SuggestProviders
                                         
  loadEmbed?: EmbedLoader
                         
  onEmbedNavigate?: (target: string, section?: string) => void
  /** Handle a rendered Markdown link inside the workspace. Return true when handled. */
  onMarkdownLinkNavigate?: (href: string) => boolean
  onCreateEditor?: (view: EditorView) => void
  /** Return true to replace the native copy for the selected Markdown. */
  onCopySelection?: (markdown: string, clipboardData: DataTransfer | null) => boolean
  /**
   * Extensions composed by the consuming pane; spread after every built-in
   * except `editorTheme`, which stays last so the base styles anchor the cascade.
   * Caller must memoize the array — a fresh reference each render triggers
   * `StateEffect.reconfigure` and trashes lezer's incremental parse state
   * (see the markdownExtension comment above for the full story).
   */
  extraExtensions?: Extension[]
}

export const DocumentEditor = forwardRef<ReactCodeMirrorRef, DocumentEditorProps>(
  function DocumentEditor(
    {
      value,
      readOnly = false,
      editable = true,
      onChange,
      placeholder,
      className,
      sourcePath,
      revealSourceOnFocus = true,
      drawSelection = true,
      resolveWikilink,
      onWikilinkNavigate,
      onCreateMissingNote,
      onTagNavigate,
      onCursorLineChange,
      onCursorChange,
      suggestProviders,
      loadEmbed,
      onEmbedNavigate,
      onMarkdownLinkNavigate,
      onCreateEditor,
      onCopySelection,
      extraExtensions,
    },
    ref,
  ) {
    const {
      compositionExtension,
      editorValue,
      handleEditorChange,
    } = useBufferedCodeMirrorValue({ value, onChange })

    const extensions = useMemo(
      () => [
        markdownExtension,
        compositionExtension,
        preserveHighlightExtension(),
        clickPositionFixExtension(),
        documentSearchExtension(),
        EditorView.lineWrapping,
        documentKeymap(),
        frontmatterWidgetExtension(),
        dataviewFieldExtension(),
        mathPreviewExtension(),
        mediaDecoExtension(),
        focusModeExtension(),
        typewriterModeExtension(),
        autoBracketExtension(),
        slashCommandExtension(suggestProviders ?? {}),
        snippetExpandExtension({ sourcePath }),
        livePreviewExtension({ sourcePath, revealSourceOnFocus, onMarkdownLinkNavigate }),
        ...(onCopySelection
          ? [EditorView.domEventHandlers({
              copy(event, view) {
                const selectedMarkdown = view.state.selection.ranges
                  .filter((range) => !range.empty)
                  .map((range) => view.state.doc.sliceString(range.from, range.to))
                  .join('\n')
                if (!selectedMarkdown || !onCopySelection(selectedMarkdown, event.clipboardData)) {
                  return false
                }
                event.preventDefault()
                event.clipboardData?.setData('text/plain', selectedMarkdown)
                event.clipboardData?.setData('text/markdown', selectedMarkdown)
                return true
              },
            })]
          : []),
        pasteImageExtension(),
        pasteLinkExtension(),
        wikilinkExtension({
          sourcePath,
          resolve: resolveWikilink,
          onNavigate: onWikilinkNavigate,
          onCreateMissing: onCreateMissingNote,
        }),
        wikilinkResolverFacet.of(resolveWikilink ?? (() => true)),
        wikilinkHoverPreviewExtension(),
        tagExtension({ onNavigate: onTagNavigate }),
        highlightExtension(),
        commentExtension(),
        blockIdExtension(),
        footnotePreviewExtension(),
        spellcheckExtension(),
        editorContextMenuExtension(),
        headingFoldIndicatorExtension(),
        ...(loadEmbed
          ? [embedTransclusionExtension({ sourcePath, load: loadEmbed, onNavigate: onEmbedNavigate })]
          : []),
        ...searchHitFlashExtension(),
        EditorView.updateListener.of((update) => {
          if (!onCursorLineChange && !onCursorChange) return
          if (!update.selectionSet && !update.docChanged) return
          const state = update.state
          const main = state.selection.main
          const head = main.head
          const lineObj = state.doc.lineAt(head)
          onCursorLineChange?.(lineObj.number)
          if (onCursorChange) {
            let selectionLength = 0
            for (const r of state.selection.ranges) selectionLength += r.to - r.from
            onCursorChange({
              line: lineObj.number,
              col: head - lineObj.from + 1,
              selectionLength,
              selectionText: state.doc.sliceString(main.from, main.to),
            })
          }
        }),
        ...(extraExtensions ?? []),
        editorTheme,
      ],
      [compositionExtension, sourcePath, revealSourceOnFocus, resolveWikilink, onWikilinkNavigate, onCreateMissingNote, onTagNavigate, onCursorLineChange, onCursorChange, suggestProviders, loadEmbed, onEmbedNavigate, onMarkdownLinkNavigate, onCopySelection, extraExtensions],
    )

    const effectiveBasicSetup = useMemo(
      () => ({ ...basicSetup, drawSelection }),
      [drawSelection],
    )

    return (
      <CodeMirror
        ref={ref}
        value={editorValue}
        onChange={handleEditorChange}
        readOnly={readOnly}
        editable={editable}
        extensions={extensions}
        basicSetup={effectiveBasicSetup}
        placeholder={placeholder}
        height="100%"
        className={cn('document-editor', className)}
        onCreateEditor={onCreateEditor}
      />
    )
  },
)
