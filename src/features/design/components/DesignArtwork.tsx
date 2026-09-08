import type { DesignDocument, DesignNode } from '../lib/designTypes'
import { designTextLayout } from '../lib/designTextLayout'
export function DesignArtwork({
  document: doc,
  images,
  prefix = 'design',
  editingId,
  onImageError,
}: {
  document: DesignDocument
  images: Record<string, string>
  prefix?: string
  editingId?: string | null
  onImageError?: (id: string) => void
}) {
  function render(id: string) {
    const n = doc.nodes[id]
    if (!n || !n.visible) return null
    const clipId = `${prefix}-clip-${id}`
    return (
      <g
        key={id}
        data-design-node={id}
        transform={`matrix(${n.transform.join(' ')})`}
        opacity={n.opacity}
      >
        {n.type === 'group' ? (
          n.children.map(render)
        ) : (
          <>
            <defs>
              <clipPath id={clipId}>
                <rect
                  width={n.width}
                  height={n.height}
                  rx={n.type === 'image' ? n.radius : 0}
                />
              </clipPath>
            </defs>
            {body(n, clipId)}
          </>
        )}
      </g>
    )
  }
  function body(n: DesignNode, clipId: string) {
    const common = {
      fill: n.fill,
      stroke: n.stroke,
      strokeWidth: n.strokeWidth,
    }
    if (n.type === 'rectangle')
      return (
        <rect width={n.width} height={n.height} rx={n.radius} {...common} />
      )
    if (n.type === 'ellipse')
      return (
        <ellipse
          cx={n.width / 2}
          cy={n.height / 2}
          rx={n.width / 2}
          ry={n.height / 2}
          {...common}
        />
      )
    if (n.type === 'line')
      return (
        <line
          x1={0}
          y1={n.height / 2}
          x2={n.width}
          y2={n.height / 2}
          stroke={n.stroke}
          strokeWidth={n.strokeWidth}
          strokeLinecap="round"
        />
      )
    if (n.type === 'text')
      return (
        <g clipPath={`url(#${clipId})`} opacity={editingId === n.id ? 0 : 1}>
          <rect width={n.width} height={n.height} fill="transparent" />
          {designTextLayout(n).map((line, i) => (
            <text
              key={i}
              x={line.x}
              y={line.y}
              fontFamily={n.fontFamily}
              fontSize={n.fontSize}
              fontWeight={n.fontWeight}
              letterSpacing={n.letterSpacing}
              fill={n.fill}
              textAnchor={
                n.textAlign === 'center'
                  ? 'middle'
                  : n.textAlign === 'right'
                    ? 'end'
                    : 'start'
              }
              xmlSpace="preserve"
            >
              {line.text}
            </text>
          ))}
        </g>
      )
    if (n.type === 'image' && n.crop) {
      const asset = doc.assets[n.assetId!],
        url = images[n.assetId!]
      if (!url)
        return (
          <g>
            <rect width={n.width} height={n.height} fill="#f0eeec" />
            <path
              d={`M0 0L${n.width} ${n.height}M${n.width} 0L0 ${n.height}`}
              stroke="#a4a097"
              strokeWidth={2}
            />
          </g>
        )
      return (
        <g clipPath={`url(#${clipId})`}>
          <image
            href={url}
            x={(-n.crop.x * n.width) / n.crop.width}
            y={(-n.crop.y * n.height) / n.crop.height}
            width={(asset.width * n.width) / n.crop.width}
            height={(asset.height * n.height) / n.crop.height}
            preserveAspectRatio="none"
            onError={() => onImageError?.(asset.id)}
          />
        </g>
      )
    }
    return null
  }
  const page = doc.pages[0]
  return (
    <>
      <rect width={page.width} height={page.height} fill={page.background} />
      {page.children.map(render)}
    </>
  )
}
