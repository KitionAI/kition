/**
 * The image composer request of a turn (`agent-image-generation.schema.json`):
 * its `image_generation` variant runs and how the turn ended.
 */
import type {
  AgentImageGenerationArtifact,
  AgentImageGenerationError,
} from '@/api/generated/agent-image-generation'
import { readField as field, type AgentToolRun, type AgentTurnView } from './agentSessionView'

type AgentImageJob = {
  requestId: string
  status: 'generating' | 'saving' | 'completed' | 'failed' | 'canceled'
  /** Settled variants over the requested count, from 0 to 1. */
  progress: number
  artifacts: AgentImageGenerationArtifact[]
  error: AgentImageGenerationError | null
}

function isVariantError(value: unknown): value is AgentImageGenerationError {
  return typeof field(value, 'code') === 'string'
    && typeof field(value, 'message') === 'string'
    && typeof field(value, 'retryable') === 'boolean'
}

function statusOf(turn: AgentTurnView, settled: number, variantCount: number): AgentImageJob['status'] {
  switch (turn.end?.reason) {
    case undefined:
      return settled < variantCount ? 'generating' : 'saving'
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'canceled'
    default:
      return 'failed'
  }
}

function errorOf(turn: AgentTurnView, runs: AgentToolRun[]): AgentImageGenerationError | null {
  const variant = runs.find((run) => run.status === 'failed' && isVariantError(run.output))
  if (variant) return variant.output as AgentImageGenerationError
  return { code: 'image_generation_failed', message: turn.end?.error ?? '', retryable: true }
}

/** The composer request of `turn`, or null when the turn made none. */
export function imageJobOf(turn: AgentTurnView): AgentImageJob | null {
  const runs = turn.toolRuns.filter((run) => (
    run.name === 'image_generation' && typeof field(run.arguments, 'request_id') === 'string'
  ))
  if (!runs.length) return null
  const variantCount = Number(field(runs[0].arguments, 'variant_count')) || 1
  const settled = runs.filter((run) => run.status !== 'running').length
  const status = statusOf(turn, settled, variantCount)
  const artifacts = runs
    .filter((run) => run.status === 'completed' && field(run.meta, 'kind') === 'image_generation.variant')
    .map((run) => field(run.meta, 'artifact') as AgentImageGenerationArtifact)
    .sort((a, b) => a.variant_index - b.variant_index)
  return {
    requestId: field(runs[0].arguments, 'request_id') as string,
    status,
    progress: Math.min(1, settled / variantCount),
    artifacts,
    error: status === 'failed' ? errorOf(turn, runs) : null,
  }
}
