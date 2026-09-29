import { memo, type ReactNode } from 'react'
import type { DesignAsset, DesignNode } from '../lib/designTypes'
import { designTextLayout } from '../lib/designTextLayout'

/** Unchanged layers retain their SVG subtree while a neighboring layer moves. */
export const DesignArtworkLayer = memo(function DesignArtworkLayer({
  node: n, asset, url, prefix, editingId, onImageError, children,
}: {
  node: DesignNode
  asset?: DesignAsset
  url?: string
  prefix: string
  editingId?: string | null
  onImageError?: (id: string) => void
  children?: ReactNode
}) {
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
      if (!asset) return null
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
  const clipId = `${prefix}-clip-${n.id}`
  return (
    <g data-design-node={n.id} transform={`matrix(${n.transform.join(' ')})`} opacity={n.opacity}>
      {n.type === 'group' ? children : (
        <>
          <defs>
            <clipPath id={clipId}>
              <rect width={n.width} height={n.height} rx={n.type === 'image' ? n.radius : 0} />
            </clipPath>
          </defs>
          {body(n, clipId)}
        </>
      )}
    </g>
  )
})
