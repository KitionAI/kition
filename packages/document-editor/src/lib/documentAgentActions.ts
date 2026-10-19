export type DocumentAgentAction = 'custom' | 'improve' | 'shorten' | 'expand'

export type DocumentAgentSelection = {
  text: string
  from: number
  to: number
  line: number
}

export type DocumentAgentActionRequest = {
  action: DocumentAgentAction
  selection: DocumentAgentSelection | null
}

export type DocumentAskAgentRequest = {
  documentPath: string
  prompt: string
}
