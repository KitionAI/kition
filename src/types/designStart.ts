/** A Board frame captured for the design start-from adapter: positions relative to the frame. */
type BoardFrameItem = {
  kind: 'rectangle' | 'ellipse' | 'text' | 'image'
  x: number
  y: number
  width: number
  height: number
  text?: string
  fontSize?: number
  fill?: string
  stroke?: string
  radius?: number
  workspacePath?: string
}

export type BoardFrameSnapshot = {
  title: string
  width: number
  height: number
  background?: string
  items: BoardFrameItem[]
}
