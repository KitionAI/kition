/**
 * The `table_plan` summary of a table turn: the fenced JSON block the model
 * appends in preview/apply mode, merged with what the turn's table tools
 * actually did. A port of `extract` and `finalize` in the runtime's
 * `table_plan.rs`, read from a turn of the session view.
 */

/** The parts of a session view turn (`AgentTurnView`) a table plan reads. */
type TablePlanRun = { name: string; arguments: unknown; output: unknown }
type TablePlanTurn = {
  preset?: string
  steps: { message?: { content: string } }[]
  toolRuns: TablePlanRun[]
  end?: { reason: string }
}

/** The merged plan the table plan card shows. */
type AgentTablePlan = {
  summary?: string
  source_scope?: string
  entity_name?: string
  proposed_fields?: string[]
  created_field_titles?: string[]
  recommended_unique_by?: string[]
  final_unique_by?: string[]
  risks?: string[]
  notes?: string[]
  estimated_create?: number
  estimated_update?: number
  estimated_skip?: number
  actual_created?: number
  actual_updated?: number
  actual_skipped?: number
  execution_mode?: string
  event_source?: 'table_plan'
  requires_apply_confirmation?: boolean
  applied?: boolean
}

type Plan = Record<string, unknown>

const BLOCK = /```table_plan\s*(\{[\s\S]*?\})\s*```/
const BLOCKS = new RegExp(BLOCK.source, 'g')

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

const TABLE_TOOLS = new Set([
  'data_table_record_draft',
  'data_table_add_fields',
  'data_table_add_records',
  'table_upsert_records',
])

function strings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => (typeof item === 'string' ? item.trim() : JSON.stringify(item)))
      .filter((item) => item !== '')
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

function merge(base: string[], extra: string[]) {
  for (const item of extra) {
    if (!base.includes(item)) base.push(item)
  }
}

function int(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return 0
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBlock(content: string): Plan | null {
  const match = BLOCK.exec(content)
  if (!match) return null
  try {
    const raw = JSON.parse(match[1]) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Plan : null
  } catch {
    return null
  }
}

/** The reply as shown: without its plan blocks when the first one is valid JSON. */
export function replyWithoutTablePlan(content: string): string {
  return parseBlock(content) ? content.replace(BLOCKS, '').trim() : content.trim()
}

function extract(content: string): Plan {
  const raw = parseBlock(content)
  const plan: Plan = {}
  if (!raw) return plan
  for (const key of ['summary', 'source_scope', 'entity_name']) {
    const value = text(raw[key])
    if (value) plan[key] = value
  }
  for (const key of ['proposed_fields', 'risks', 'notes']) {
    const list = strings(raw[key])
    if (list.length) plan[key] = list
  }
  const unique = strings('recommended_unique_by' in raw ? raw.recommended_unique_by : raw.unique_by)
  if (unique.length) plan.recommended_unique_by = unique
  for (const [key, short] of [['estimated_create', 'create'], ['estimated_update', 'update'], ['estimated_skip', 'skip']]) {
    const value = Math.max(int(raw[key]), int(field(raw.estimated_counts, short)))
    if (value > 0) plan[key] = value
  }
  return plan
}

function lastReplyContent(turn: TablePlanTurn): string {
  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    const content = turn.steps[index].message?.content ?? ''
    if (content.trim()) return content
  }
  return ''
}

type Tally = {
  proposed: string[]
  unique: string[]
  createdFields: string[]
  finalUnique: string[]
  estimatedCreate: number
  created: number
  updated: number
  skipped: number
  wrote: boolean
}

function tally(plan: Plan, runs: TablePlanRun[]): Tally {
  const result: Tally = {
    proposed: strings(plan.proposed_fields),
    unique: strings(plan.recommended_unique_by),
    createdFields: [],
    finalUnique: [],
    estimatedCreate: int(plan.estimated_create),
    created: 0,
    updated: 0,
    skipped: 0,
    wrote: false,
  }
  for (const run of runs) {
    const output = run.output
    if (run.name === 'data_table_record_draft') {
      const missing = field(output, 'missing_fields')
      merge(result.proposed, (Array.isArray(missing) ? missing : [])
        .map((item) => text(field(item, 'title')))
        .filter(Boolean))
      merge(result.unique, strings(field(output, 'recommended_unique_by')))
      if (result.estimatedCreate === 0) result.estimatedCreate = int(field(output, 'record_draft_count'))
    } else if (run.name === 'data_table_add_fields') {
      const created = field(output, 'created')
      result.createdFields.push(...(Array.isArray(created) ? created : [])
        .map((item) => text(field(item, 'title')))
        .filter(Boolean))
    } else if (run.name === 'data_table_add_records' || run.name === 'table_upsert_records') {
      result.wrote = true
      result.created = int(field(output, 'created'))
      result.updated = int(field(output, 'updated'))
      result.skipped = int(field(output, 'skipped'))
      result.finalUnique = strings(field(output, 'unique_by'))
      if (!result.finalUnique.length) result.finalUnique = strings(field(run.arguments, 'unique_by'))
    }
  }
  merge(result.proposed, result.createdFields)
  if (!result.unique.length) result.unique = [...result.finalUnique]
  return result
}

function summarize(plan: Plan, done: Tally, mode: string) {
  if (text(plan.summary)) return
  const parts: string[] = []
  if (done.createdFields.length) parts.push(`Added fields: ${done.createdFields.join(', ')}`)
  if (done.created > 0 || done.updated > 0 || done.skipped > 0) {
    parts.push(`Record changes: created ${done.created}, updated ${done.updated}, skipped ${done.skipped}`)
  }
  if (!parts.length && mode === 'preview' && done.estimatedCreate > 0) {
    const scope = text(plan.source_scope)
    parts.push(`Drafted ${done.estimatedCreate} table-ready records from ${scope || 'current source'}`)
  }
  if (parts.length) plan.summary = parts.join('; ')
}

/**
 * The table plan of a completed turn: its final reply's `table_plan` block
 * merged with the turn's table tool runs, in the turn's permission preset.
 * Null when the turn neither planned nor wrote table data.
 */
export function deriveTablePlan(turn: TablePlanTurn): AgentTablePlan | null {
  if (turn.end?.reason !== 'completed') return null
  const mode = turn.preset ?? ''
  const plan = extract(lastReplyContent(turn))
  if (!Object.keys(plan).length && !turn.toolRuns.some((run) => TABLE_TOOLS.has(run.name))) return null
  const done = tally(plan, turn.toolRuns)
  const set = (key: string, list: string[]) => {
    if (list.length) plan[key] = list
  }
  set('proposed_fields', done.proposed)
  set('created_field_titles', done.createdFields)
  set('recommended_unique_by', done.unique)
  set('final_unique_by', done.finalUnique)
  if (done.estimatedCreate > 0) plan.estimated_create = done.estimatedCreate
  const report = done.wrote && mode === 'apply'
  for (const [key, value] of [['actual_created', done.created], ['actual_updated', done.updated], ['actual_skipped', done.skipped]] as const) {
    if (value > 0 || report) plan[key] = value
  }
  summarize(plan, done, mode)
  if (!Object.keys(plan).length) return null
  plan.execution_mode = mode
  plan.event_source = 'table_plan'
  if (mode === 'preview') plan.requires_apply_confirmation = true
  if (mode === 'apply') plan.applied = true
  return plan as AgentTablePlan
}
