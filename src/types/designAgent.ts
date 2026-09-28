/**
 * Public boundary for the Agent's view of a design and the patches it may
 * propose. Shapes come from contracts/runtime/agent-design.schema.json; this
 * module only names them and pins the limits the client enforces.
 */
import type {
  AgentDesignContext,
  AgentDesignLayer,
  AgentDesignLayerRole,
  AgentDesignPatch,
  AgentDesignPatchOperation,
  AgentDesignStyle,
} from '@/api/generated/agent-design'

export const AGENT_DESIGN_CAPABILITY = 'agent_design_v1' as const
export const AGENT_DESIGN_SCHEMA_VERSION = 1 as const
export const AGENT_DESIGN_PATCH_OPERATION_LIMIT = 100 as const
export const AGENT_DESIGN_CONTEXT_LAYER_LIMIT = 500 as const
export const AGENT_DESIGN_SELECTION_LIMIT = 100 as const
export const AGENT_DESIGN_TEXT_LIMIT = 2000 as const

export type {
  AgentDesignContext,
  AgentDesignLayer,
  AgentDesignLayerRole,
  AgentDesignPatch,
  AgentDesignPatchOperation,
  AgentDesignStyle,
}
