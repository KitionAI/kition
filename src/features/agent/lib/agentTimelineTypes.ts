export type AgentTaskStep = {
  key: string
  label: string
  detail: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export type AgentRunLogItem = {
  key: string
  kind: 'event' | 'tool' | 'artifact' | 'model' | 'final'
  title: string
  detail?: string
  status: AgentTaskStep['status']
  toolName?: string
  payload?: any
  createdAt: string
}
