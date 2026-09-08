import { AGENT_IMAGE_GENERATION_CAPABILITY } from '@/types/imageGeneration'

export function runtimeSupportsAgentImageGeneration(
  capabilities?: readonly string[],
) {
  return Boolean(capabilities?.includes(AGENT_IMAGE_GENERATION_CAPABILITY))
}
