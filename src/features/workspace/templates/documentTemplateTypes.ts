/** The built-in note templates' shapes. */
export type DocumentTemplateCategory = 'work' | 'planning' | 'personal'
export type DocumentTemplateIcon =
  | 'action'
  | 'analytics'
  | 'architecture'
  | 'brainstorm'
  | 'brief'
  | 'calendar'
  | 'checklist'
  | 'client'
  | 'daily'
  | 'flowchart'
  | 'launch'
  | 'meeting'
  | 'okr'
  | 'organization'
  | 'product'
  | 'research'
  | 'report'
  | 'review'
  | 'swimlane'
  | 'timeline'
export type DocumentTemplateTone =
  | 'cream'
  | 'gray'
  | 'lavender'
  | 'mint'
  | 'peach'
  | 'rose'
  | 'sky'
  | 'yellow'

export type DocumentTemplatePreview =
  | 'action-list'
  | 'analytics'
  | 'architecture'
  | 'brainstorm'
  | 'client-profile'
  | 'daily-report'
  | 'flowchart'
  | 'meeting-notes'
  | 'okr'
  | 'organization'
  | 'product-brief'
  | 'product-launch'
  | 'project-brief'
  | 'research'
  | 'swimlane'
  | 'task-table'
  | 'team-report'
  | 'timeline'
  | 'weekly-plan'
  | 'weekly-review'

export type BuiltinDocumentTemplate = {
  id: string
  title: string
  description: string
  category: DocumentTemplateCategory
  icon: DocumentTemplateIcon
  tone: DocumentTemplateTone
  preview: DocumentTemplatePreview
  coverImage: string
  content: string
}

export type BuiltinDocumentTemplateSeed = Omit<BuiltinDocumentTemplate, 'coverImage'>
