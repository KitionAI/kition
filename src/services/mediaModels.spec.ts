import { describe, it, expect } from 'vitest'
import { supportsDiscoveredDesktopModelCapability } from './mediaModels'

describe('supportsDiscoveredDesktopModelCapability', () => {
  describe('text capability', () => {
    it('accepts any non-empty model name', () => {
      expect(supportsDiscoveredDesktopModelCapability('gpt-5.4', 'text')).toBe(true)
      expect(supportsDiscoveredDesktopModelCapability('claude-sonnet-4-6', 'text')).toBe(true)
      expect(supportsDiscoveredDesktopModelCapability('image2', 'text')).toBe(true)
    })

    it('rejects empty/whitespace name', () => {
      expect(supportsDiscoveredDesktopModelCapability('', 'text')).toBe(false)
      expect(supportsDiscoveredDesktopModelCapability('   ', 'text')).toBe(false)
    })
  })

  describe('image capability', () => {
    it('accepts known image-model name fragments', () => {
      for (const name of [
        'gpt-image-1',
        'image2',
        'image-2',
        'dall-e-3',
        'dalle3',
        'imagen-3',
        'imagery-v2',
        'flux-pro',
        'sdxl-1.0',
        'stable-diffusion-3',
        'sd3-medium',
        'midjourney-v6',
        'ideogram-2',
      ]) {
        expect(supportsDiscoveredDesktopModelCapability(name, 'image'))
          .toBe(true)
      }
    })

    it('rejects text-only model names', () => {
      for (const name of [
        'gpt-5.4',
        'gpt-4o',
        'claude-sonnet-4-6',
        'claude-opus-4-7',
        'gemini-2.5-pro',
        'deepseek-chat',
        'qwen2.5-72b',
        'mistral-large',
      ]) {
        expect(supportsDiscoveredDesktopModelCapability(name, 'image'))
          .toBe(false)
      }
    })

    it('is case insensitive', () => {
      expect(supportsDiscoveredDesktopModelCapability('GPT-IMAGE-1', 'image')).toBe(true)
      expect(supportsDiscoveredDesktopModelCapability('Image2', 'image')).toBe(true)
      expect(supportsDiscoveredDesktopModelCapability('DALL-E-3', 'image')).toBe(true)
    })
  })

  describe('video capability', () => {
    it('accepts video-model name fragments', () => {
      for (const name of ['sora-1', 'veo-2', 'kling-1.6', 'runway-gen3', 'video-gen-v1']) {
        expect(supportsDiscoveredDesktopModelCapability(name, 'video')).toBe(true)
      }
    })

    it('rejects text/image models', () => {
      expect(supportsDiscoveredDesktopModelCapability('gpt-5.4', 'video')).toBe(false)
      expect(supportsDiscoveredDesktopModelCapability('image2', 'video')).toBe(false)
    })
  })

  describe('audio capability', () => {
    it('accepts audio-model name fragments', () => {
      for (const name of ['whisper-large', 'tts-1-hd', 'audio-2', 'voice-clone-v1', 'eleven-multilingual']) {
        expect(supportsDiscoveredDesktopModelCapability(name, 'audio')).toBe(true)
      }
    })

    it('rejects unrelated model names', () => {
      expect(supportsDiscoveredDesktopModelCapability('gpt-5.4', 'audio')).toBe(false)
      expect(supportsDiscoveredDesktopModelCapability('dall-e-3', 'audio')).toBe(false)
    })
  })
})
