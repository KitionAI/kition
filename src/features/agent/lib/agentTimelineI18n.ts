// All user-visible strings in the agent timeline. Picks a dictionary by locale
// so AgentChatPanel can switch labels based on desktopSettings.general.language.

export type AgentTimelineLocale = 'en-US'

export const DEFAULT_AGENT_TIMELINE_LOCALE: AgentTimelineLocale = 'en-US'

export function resolveAgentTimelineLocale(_value: string | undefined | null): AgentTimelineLocale {
  return 'en-US'
}

type ToolLabelMap = Record<string, string>

type AgentTimelineDict = {
  status: { running: string; failed: string; completed: string; unknown: string }
  sections: {
    tool: string
    input: string
    output: string
    error: string
    status: string
    data: string
    backendContent: string
    toolArguments: string
    path: string
    type: string
    title: string
    mimeType: string
    createdAt: string
    preview: string
    noDetail: string
  }
  model: {
    titlePlanning: string
    titleProcessing: string
    detailPlanning: string
    detailProcessing: (tool: string) => string
    expandedPlanning: string
    expandedProcessing: (tool: string) => string
  }
  activity: {
    running: (tool: string) => string
    failed: (tool: string) => string
    preparingFinal: string
    planningNext: string
    taskCompleted: string
    waiting: string
    thinking: string
  }
  event: {
    understandingTask: string
    taskUnderstood: string
    enableSkills: string
    sendModelRequest: string
    callingBackend: string
    backendCalled: string
    backendStreaming: string
    backendReturned: string
    generatingToolArgs: (tool: string) => string
    generatingToolArgsAnon: string
    toolCallGenerated: (tool: string) => string
    toolCallGeneratedAnon: string
    backendTurnCompleted: string
    finalizeResponse: string
    taskFailed: string
    currentModel: string
    nativeToolLoop: string
    standardChat: string
    modelTurnFinished: (turn: number) => string
    requestingModelTurn: (turn: number) => string
    requestingModel: string
    receivedChars: (chars: number) => string
    waitingBackendContent: string
    modelRequestedNTools: (count: number) => string
    modelReturnedChars: (chars: number) => string
    thisTurnCompleted: string
  }
  tool: {
    inProgress: (label: string) => string
    failed: (label: string) => string
    completed: (label: string) => string
    pendingApproval: (command: string) => string
    searchInBrowserPrefix: (query: string) => string
    searchPrefix: (query: string) => string
    generateImagePrefix: (query: string) => string
    previewNFiles: (count: number, added: number, removed: number) => string
    appliedNFiles: (count: number, added: number, removed: number) => string
    nMatches: (count: number) => string
    nResults: (count: number) => string
    nImages: (count: number) => string
    nEntries: (count: number) => string
    removed: (path: string) => string
  }
  artifact: { title: string }
  final: { streaming: string }
  sanitize: { continueAndWrite: string; continueDefault: string }
  toolDisplayName: ToolLabelMap
  toolActionLabel: ToolLabelMap
  mcpDisplayPrefix: string
  mcpActionTemplate: (server: string, tool: string) => string
}


