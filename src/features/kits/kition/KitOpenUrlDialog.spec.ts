import { describe, expect, it } from 'vitest'
import { openUrlParts } from './KitOpenUrlDialog'

describe('openUrlParts', () => {
  it('names the site of a web or mail address', () => {
    expect(openUrlParts('https://Example.com/docs?a=1')).toEqual({ address: 'https://Example.com/docs?a=1', host: 'example.com', asciiHost: null })
    expect(openUrlParts('http://user@example.org:8080/x')).toEqual({ address: 'http://user@example.org:8080/x', host: 'example.org', asciiHost: null })
    expect(openUrlParts('mailto:team@example.com?subject=Hi')).toEqual({ address: 'mailto:team@example.com?subject=Hi', host: 'example.com', asciiHost: null })
  })

  it('shows the ASCII form of a non-ASCII host name', () => {
    expect(openUrlParts('https://bücher.example/a')).toEqual({ address: 'https://bücher.example/a', host: 'bücher.example', asciiHost: 'xn--bcher-kva.example' })
  })

  it('answers nothing without a host', () => {
    expect(openUrlParts('mailto:')).toBeNull()
    expect(openUrlParts('https:///path')).toBeNull()
  })
})
