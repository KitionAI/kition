   
                 
  
                                                               
                                                    
  
                                                
                                          
   

import { redo, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import {
  Bold,
  BookOpen,
  Code,
  Code2,
  FileSearch,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  Minus,
  PencilLine,
  Quote,
  Redo2,
  Search,
  Sigma,
  Strikethrough,
  Table as TableIcon,
  TextQuote,
  Undo2,
} from 'lucide-react'
import { type ReactNode, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/registry/ui/button'
import { cn } from '@/lib/utils'

import {
  insertCallout,
  insertCodeBlock,
  insertEmbed,
  insertHighlight,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertMath,
  insertTable,
  insertTag,
  insertWikilink,
  setLineHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleTodoList,
} from './commands'

export type DocumentEditorToolbarProps = {
                                            
  getView: () => EditorView | null
  readOnly?: boolean
  className?: string
                                            
  showTools?: boolean
                          
  onToggleOutline?: () => void
  outlineOpen?: boolean
                                                   
  readingView?: boolean
                                                
  onSetReadingView?: (next: boolean) => void
                                                       
  actionsSlot?: ReactNode
}

export function DocumentEditorToolbar({
  getView,
  readOnly,
  className,
  showTools = true,
  onToggleOutline,
  outlineOpen,
  readingView,
  onSetReadingView,
  actionsSlot,
}: DocumentEditorToolbarProps) {
  const { t } = useTranslation('document')
  const run = useCallback(
    (cmd: (v: EditorView) => boolean) => () => {
      const view = getView()
      if (!view) return
      cmd(view)
    },
    [getView],
  )

  const promptLink = useCallback(() => {
    const view = getView()
    if (!view) return
    const url = window.prompt(t('editor.prompts.linkUrl')) ?? ''
    insertLink(url)(view)
  }, [getView, t])

  const promptImage = useCallback(() => {
    const view = getView()
    if (!view) return
    const url = window.prompt(t('editor.prompts.imageUrl')) ?? ''
    const alt = window.prompt(t('editor.prompts.imageAlt')) ?? ''
    insertImage(url, alt)(view)
  }, [getView, t])

  const barMode = showTools !== false
  return (
    <div
      className={cn(
        'document-toolbar z-20 flex items-center gap-0.5',
        barMode
          ? 'relative shrink-0 flex-wrap border-b bg-background/80 px-2 py-1 backdrop-blur'
          : 'pointer-events-none absolute right-3 top-1 justify-end',
        readOnly && 'pointer-events-none opacity-50',
        className,
      )}
      role="toolbar"
      aria-label={t('editor.toolbar.ariaLabel')}
    >
      {barMode ? (
        <>
          <ToolGroup>
            <IconBtn label={t('editor.toolbar.undo')} onClick={run(undo)} icon={<Undo2 />} />
            <IconBtn label={t('editor.toolbar.redo')} onClick={run(redo)} icon={<Redo2 />} />
          </ToolGroup>

          <Divider />

          <ToolGroup>
            <IconBtn label={t('editor.toolbar.body')} onClick={run(setLineHeading(0))} icon={<TextQuote />} />
            <IconBtn label={t('editor.toolbar.heading1')} onClick={run(setLineHeading(1))} icon={<Heading1 />} />
            <IconBtn label={t('editor.toolbar.heading2')} onClick={run(setLineHeading(2))} icon={<Heading2 />} />
            <IconBtn label={t('editor.toolbar.heading3')} onClick={run(setLineHeading(3))} icon={<Heading3 />} />
          </ToolGroup>

          <Divider />

          <ToolGroup>
            <IconBtn label={t('editor.toolbar.bold')} onClick={run(toggleBold)} icon={<Bold />} />
            <IconBtn label={t('editor.toolbar.italic')} onClick={run(toggleItalic)} icon={<Italic />} />
            <IconBtn label={t('editor.toolbar.strikethrough')} onClick={run(toggleStrike)} icon={<Strikethrough />} />
            <IconBtn label={t('editor.toolbar.inlineCode')} onClick={run(toggleInlineCode)} icon={<Code />} />
          </ToolGroup>

          <Divider />

          <ToolGroup>
            <IconBtn label={t('editor.toolbar.bulletList')} onClick={run(toggleBulletList)} icon={<List />} />
            <IconBtn label={t('editor.toolbar.orderedList')} onClick={run(toggleOrderedList)} icon={<ListOrdered />} />
            <IconBtn label={t('editor.toolbar.todo')} onClick={run(toggleTodoList)} icon={<ListTodo />} />
            <IconBtn label={t('editor.toolbar.quote')} onClick={run(toggleQuote)} icon={<Quote />} />
          </ToolGroup>

          <Divider />

          <ToolGroup>
            <IconBtn label={t('editor.toolbar.link')} onClick={promptLink} icon={<LinkIcon />} />
            <IconBtn label={t('editor.toolbar.image')} onClick={promptImage} icon={<ImageIcon />} />
            <IconBtn label={t('editor.toolbar.codeBlock')} onClick={run(insertCodeBlock())} icon={<Code2 />} />
            <IconBtn label={t('editor.toolbar.table')} onClick={run(insertTable(3, 3))} icon={<TableIcon />} />
            <IconBtn label={t('editor.toolbar.callout')} onClick={run(insertCallout('note'))} icon={<TextQuote />} />
            <IconBtn label={t('editor.toolbar.divider')} onClick={run(insertHorizontalRule())} icon={<Minus />} />
            <IconBtn label={t('editor.toolbar.search')} onClick={run(openSearchPanel)} icon={<Search />} />
          </ToolGroup>

          <Divider />

          <ToolGroup>
            <IconBtn label={t('editor.toolbar.wikilink')} onClick={run(insertWikilink())} icon={<Link2 />} />
            <IconBtn label={t('editor.toolbar.embed')} onClick={run(insertEmbed())} icon={<FileSearch />} />
            <IconBtn label={t('editor.toolbar.tag')} onClick={run(insertTag())} icon={<Hash />} />
            <IconBtn label={t('editor.toolbar.highlight')} onClick={run(insertHighlight())} icon={<Highlighter />} />
            <IconBtn label={t('editor.toolbar.inlineMath')} onClick={run(insertMath())} icon={<Sigma />} />
          </ToolGroup>
        </>
      ) : null}

      {onSetReadingView || onToggleOutline || actionsSlot ? (
        <>
          {barMode ? <div className="ml-auto" /> : null}
          <div className={cn('flex items-center gap-0.5', !barMode && 'pointer-events-auto')}>
            {onSetReadingView ? (
              <div className="pointer-events-auto flex items-center gap-0.5">
                <IconBtn
                  label={readingView ? t('editor.toolbar.editMode') : t('editor.toolbar.previewMode')}
                  onClick={() => onSetReadingView(!readingView)}
                  icon={readingView ? <PencilLine /> : <BookOpen />}
                  className="h-6 w-6 [&_svg]:size-4"
                />
              </div>
            ) : null}
            {onToggleOutline ? (
              <IconBtn
                label={outlineOpen ? t('editor.toolbar.closeOutline') : t('editor.toolbar.openOutline')}
                onClick={onToggleOutline}
                icon={<ListTree />}
                pressed={outlineOpen}
              />
            ) : null}
            {actionsSlot}
          </div>
        </>
      ) : null}
    </div>
  )
}

function ToolGroup({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
}

function IconBtn({
  label,
  icon,
  onClick,
  pressed,
  className,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  pressed?: boolean
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'h-7 w-7 text-muted-foreground hover:text-foreground',
        pressed && 'bg-accent text-foreground',
        className,
      )}
    >
      {icon}
    </Button>
  )
}
