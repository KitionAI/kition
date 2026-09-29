/**
 * Adapters that start a design from something the user already has: a
 * generated image, a Board frame, or a table record. Each one maps its
 * source into the template slot filler or the artboard placement helpers,
 * so every entry point produces the same kind of document.
 */
import type { BoardFrameSnapshot, DesignRecordRef } from '@/types/designStart'
import { placeGeneratedImageInDesign } from './designImageGeneration'
import { fillDesignTemplate, type DesignBrandKit, type DesignTemplate, type DesignTemplateSlot } from './designTemplates'
import { createDesign, createDesignNode, type DesignAsset, type DesignDocument } from './designTypes'

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

/**
 * Imports a Board frame as editable layers. Shapes and text map directly;
 * images resolve through `resolveAsset` and are skipped when unavailable.
 */
export async function designFromBoardFrame(
  frame: BoardFrameSnapshot,
  resolveAsset: (workspacePath: string) => Promise<DesignAsset>,
): Promise<DesignDocument> {
  const doc = createDesign(frame.title, Math.max(1, Math.round(frame.width)), Math.max(1, Math.round(frame.height)))
  const page = doc.pages[0]
  if (frame.background) page.background = frame.background
  for (const item of frame.items) {
    const base = {
      transform: [1, 0, 0, 1, item.x, item.y] as [number, number, number, number, number, number],
      width: Math.max(1, item.width),
      height: Math.max(1, item.height),
    }
    if (item.kind === 'image') {
      if (!item.workspacePath) continue
      let asset: DesignAsset
      try {
        asset = await resolveAsset(item.workspacePath)
      } catch {
        continue
      }
      doc.assets[asset.id] = asset
      const node = createDesignNode('image', {
        ...base,
        name: item.workspacePath.split('/').pop() || 'Image',
        assetId: asset.id,
        crop: { x: 0, y: 0, width: asset.width, height: asset.height },
      })
      doc.nodes[node.id] = node
      page.children.push(node.id)
      continue
    }
    if (item.kind === 'text') {
      const node = createDesignNode('text', {
        ...base,
        name: item.text || 'Text',
        text: item.text ?? '',
        fontSize: item.fontSize ?? 24,
        fontWeight: 400,
        fill: item.fill ?? '#1a1a1a',
      })
      doc.nodes[node.id] = node
      page.children.push(node.id)
      continue
    }
    const node = createDesignNode(item.kind, {
      ...base,
      name: item.text || item.kind,
      fill: item.fill ?? '#ffffff',
      stroke: item.stroke ?? '#1a1a1a',
      strokeWidth: item.stroke ? 2 : 0,
      radius: item.radius ?? 0,
    })
    doc.nodes[node.id] = node
    page.children.push(node.id)
    if (item.text) {
      const label = createDesignNode('text', {
        ...base,
        name: item.text,
        text: item.text,
        fontSize: item.fontSize ?? 20,
        fontWeight: 600,
        textAlign: 'center',
        fill: '#1a1a1a',
      })
      doc.nodes[label.id] = label
      page.children.push(label.id)
    }
  }
  doc.provenance = { templateId: 'board-frame', templateVersion: 1 }
  return doc
}