const EN_US_DICT: AgentTimelineDict = {
  status: { running: 'Running', failed: 'Failed', completed: 'Completed', unknown: 'Unknown' },
  sections: {
    tool: 'Tool',
    input: 'Input',
    output: 'Output',
    error: 'Error',
    status: 'Status',
    data: 'Data',
    backendContent: 'AI backend content',
    toolArguments: 'Tool arguments',
    path: 'Path',
    type: 'Type',
    title: 'Title',
    mimeType: 'MIME type',
    createdAt: 'Created at',
    preview: 'Preview',
    noDetail: 'This step is waiting for more execution data.',
  },
  model: {
    titlePlanning: 'Understanding the task',
    titleProcessing: 'Processing tool results',
    detailPlanning: 'The model is analyzing the goal, context, and available tools',
    detailProcessing: (tool) => `Received ${tool} results; the model is deciding the next step`,
    expandedPlanning:
      'The model is considering your question, the available context, and tools to figure out the first step. Execution starts as soon as a plan is ready.',
    expandedProcessing: (tool) =>
      `The model just received results from “${tool}” and is using the context to decide what to do next (run more tools, or reply directly).`,
  },
  activity: {
    running: (tool) => `Running ${tool}`,
    failed: (tool) => `${tool} failed`,
    preparingFinal: 'Preparing the final reply',
    planningNext: 'Planning the next step',
    taskCompleted: 'Task completed',
    waiting: 'Waiting for task',
    thinking: 'Thinking…',
  },
  event: {
    understandingTask: 'Understanding task',
    taskUnderstood: 'Task understood',
    enableSkills: 'Enable skills',
    sendModelRequest: 'Send model request',
    callingBackend: 'Calling AI backend',
    backendCalled: 'AI backend called',
    backendStreaming: 'AI backend streaming content',
    backendReturned: 'AI backend returned content',
    generatingToolArgs: (tool) => `Generating ${tool} arguments`,
    generatingToolArgsAnon: 'Generating tool arguments',
    toolCallGenerated: (tool) => `${tool} call generated`,
    toolCallGeneratedAnon: 'Tool call generated',
    backendTurnCompleted: 'AI backend turn completed',
    finalizeResponse: 'Finalize response',
    taskFailed: 'Task failed',
    currentModel: 'Current model',
    nativeToolLoop: 'Native tool loop',
    standardChat: 'Standard chat',
    modelTurnFinished: (turn) => `Model turn ${turn} has finished`,
    requestingModelTurn: (turn) => `Requesting model turn ${turn}`,
    requestingModel: 'Requesting model',
    receivedChars: (chars) => `Received ${chars} characters from the backend`,
    waitingBackendContent: 'Waiting for backend content',
    modelRequestedNTools: (count) => `The model requested ${count} tools`,
    modelReturnedChars: (chars) => `The model returned ${chars} characters of final content`,
    thisTurnCompleted: 'This model turn completed',
  },
  tool: {
    inProgress: (label) => `${label} in progress`,
    failed: (label) => `${label} failed`,
    completed: (label) => `${label} completed`,
    pendingApproval: (command) => `Pending approval · $ ${command}`,
    searchInBrowserPrefix: (query) => `Search in browser: ${query}`,
    searchPrefix: (query) => `Search: ${query}`,
    generateImagePrefix: (query) => `Generate image: ${query}`,
    previewNFiles: (count, added, removed) =>
      `Preview ${count} file${count === 1 ? '' : 's'} · +${added} −${removed}`,
    appliedNFiles: (count, added, removed) =>
      `Applied ${count} file${count === 1 ? '' : 's'} · +${added} −${removed}`,
    nMatches: (count) => `${count} match${count === 1 ? '' : 'es'}`,
    nResults: (count) => `${count} results`,
    nImages: (count) => `${count} images`,
    nEntries: (count) => `${count} entr${count === 1 ? 'y' : 'ies'}`,
    removed: (path) => `Removed ${path}`,
  },
  artifact: { title: 'Save artifact' },
  final: { streaming: 'Streaming final reply' },
  sanitize: {
    continueAndWrite:
      'Continue from the current browser page and write the visible results into the table.',
    continueDefault: 'Continue from the current browser page and prepare the next agent step.',
  },
  toolDisplayName: {
    browser_open: 'Open Browser Tab',
    browser_navigate: 'Navigate Browser',
    browser_search: 'Search In Browser',
    source_adapter_catalog: 'Inspect Source Context',
    browser_context_entities: 'Read Browser Page',
    browser_ingest_strategy: 'Evaluate Page Readiness',
    web_search: 'Web Search',
    web_fetch: 'Web Fetch',
    data_table_create: 'Create Table',
    data_table_schema: 'Table Schema',
    data_table_records: 'Table Records',
    data_table_record_draft: 'Draft Table Records',
    data_table_add_fields: 'Add Table Fields',
    data_table_add_records: 'Add Table Records',
    image_search: 'Image Generation',
    save_image_asset: 'Save Image',
    document_search: 'Document Search',
    document_read: 'Read Document',
    document_write: 'Update Document',
    apply_patch: 'Apply Patch',
    file_search: 'Search Files',
    fs_read: 'Read File',
    fs_stat: 'Stat Path',
    fs_list: 'List Directory',
    fs_mkdir: 'Create Directory',
    fs_remove: 'Remove Path',
    fs_copy: 'Copy Path',
    create_markdown: 'Create Markdown',
    pptx_create: 'Create PPTX',
    docx_create: 'Create DOCX',
    xlsx_create: 'Create XLSX',
    artifact_write: 'Save Artifact',
    register_artifact: 'Register Artifact',
  },
  toolActionLabel: {
    browser_open: 'Open browser tab',
    browser_navigate: 'Navigate browser',
    browser_search: 'Search in browser',
    source_adapter_catalog: 'Inspect source context',
    browser_context_entities: 'Inspect browser page',
    browser_ingest_strategy: 'Evaluate page readiness',
    web_search: 'Web search',
    web_fetch: 'Web fetch',
    data_table_create: 'Create data table',
    data_table_schema: 'Inspect table schema',
    data_table_records: 'Read table records',
    data_table_record_draft: 'Draft table records',
    data_table_add_fields: 'Add table fields',
    data_table_add_records: 'Write table records',
    image_search: 'Generate images',
    save_image_asset: 'Save image',
    document_search: 'Search documents',
    document_read: 'Read document',
    document_write: 'Update document',
    apply_patch: 'Apply patch',
    file_search: 'Search files',
    fs_read: 'Read file',
    fs_stat: 'Stat path',
    fs_list: 'List directory',
    fs_mkdir: 'Create directory',
    fs_remove: 'Remove path',
    fs_copy: 'Copy path',
    create_markdown: 'Save Markdown',
    pptx_create: 'Generate PPTX',
    docx_create: 'Generate DOCX',
    xlsx_create: 'Generate XLSX',
    artifact_write: 'Save artifact',
    register_artifact: 'Register artifact',
    shell_exec: 'Run command',
  },
  mcpDisplayPrefix: 'MCP',
  mcpActionTemplate: (server, tool) => `MCP ${server}: ${tool}`,
}

