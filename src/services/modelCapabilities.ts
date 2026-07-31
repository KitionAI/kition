import type { ModelCapability } from '@/types'

const CAPABILITY_NAME_FRAGMENTS: Record<Exclude<ModelCapability, 'text'>, readonly string[]> = {
  image: [
    'image', 'dall-e', 'dalle', 'imagen', 'imagery',
    'flux', 'sdxl', 'sd3', 'stable-diffusion',
    'midjourney', 'ideogram',
  ],
  vision: [
    'gpt-4', 'gpt-5', 'gpt-o', 'o1', 'o3', 'o4', 'omni',
    'claude-3', 'claude-4', 'claude-5', 'sonnet', 'haiku', 'opus',
    'gemini', 'pixtral', 'llava', 'internvl', 'qwen-vl', 'qwen2-vl', 'qwen3-vl',
    'deepseek-vl', 'yi-vl', 'glm-4v', 'minicpm-v', 'molmo',
    'vision', 'multimodal', 'vl-', 'mllm',
    'llama-3.2', 'llama-4', 'mistral-large', 'pixtral',
  ],
  video: ['video', 'sora', 'veo', 'kling', 'runway'],
  audio: ['whisper', 'tts', 'audio', 'voice', 'eleven'],
}

export function supportsDiscoveredDesktopModelCapability(
  modelName: string,
  capability: ModelCapability,
): boolean {
  const normalized = modelName.trim().toLowerCase()
  if (!normalized) return false
  if (capability === 'text') return true
  return CAPABILITY_NAME_FRAGMENTS[capability].some((fragment) => normalized.includes(fragment))
}

export function isLikelyTextGenerationModel(modelName: string): boolean {
  const normalized = modelName.trim()
  if (!normalized) return false
  return !(['image', 'video', 'audio'] as const).some((capability) =>
    supportsDiscoveredDesktopModelCapability(normalized, capability),
  )
}
