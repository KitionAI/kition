import type { DataField, DataRecord } from '@/types/dataDocument'

export const MAX_AI_FIELD_PIPELINE_DEPTH = 32

export type AIFieldExecutionPlan = {
  fields: DataField[]
  cyclicFieldIds: number[]
}

export function isEmptyAIFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

export function getAIFieldDependencyIds(
  field: DataField,
  fields: DataField[],
) {
  const config = field.ai_config
  if (!config?.enabled) return []
  const dependencyIds = new Set<number>()
  if ('source_field_id' in config && config.source_field_id) {
    dependencyIds.add(config.source_field_id)
  }
  if ('prompt' in config) {
    const fieldByName = new Map(fields.map((item) => [item.name, item]))
    for (const match of config.prompt.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
      const dependency = fieldByName.get(match[1].trim())
      if (dependency && dependency.id !== field.id) dependencyIds.add(dependency.id)
    }
  }
  return Array.from(dependencyIds)
}

function compareFields(left: DataField, right: DataField) {
  return left.order - right.order || left.id - right.id
}

function buildExecutionPlan(
  fields: DataField[],
  candidateIds: Set<number>,
): AIFieldExecutionPlan {
  const candidateFields = fields
    .filter((field) => candidateIds.has(field.id))
    .sort(compareFields)
  const candidateIdSet = new Set(candidateFields.map((field) => field.id))
  const dependenciesByFieldId = new Map(
    candidateFields.map((field) => [
      field.id,
      getAIFieldDependencyIds(field, fields).filter((id) => candidateIdSet.has(id)),
    ]),
  )
  const dependentIdsByFieldId = new Map<number, number[]>()
  const indegree = new Map<number, number>()
  for (const field of candidateFields) {
    const dependencies = dependenciesByFieldId.get(field.id) || []
    indegree.set(field.id, dependencies.length)
    for (const dependencyId of dependencies) {
      const dependents = dependentIdsByFieldId.get(dependencyId) || []
      dependents.push(field.id)
      dependentIdsByFieldId.set(dependencyId, dependents)
    }
  }

  const fieldById = new Map(candidateFields.map((field) => [field.id, field]))
  const ready = candidateFields.filter((field) => indegree.get(field.id) === 0)
  const ordered: DataField[] = []
  while (ready.length && ordered.length < MAX_AI_FIELD_PIPELINE_DEPTH) {
    ready.sort(compareFields)
    const field = ready.shift() as DataField
    ordered.push(field)
    for (const dependentId of dependentIdsByFieldId.get(field.id) || []) {
      const nextIndegree = (indegree.get(dependentId) || 0) - 1
      indegree.set(dependentId, nextIndegree)
      if (nextIndegree === 0) {
        const dependent = fieldById.get(dependentId)
        if (dependent) ready.push(dependent)
      }
    }
  }

  const orderedIds = new Set(ordered.map((field) => field.id))
  return {
    fields: ordered,
    cyclicFieldIds: candidateFields
      .filter((field) => !orderedIds.has(field.id))
      .map((field) => field.id),
  }
}

export function getCreateTimeAIFieldPlan(fields: DataField[]) {
  return buildExecutionPlan(
    fields,
    new Set(
      fields
        .filter((field) => field.ai_config?.enabled && field.ai_config.auto_update)
        .map((field) => field.id),
    ),
  )
}

export function getAutoUpdateAIFieldPlan(
  fields: DataField[],
  changedFieldIds: Iterable<number>,
) {
  const changedIds = new Set(changedFieldIds)
  const autoFields = fields.filter(
    (field) => field.ai_config?.enabled && field.ai_config.auto_update,
  )
  const reachableIds = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    for (const field of autoFields) {
      if (reachableIds.has(field.id)) continue
      const dependencies = getAIFieldDependencyIds(field, fields)
      if (dependencies.some((id) => changedIds.has(id) || reachableIds.has(id))) {
        reachableIds.add(field.id)
        changed = true
      }
    }
  }
  return buildExecutionPlan(fields, reachableIds)
}

export function canRunAutoAIField(
  record: DataRecord,
  field: DataField,
  fields: DataField[],
) {
  const dependencyFields = getAIFieldDependencyIds(field, fields)
    .map((id) => fields.find((item) => item.id === id))
    .filter((item): item is DataField => Boolean(item))
  if (!dependencyFields.length) return false

  const sourceFieldId = field.ai_config && 'source_field_id' in field.ai_config
    ? field.ai_config.source_field_id
    : undefined
  const mandatoryDependencies = dependencyFields.filter((dependency) =>
    dependency.required
    || Boolean(dependency.ai_config?.enabled)
    || sourceFieldId === dependency.id,
  )
  if (mandatoryDependencies.length) {
    return mandatoryDependencies.every(
      (dependency) => !isEmptyAIFieldValue(record.values?.[dependency.name]),
    )
  }
  return dependencyFields.some(
    (dependency) => !isEmptyAIFieldValue(record.values?.[dependency.name]),
  )
}
