/** SVG/Canvas matrix: [a, b, c, d, e, f], applied to parent-local coordinates. */
export type Matrix = [number, number, number, number, number, number]
export type Bounds = { x: number; y: number; width: number; height: number }
export type DesignNode = {
  id: string
  name: string
  type: 'text' | 'image' | 'rectangle' | 'ellipse' | 'line' | 'group'
  transform: Matrix
  width: number
  height: number
  opacity: number
  visible: boolean
  locked: boolean
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
  text: string
  fontFamily: 'Arial' | 'Georgia' | 'Courier New'
  fontSize: number
  fontWeight: number
  textAlign: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
  assetId?: string
  crop?: Bounds
  children: string[]
}
export type DesignAsset = {
  id: string
  path: string
  mimeType: string
  width: number
  height: number
}
export type DesignPage = {
  id: string
  width: number
  height: number
  background: string
  children: string[]
}
export type DesignDocument = {
  format: 'kition-design'
  version: 1
  id: string
  title: string
  revision: number
  pages: [DesignPage]
  nodes: Record<string, DesignNode>
  assets: Record<string, DesignAsset>
  provenance?: {
    templateId?: string
    templateVersion?: number
    imagePath?: string
  }
}
export const DESIGN_EXTENSION = '.kidesign'
export const DESIGN_MAX_NODES = 2000
export const designId = () => crypto.randomUUID()
export function createDesign(
  title = 'Untitled design',
  width = 1080,
  height = 1440,
): DesignDocument {
  return {
    format: 'kition-design',
    version: 1,
    id: designId(),
    title,
    revision: 0,
    pages: [
      { id: designId(), width, height, background: '#ffffff', children: [] },
    ],
    nodes: {},
    assets: {},
  }
}
export function createDesignNode(
  type: DesignNode['type'],
  overrides: Partial<DesignNode> = {},
): DesignNode {
  return {
    id: designId(),
    type,
    name: type,
    transform: [1, 0, 0, 1, 100, 100],
    width: type === 'text' ? 680 : 320,
    height: type === 'text' ? 240 : type === 'line' ? 1 : 240,
    opacity: 1,
    visible: true,
    locked: false,
    fill: type === 'text' ? '#1a1a1a' : '#5645d4',
    stroke: '#5645d4',
    strokeWidth: type === 'line' ? 6 : 0,
    radius: 0,
    text: '',
    fontFamily: 'Arial',
    fontSize: 80,
    fontWeight: 700,
    textAlign: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    children: [],
    ...overrides,
  }
}
