import { describe, expect, it } from 'vitest'
import { getBuiltinTemplates } from './index'

// Pass-through translator: tests assert on structure / ids / types, not on
// localised string content. Threading the i18n key back as the value gives
// each assertion a stable, language-agnostic anchor.
const t = (key: string) => key

describe('builtin templates', () => {
  it('exposes exactly 5 templates with stable order and unique ids', () => {
    const tpls = getBuiltinTemplates(t)
    expect(tpls).toHaveLength(5)
    const ids = tpls.map((tpl) => tpl.id)
    expect(new Set(ids).size).toBe(5)
    expect(ids).toEqual([
      'email-me-on-record',
      'daily-followup-reminder',
      'email-on-record-updated',
      'email-on-record-date',
      'add-record-daily-morning',
    ])
  })

  it('adds the local onboarding template only for the Content Ideas source table', () => {
    expect(getBuiltinTemplates(t, { tableName: 'Tasks' }).some((tpl) => tpl.id === 'content-idea-to-publishing-queue')).toBe(false)
    const templates = getBuiltinTemplates(t, { tableName: 'Content Ideas' })
    expect(templates[0]?.id).toBe('content-idea-to-publishing-queue')
    expect(templates[0]?.enabledByDefault).toBe(true)
    expect(templates[0]?.draft.action.type).toBe('add_record')
  })

  it('adds two distinct runnable scenarios for Tasks', () => {
    const templates = getBuiltinTemplates(t, { tableName: 'Tasks' })
    expect(templates.slice(0, 2).map((tpl) => tpl.id)).toEqual([
      'archive-completed-tasks',
      'weekday-priority-planning',
    ])
    expect(templates[0].draft.trigger.type).toBe('record_updated')
    expect(templates[0].draft.filter?.conditions).toEqual([
      { fieldName: 'Status', op: '==', value: 'Done' },
    ])
    expect(templates[1].draft.trigger.type).toBe('scheduled_time')
  })

  it('adds the created-or-updated reading journal scenario for Reading List', () => {
    const templates = getBuiltinTemplates(t, { tableName: 'Reading List' })
    expect(templates[0]?.id).toBe('reading-progress-journal')
    expect(templates[0]?.draft.trigger.type).toBe('record_created_or_updated')
    expect(templates[0]?.enabledByDefault).toBe(true)
  })

  it('adds three differentiated, runnable record-action scenarios to their included tables', () => {
    const cases = [
      ['Expenses', 'expense-high-value-review', 'update_record'],
      ['Orders', 'order-catalog-enrichment', 'lookup_record'],
      ['Contacts', 'normalize-contact-details', 'transform_record'],
    ] as const
    for (const [tableName, id, actionType] of cases) {
      const template = getBuiltinTemplates(t, { tableName })[0]
      expect(template.id).toBe(id)
      expect(template.enabledByDefault).toBe(true)
      expect(template.draft.trigger.type).toBe('record_created_or_updated')
      expect(template.draft.action.type).toBe(actionType)
    }
  })

  it('every template uses only supported trigger/action types', () => {
    // record_updated / record_created_or_updated were added so the
    // Feishu-style "notify on update" template can be expressed.
    // record_date_reached was added for the Feishu-style "At record's
    // trigger time → send a reminder" template. scheduled_time is the
    // "At scheduled time" trigger (cron-driven). Keep this list in sync
    // with TemplateDraft.trigger.type in templates/index.ts.
    const supportedTriggers = [
      'record_created',
      'record_updated',
      'record_created_or_updated',
      'record_date_reached',
      'scheduled_time',
    ]
    const supportedActions = ['send_email', 'add_record']
    for (const tpl of getBuiltinTemplates(t)) {
      expect(supportedTriggers).toContain(tpl.draft.trigger.type)
      expect(supportedActions).toContain(tpl.draft.action.type)
      // send_email templates ship body parts; add_record templates ship none
      // (target table + per-field templates are picked by the user in the
      // drawer after creation, mirroring record_date_reached's delayed
      // date-field binding).
      if (tpl.draft.action.type === 'send_email') {
        expect(tpl.draft.action.bodyParts.length).toBeGreaterThan(0)
      }
    }
  })

  it('includes a record_updated template (Feishu-style notify-on-change pattern)', () => {
    const tpls = getBuiltinTemplates(t)
    const updated = tpls.find((tpl) => tpl.draft.trigger.type === 'record_updated')
    expect(updated).toBeDefined()
    expect(updated?.id).toBe('email-on-record-updated')
  })

  it("includes a record_date_reached template (Feishu-style \"At record's trigger time\" pattern)", () => {
    const tpls = getBuiltinTemplates(t)
    const dated = tpls.find((tpl) => tpl.draft.trigger.type === 'record_date_reached')
    expect(dated).toBeDefined()
    expect(dated?.id).toBe('email-on-record-date')
    // The card should visually signal "date + reminder" — CalendarClock is
    // what matches the green calendar icon in the original Feishu screenshot,
    // so guard against accidental icon regressions.
    expect(dated?.icons.some((i) => i.kind === 'lucide' && i.name === 'CalendarClock')).toBe(true)
  })

  it("includes a scheduled_time + add_record template (Feishu-style \"At scheduled time → Add a record\" pattern)", () => {
    const tpls = getBuiltinTemplates(t)
    const scheduled = tpls.find((tpl) => tpl.draft.trigger.type === 'scheduled_time')
    expect(scheduled).toBeDefined()
    expect(scheduled?.id).toBe('add-record-daily-morning')
    // The trigger must ship a cron expression so the workflow is runnable
    // out of the box (no further config needed on the trigger node).
    if (scheduled?.draft.trigger.type === 'scheduled_time') {
      expect(scheduled.draft.trigger.schedule.cron).toBe('0 11 * * *')
    } else {
      throw new Error('expected scheduled_time trigger discriminant')
    }
    expect(scheduled?.draft.action.type).toBe('add_record')
  })

  it('every template has 1–3 icons', () => {
    for (const tpl of getBuiltinTemplates(t)) {
      expect(tpl.icons.length).toBeGreaterThanOrEqual(1)
      expect(tpl.icons.length).toBeLessThanOrEqual(3)
    }
  })

  it('routes every visible string through the translator (no hardcoded English in name/description)', () => {
    // The factory should call t() for both card-level name/description and
    // the draft.name used as the resulting workflow's title. Returning the
    // key from our pass-through t lets us assert that the resolved value
    // looks like a key path, not a hardcoded sentence.
    for (const tpl of getBuiltinTemplates(t)) {
      expect(tpl.name).toMatch(/^templates\.[a-zA-Z]+\.name$/)
      expect(tpl.description).toMatch(/^templates\.[a-zA-Z]+\.description$/)
      expect(tpl.draft.name).toMatch(/^templates\.[a-zA-Z]+\.name$/)
    }
  })
})
