import { AGENT_DESIGN_CAPABILITY } from '@/types/designAgent'

export function runtimeSupportsDesignAgent(capabilities?: readonly string[]): boolean {
  return Boolean(capabilities?.includes(AGENT_DESIGN_CAPABILITY))
}