const DICTS: Record<AgentTimelineLocale, AgentTimelineDict> = {
  'en-US': EN_US_DICT,
}

export function getAgentTimelineDict(locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE) {
  return DICTS[locale] ?? DICTS[DEFAULT_AGENT_TIMELINE_LOCALE]
}

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName) {
    return null
  }
  const idx = toolName.indexOf('__')
  if (idx <= 0 || idx + 2 >= toolName.length) {
    return null
  }
  return { server: toolName.slice(0, idx), tool: toolName.slice(idx + 2) }
}

export function getAgentToolDisplayName(
  toolName: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (dict.toolDisplayName[toolName]) {
    return dict.toolDisplayName[toolName]
  }
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    return `${dict.mcpDisplayPrefix} · ${mcp.server} · ${mcp.tool.replaceAll('_', ' ')}`
  }
  return toolName.replaceAll('_', ' ')
}

export function getAgentToolActionLabel(
  toolName: string,
  locale: AgentTimelineLocale = DEFAULT_AGENT_TIMELINE_LOCALE,
) {
  const dict = getAgentTimelineDict(locale)
  if (dict.toolActionLabel[toolName]) {
    return dict.toolActionLabel[toolName]
  }
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    return dict.mcpActionTemplate(mcp.server, mcp.tool.replaceAll('_', ' '))
  }
  return getAgentToolDisplayName(toolName, locale)
}
