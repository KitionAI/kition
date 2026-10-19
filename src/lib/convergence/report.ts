// Copied from kition-sdk packages/convergence/src/report.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The suite's results and their JSON: the same report as the Rust `kition_convergence::Report`,
 * which `tools/check-manifest.mjs --convergence` reads for L6.
 */

/** The suite's name and version in reports: scenarios are only added in a minor version. Both runners write the same one. */
export const SUITE = 'kition-convergence 1.0'

/** How one scenario went; `skipped` when the kit has no such step, with why. */
export type Outcome = { kind: 'passed' } | { kind: 'failed'; reason: string } | { kind: 'skipped'; reason: string }

/** One scenario's result. */
export type Check = {
  id: string
  title: string
  /** Whether L6 needs it to pass (rather than be skipped). */
  required: boolean
  outcome: Outcome
}

/** A report as JSON: `{ kit, suite, level6, checks: [{ id, title, required, outcome, reason? }] }`. */
export type ReportJson = {
  kit: string
  suite: string
  level6: boolean
  checks: Array<{ id: string; title: string; required: boolean; outcome: Outcome['kind']; reason?: string }>
}

export class Report {
  readonly checks: Check[] = []

  constructor(readonly kit: string) {}

  /** No scenario failed. Skips are allowed here; `level6` is stricter. */
  passed(): boolean {
    return this.checks.length > 0 && this.checks.every((check) => check.outcome.kind !== 'failed')
  }

  /** The kit passes the convergence suite for L6: nothing failed and no required scenario was skipped. */
  level6(): boolean {
    return this.passed() && this.checks.every((check) => !check.required || check.outcome.kind === 'passed')
  }

  outcome(id: string): Outcome | undefined {
    return this.checks.find((check) => check.id === id)?.outcome
  }

  toJson(): ReportJson {
    return {
      kit: this.kit,
      suite: SUITE,
      level6: this.level6(),
      checks: this.checks.map((check) => ({
        id: check.id,
        title: check.title,
        required: check.required,
        outcome: check.outcome.kind,
        ...(check.outcome.kind === 'passed' ? {} : { reason: check.outcome.reason }),
      })),
    }
  }

  /**
   * The JSON as the Rust suite writes it to `KITION_CONVERGENCE_REPORT` (`{:#}` of a
   * `serde_json` value): keys sorted, two-space indents, a final newline.
   */
  toJsonText(): string {
    return `${JSON.stringify(sortKeys(this.toJson()), null, 2)}\n`
  }

  /** One line per scenario, then the summary. */
  render(): string {
    let out = ''
    for (const check of this.checks) {
      const { outcome } = check
      if (outcome.kind === 'passed') out += `PASS ${check.id} - ${check.title}\n`
      else if (outcome.kind === 'failed') out += `FAIL ${check.id} - ${check.title}: ${outcome.reason}\n`
      else out += `SKIP ${check.id} - ${check.title}${check.required ? ' (required for L6)' : ''}: ${outcome.reason}\n`
    }
    const passed = this.checks.filter((check) => check.outcome.kind === 'passed').length
    out += `${this.kit}: ${passed}/${this.checks.length} scenarios passed; L6 convergence ${this.level6() ? 'passed' : 'not passed'}\n`
    return out
  }

  push(id: string, title: string, required: boolean, outcome: Outcome) {
    this.checks.push({ id, title, required, outcome })
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortKeys(source[key])]))
  }
  return value
}
