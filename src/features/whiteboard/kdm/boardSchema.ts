import { parseSchema, type Schema } from '@/lib/kdm'

const optionalString = { kind: 'string', optional: true } as const
const optionalNumber = { kind: 'number', optional: true } as const
const optionalJson = { kind: 'json', optional: true } as const

export const BOARD_KIT = 'kit.board'

export const boardSchema: Schema = parseSchema({
  kdm: 1,
  kit: BOARD_KIT,
  schemaVersion: 1,
  root: 'Board',
  types: {
    Board: { fields: { title: { kind: 'string' }, pages: { kind: 'list', of: 'Page' } } },
    Page: { fields: { name: { kind: 'string' }, elements: { kind: 'list', of: 'Element' } } },
    Element: {
      fields: {
        kind: { kind: 'enum', values: ['rectangle', 'text', 'stroke', 'connector', 'image'] },
        x: optionalNumber, y: optionalNumber, width: optionalNumber, height: optionalNumber, rotation: optionalNumber,
        locked: { kind: 'boolean', optional: true },
        parent: { kind: 'ref', of: 'Element', optional: true },
        shapeType: optionalString, shapeStyle: optionalString,
        strokeColor: optionalString, fillColor: optionalString, fillStyle: optionalString, dashStyle: optionalString,
        opacity: optionalNumber, strokeSize: optionalString,
        text: { kind: 'text' },
        fontSize: optionalNumber,
        points: optionalJson,
        start: optionalJson, end: optionalJson,
        connectorType: optionalString, startArrowhead: optionalString, endArrowhead: optionalString,
        connectorRole: optionalString, mindMapBranchAxis: optionalString,
        startBinding: optionalJson, endBinding: optionalJson,
        image: optionalJson,
        mindMapBranchSide: optionalString, mindMapDirection: optionalString,
        mindMapCollapsed: { kind: 'boolean', optional: true },
        sourceRefIds: optionalJson,
      },
    },
  },
})

/** Element style keys stored as their own fields, so concurrent style edits merge. */
export const BOARD_STYLE_FIELDS = ['strokeColor', 'fillColor', 'opacity', 'fillStyle', 'dashStyle', 'strokeSize'] as const
