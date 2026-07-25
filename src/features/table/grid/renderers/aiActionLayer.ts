export const AI_ACTION_BUTTON_SIZE = 18
const PADDING = 4

export interface CellRect {
  x: number
  y: number
  width: number
  height: number
}

export function getAIActionZone(rect: CellRect): CellRect {
  return {
    x: rect.x + rect.width - AI_ACTION_BUTTON_SIZE - PADDING,
    y: rect.y + PADDING,
    width: AI_ACTION_BUTTON_SIZE,
    height: AI_ACTION_BUTTON_SIZE,
  }
}

export function isInAIActionZone(rect: CellRect, pointerX: number, pointerY: number): boolean {
  const zone = getAIActionZone(rect)
  return pointerX >= zone.x && pointerX <= zone.x + zone.width
    && pointerY >= zone.y && pointerY <= zone.y + zone.height
}

export function drawAIActionButton(ctx: CanvasRenderingContext2D, rect: CellRect, hovered: boolean) {
  const zone = getAIActionZone(rect)
  ctx.save()
  ctx.fillStyle = hovered ? 'rgba(59, 130, 246, 0.15)' : 'rgba(0, 0, 0, 0.04)'
  ctx.beginPath()
  ctx.roundRect(zone.x, zone.y, zone.width, zone.height, 4)
  ctx.fill()
  ctx.strokeStyle = hovered ? 'rgb(59, 130, 246)' : 'rgb(120, 120, 120)'
  ctx.lineWidth = 1.4
  const cx = zone.x + zone.width / 2
  const cy = zone.y + zone.height / 2
  const radius = (zone.width - 8) / 2
  ctx.beginPath()
  ctx.arc(cx, cy, radius, Math.PI * 0.2, Math.PI * 1.8)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx + radius * Math.cos(Math.PI * 1.8), cy + radius * Math.sin(Math.PI * 1.8))
  ctx.lineTo(cx + radius * Math.cos(Math.PI * 1.8) + 3, cy + radius * Math.sin(Math.PI * 1.8) - 1)
  ctx.lineTo(cx + radius * Math.cos(Math.PI * 1.8) + 1, cy + radius * Math.sin(Math.PI * 1.8) + 3)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export function drawAIPendingOverlay(ctx: CanvasRenderingContext2D, rect: CellRect, frame: number) {
  ctx.save()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)'
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const radius = Math.min(10, Math.min(rect.width, rect.height) / 3)
  const angle = (frame * Math.PI) / 30
  ctx.translate(cx, cy)
  ctx.rotate(angle)
  ctx.strokeStyle = 'rgb(59, 130, 246)'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  for (let i = 0; i < 8; i += 1) {
    ctx.globalAlpha = (i + 1) / 8
    ctx.beginPath()
    ctx.moveTo(0, -radius)
    ctx.lineTo(0, -radius * 0.55)
    ctx.stroke()
    ctx.rotate(Math.PI / 4)
  }
  ctx.restore()
}
