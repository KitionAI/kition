import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain Node script without type declarations.
import { isChecked, kitNames, kitPattern, matchesIn } from './check-kit-neutral.mjs'

const pattern = () => kitPattern(kitNames({ $comment: 'The kits.', table: {}, film: {}, pdf: {} }))
const found = (file: string, text: string) => matchesIn(file, text, pattern()).map((match: { line: number; text: string }) => `${match.line}:${match.text}`)

describe('check-kit-neutral', () => {
  it('reads the kit names from the lock file, without its comment', () => {
    expect(kitNames({ $comment: 'The kits.', table: {}, film: {} })).toEqual(['table', 'film'])
  })

  it('finds a kit id, a kit extension, and a kit engine named in code', () => {
    expect(found('src/a.ts', "const kit = 'kit.table'\nif (path.endsWith('.kfilm')) open()\nload('kition_table_kit', 'TableDocument')\n")).toEqual([
      "1:'kit.table'",
      '2:kfilm',
      '3:kition_table_kit',
      "3:'TableDocument'",
    ])
  })

  it('leaves alone other words, other libraries\' types, and a kit that is not shipped', () => {
    expect(found('src/a.ts', "const kind = 'table'\nlet document: PdfDocument\nconst other = 'kit.unknown'\nconst method = kit.table\n")).toEqual([])
  })

  it('skips comment lines, and a Rust file from its tests on', () => {
    expect(found('src/a.ts', "// for example 'kit.table'\n/** a `.ktable` file */\n * `.kfilm`\n")).toEqual([])
    expect(found('crates/a/src/lib.rs', 'const A: &str = "kit.table";\n#[cfg(test)]\nmod tests {\n    const B: &str = "kit.film";\n}\n')).toEqual(['1:"kit.table"'])
  })

  it('checks source files, not tests, locale files, or generated code', () => {
    expect(isChecked('src/features/a/b.tsx')).toBe(true)
    expect(isChecked('crates/kition-kits/src/tools.rs')).toBe(true)
    for (const file of ['src/a.spec.ts', 'src/test/contracts.ts', 'src-tauri/src/workspace/docstore/tests.rs', 'crates/a/src/gate_tests.rs', 'src/i18n/locales/en-US/workspace.ts', 'src/api/generated/kits.ts', 'src/app/styles.css']) {
      expect(isChecked(file), file).toBe(false)
    }
  })
})
