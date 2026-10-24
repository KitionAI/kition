/**
 * Adapters that start a design from something the user already has: a
 * generated image or a table record. Each one maps its
 * source into the template slot filler or the artboard placement helpers,
 * so every entry point produces the same kind of document.
 */
import type { DesignRecordRef } from '@/types/designStart'
import { placeGeneratedImageInDesign } from './designImageGeneration'
import { fillDesignTemplate, type DesignBrandKit, type DesignTemplate, type DesignTemplateSlot } from './designTemplates'
import { createDesign, type DesignAsset, type DesignDocument } from './designTypes'

/** A generated image becomes the artboard; an exact text stays an editable headline. */
export function designFromImage(asset: DesignAsset, options: { title: string; headline?: string }): DesignDocument {
  const doc = createDesign(options.title, asset.width, asset.height)
  const placed = placeGeneratedImageInDesign(doc, asset, {
    exactText: options.headline ?? '',
    textMode: options.headline ? 'editable_overlay' : 'no_text',
  })
  placed.document.provenance = { imagePath: asset.path }
  return placed.document
}

/** Field names that fill each slot, checked in order and case-insensitively. */
const SLOT_FIELDS: Record<Extract<DesignTemplateSlot, 'headline' | 'body' | 'label'>, string[]> = {
  headline: ['headline', 'title', 'heading', 'name', 'product'],
  body: ['body', 'description', 'summary', 'subtitle', 'tagline', 'details'],
  label: ['label', 'tag', 'category', 'kicker', 'status'],
}

function recordText(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(recordText).filter(Boolean).join(', ')
  if (typeof value === 'object') return recordText((value as { name?: unknown; label?: unknown }).name ?? (value as { label?: unknown }).label)
  return String(value).trim()
}

/** Resolves template slots from a record's fields by name. */
export function recordSlots(fields: Record<string, unknown>): Partial<Record<DesignTemplateSlot, string>> {
  const lookup = new Map(Object.entries(fields).map(([name, value]) => [name.trim().toLowerCase(), value]))
  const slots: Partial<Record<DesignTemplateSlot, string>> = {}
  for (const [slot, names] of Object.entries(SLOT_FIELDS) as Array<[keyof typeof SLOT_FIELDS, string[]]>) {
    for (const name of names) {
      const text = recordText(lookup.get(name))
      if (text) {
        slots[slot] = text
        break
      }
    }
  }
  return slots
}

/** One design per record: the template filled with the record's fields. */
export function designFromRecord(
  template: DesignTemplate,
  fields: Record<string, unknown>,
  options: { brand?: DesignBrandKit; title?: string; record?: DesignRecordRef } = {},
): DesignDocument {
  const slots = recordSlots(fields)
  const doc = fillDesignTemplate(template, {
    slots,
    brand: options.brand,
    title: options.title ?? slots.headline ?? template.name,
  })
  if (options.record) doc.provenance = { ...doc.provenance, recordRef: options.record }
  return doc
}
