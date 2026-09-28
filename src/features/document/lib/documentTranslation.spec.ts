import { describe, expect, it } from 'vitest'

import {
  buildTranslationMessages,
  cleanTranslationResult,
  detectDominantScript,
  isTextInLanguage,
  resolveTranslationTarget,
  translationLanguageEndonym,
  translationLanguageEnglishName,
} from './documentTranslation'

// Non-Latin samples are built from code points so the source stays English-only.
const CHINESE_SAMPLE = String.fromCodePoint(0x81ea, 0x7136, 0x6d41, 0x91cf, 0x4e0b, 0x964d)
const JAPANESE_SAMPLE = String.fromCodePoint(0x81ea, 0x7136, 0x306a, 0x30c8, 0x30e9, 0x30d5, 0x30a3, 0x30c3, 0x30af)
const KOREAN_SAMPLE = String.fromCodePoint(0xd2b8, 0xb798, 0xd53d)
const RUSSIAN_SAMPLE = String.fromCodePoint(0x0442, 0x0440, 0x0430, 0x0444, 0x0438, 0x043a)
const ENGLISH_SAMPLE = 'When organic traffic to a page is down, check the phrases for which that page ranks.'
const SPANISH_SAMPLE = 'Cuando el tráfico orgánico de una página baja, revisa las frases.'

describe('detectDominantScript', () => {
  it.each([
    [CHINESE_SAMPLE, 'han'],
    [JAPANESE_SAMPLE, 'kana'],
    [KOREAN_SAMPLE, 'hangul'],
    [RUSSIAN_SAMPLE, 'cyrillic'],
    [ENGLISH_SAMPLE, 'latin'],
    ['123 !?', 'other'],
  ])('%s is %s', (text, script) => {
    expect(detectDominantScript(text)).toBe(script)
  })
})

describe('isTextInLanguage', () => {
  it('recognizes scripts and English text, and stays conservative for other Latin languages', () => {
    expect(isTextInLanguage(CHINESE_SAMPLE, 'zh-Hans')).toBe(true)
    expect(isTextInLanguage(JAPANESE_SAMPLE, 'zh-Hans')).toBe(false)
    expect(isTextInLanguage(ENGLISH_SAMPLE, 'en')).toBe(true)
    expect(isTextInLanguage(SPANISH_SAMPLE, 'en')).toBe(false)
    expect(isTextInLanguage(SPANISH_SAMPLE, 'es')).toBe(false)
    expect(isTextInLanguage('organic', 'en')).toBe(false)
  })
})

describe('resolveTranslationTarget', () => {
  it('follows the app language when the preference is auto', () => {
    expect(resolveTranslationTarget({ preference: 'auto', appLocale: 'zh-CN', text: ENGLISH_SAMPLE })).toBe('zh-Hans')
    expect(resolveTranslationTarget({ preference: 'auto', appLocale: 'fr-FR', text: ENGLISH_SAMPLE })).toBe('fr')
  })

  it('uses an explicit preference over the app language', () => {
    expect(resolveTranslationTarget({ preference: 'ja', appLocale: 'en-US', text: ENGLISH_SAMPLE })).toBe('ja')
  })

  it('switches to the other side of the pair when the text is already in the target', () => {
    expect(resolveTranslationTarget({ preference: 'auto', appLocale: 'en-US', text: ENGLISH_SAMPLE })).toBe('zh-Hans')
    expect(resolveTranslationTarget({ preference: 'zh-Hans', appLocale: 'en-US', text: CHINESE_SAMPLE })).toBe('en')
    expect(resolveTranslationTarget({ preference: 'auto', appLocale: 'en-US', text: SPANISH_SAMPLE })).toBe('en')
  })
})

describe('language names', () => {
  it('gives an English name for prompts and a native name for menus', () => {
    expect(translationLanguageEnglishName('ja')).toBe('Japanese')
    expect(translationLanguageEndonym('en')).toBe('English')
    expect(translationLanguageEndonym('fr')).toBe('français')
  })
})

describe('buildTranslationMessages', () => {
  it('names the target and asks to keep Markdown, links, and code intact', () => {
    const [system, user] = buildTranslationMessages('- See [the docs](https://example.com) and `npm test`', 'de')
    expect(system.role).toBe('system')
    expect(system.content).toContain('German (de)')
    expect(system.content).toMatch(/keep link URLs unchanged/i)
    expect(system.content).toMatch(/inline code/i)
    expect(system.content).toMatch(/\[\[wikilink\]\]/)
    expect(user).toEqual({ role: 'user', content: '- See [the docs](https://example.com) and `npm test`' })
  })
})

describe('cleanTranslationResult', () => {
  it('strips a wrapping fence or quotes unless the source had them', () => {
    expect(cleanTranslationResult('```markdown\nBonjour\n```', 'Hello')).toBe('Bonjour')
    expect(cleanTranslationResult('```\ncode\n```', '```\ncode\n```')).toBe('```\ncode\n```')
    expect(cleanTranslationResult('"Bonjour"', 'Hello')).toBe('Bonjour')
    expect(cleanTranslationResult('"Bonjour"', '"Hello"')).toBe('"Bonjour"')
    expect(cleanTranslationResult('\n\n  Bonjour  \n', 'Hello')).toBe('Bonjour')
  })
})
