import { GripHorizontal } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { DashboardQueryResult } from '@/features/dashboard/lib/dashboardQuery'
import type { DataDashboardWidget, DataRecordValue } from '@/types/dataDocument'

const chartColors = ['#5645d4', '#2a9d99', '#dd5b00', '#7b3ff2', '#1aae39', '#ff64c8']

export function DashboardWidgetCard({
  editing,
  result,
  widget,
}: {
  editing: boolean
  result: DashboardQueryResult
  widget: DataDashboardWidget
}) {
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm"
      data-testid={`dashboard-widget-${widget.id}`}
    >
      <header
        className={editing
          ? 'dashboard-drag-handle flex cursor-move items-start gap-2 border-b border-border px-4 py-3'
          : 'flex items-start gap-2 border-b border-border px-4 py-3'}
      >
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{widget.title}</h2>
          {widget.description ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{widget.description}</p>
          ) : null}
        </div>
        {editing ? <GripHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
      </header>
      <div className="min-h-0 flex-1 p-4">
        <DashboardWidgetContent result={result} widget={widget} />
      </div>
    </section>
  )
}

function DashboardWidgetContent({
  result,
  widget,
}: {
  result: DashboardQueryResult
  widget: DataDashboardWidget
}) {
  if (result.kind === 'metric') {
    return (
      <div className="flex h-full flex-col justify-center">
        <div
          className="text-4xl font-semibold tracking-[-0.04em] text-foreground"
          style={{ color: widget.config?.color }}
        >
          {result.value.toLocaleString()}
        </div>
        <div className="mt-2 text-sm text-muted-foreground">
          {widget.config?.value_label || 'items'}
        </div>
      </div>
    )
  }

  if (result.kind === 'table') {
    return (
      <div className="h-full overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[520px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            <tr>
              {result.columns.map((column) => (
                <th key={column.name} className="border-b border-border px-3 py-2 font-medium text-foreground">
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-b-0 hover:bg-muted/40">
                {result.columns.map((column) => (
                  <td key={column.name} className="max-w-64 truncate px-3 py-2 text-muted-foreground">
                    {formatValue(row.values[column.name] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            No matching records
          </div>
        ) : null}
      </div>
    )
  }

  if (result.points.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No data to display
      </div>
    )
  }

  const color = widget.config?.color || '#5645d4'
  if (widget.type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={result.points}
            dataKey="value"
            nameKey="label"
            innerRadius="46%"
            outerRadius="72%"
            paddingAngle={2}
          >
            {result.points.map((point, index) => (
              <Cell key={point.label} fill={chartColors[index % chartColors.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  if (widget.type === 'line') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={result.points} margin={{ top: 8, right: 12, bottom: 8, left: -16 }}>
          <CartesianGrid stroke="#ede9e4" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: '#787671', fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: '#787671', fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2.5} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={result.points} margin={{ top: 8, right: 12, bottom: 16, left: -16 }}>
        <CartesianGrid stroke="#ede9e4" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          interval={0}
          angle={result.points.length > 6 ? -25 : 0}
          textAnchor={result.points.length > 6 ? 'end' : 'middle'}
          height={result.points.length > 6 ? 54 : 30}
          tick={{ fill: '#787671', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis allowDecimals={false} tick={{ fill: '#787671', fontSize: 11 }} tickLine={false} axisLine={false} />
        <Tooltip />
        <Bar dataKey="value" fill={color} radius={[6, 6, 0, 0]} maxBarSize={44} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function formatValue(value: DataRecordValue) {
  if (value == null || value === '') return '—'
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== 'object') return item
      if ('display' in item) return item.display
      if ('name' in item) return item.name
      return ''
    }).join(', ')
  }
  if (typeof value === 'object') return value.name
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}
