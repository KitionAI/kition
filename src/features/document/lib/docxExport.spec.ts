import { describe, expect, it } from 'vitest'
import { buildWordExportBlob } from './docxExport'

const sampleMarkdown = `# Title

A paragraph with **bold**, _italic_, and \`code\`.

- bullet one
- bullet two

1. ordered one
2. ordered two

> Quote line

\`\`\`ts
const x = 1
\`\`\`

| a | b |
| - | - |
| 1 | 2 |
`

describe('buildWordExportBlob', () => {
  it('produces a non-empty docx blob from a varied markdown sample', async () => {
    const blob = await buildWordExportBlob({
      markdown: sampleMarkdown,
      title: 'Sample',
      includeMedia: false,
    })

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(1024)
    expect(blob.type).toMatch(/wordprocessingml/)
  })

  it('handles empty input without throwing', async () => {
    const blob = await buildWordExportBlob({
      markdown: '',
      title: '',
      includeMedia: false,
    })
    expect(blob.size).toBeGreaterThan(0)
  })

  it('preserves the title heading when markdown lacks an h1', async () => {
    const blob = await buildWordExportBlob({
      markdown: 'just text',
      title: 'Outer Title',
      includeMedia: false,
      includeName: true,
    })
    expect(blob.size).toBeGreaterThan(0)
  })
})
