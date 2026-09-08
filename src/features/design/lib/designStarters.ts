import {
  createDesign,
  createDesignNode,
  type DesignDocument,
  type DesignNode,
} from './designTypes'
export type DesignStarter = 'editorial' | 'event' | 'sale' | 'quote'
export const designStarters: DesignStarter[] = [
  'editorial',
  'event',
  'sale',
  'quote',
]
/** Original geometric layouts, with no external templates, fonts, or assets. */
export function createDesignStarter(
  kind: DesignStarter,
  copy: { heading: string; body: string; label: string },
): DesignDocument {
  const doc = createDesign(),
    page = doc.pages[0]
  const add = (type: DesignNode['type'], props: Partial<DesignNode>) => {
    const n = createDesignNode(type, props)
    doc.nodes[n.id] = n
    page.children.push(n.id)
  }
  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    width = 880,
    fill = '#1a1a1a',
    family: DesignNode['fontFamily'] = 'Arial',
  ) =>
    add('text', {
      name: value,
      text: value,
      transform: [1, 0, 0, 1, x, y],
      fontSize: size,
      width,
      height: size * 4,
      lineHeight: 1.04,
      fill,
      fontFamily: family,
    })
  if (kind === 'editorial') {
    page.background = '#f8f5e8'
    add('rectangle', {
      transform: [1, 0, 0, 1, 80, 80],
      width: 12,
      height: 1280,
      fill: '#5645d4',
    })
    text(copy.label, 140, 90, 24)
    text(copy.heading, 140, 285, 132, 830, '#1a1a1a', 'Georgia')
    add('ellipse', {
      transform: [1, 0, 0, 1, 655, 880],
      width: 320,
      height: 320,
      fill: '#dd5b00',
    })
    text(copy.body, 140, 1100, 32, 440)
  } else if (kind === 'event') {
    page.background = '#e6e0f5'
    add('ellipse', {
      transform: [1, 0, 0, 1, 420, -120],
      width: 920,
      height: 920,
      fill: '#5645d4',
    })
    text(copy.label, 80, 85, 24)
    text(copy.heading, 80, 630, 140)
    text(copy.body, 80, 1170, 34)
  } else if (kind === 'sale') {
    page.background = '#f9e79f'
    add('rectangle', {
      transform: [1, 0, 0, 1, 60, 60],
      width: 960,
      height: 1320,
      fill: 'transparent',
      stroke: '#1a1a1a',
      strokeWidth: 3,
    })
    text(copy.label, 110, 125, 28)
    text(copy.heading, 110, 390, 152, 860)
    add('rectangle', {
      transform: [1, 0, 0, 1, 110, 1150],
      width: 860,
      height: 120,
      fill: '#1a1a1a',
      radius: 10,
    })
    text(copy.body, 145, 1180, 38, 790, '#ffffff')
  } else {
    page.background = '#d9f3e1'
    text('“', 70, 140, 320, 900, '#2a9d99', 'Georgia')
    text(copy.heading, 110, 420, 100, 860, '#1a1a1a', 'Georgia')
    text(copy.body, 110, 1170, 32)
    text(copy.label, 110, 100, 24)
  }
  doc.provenance = { templateId: `kition-starter-${kind}`, templateVersion: 1 }
  return doc
}
