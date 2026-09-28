import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'
import {
  AGENT_DESIGN_CAPABILITY,
  AGENT_DESIGN_CONTEXT_LAYER_LIMIT,
  AGENT_DESIGN_PATCH_OPERATION_LIMIT,
  AGENT_DESIGN_SELECTION_LIMIT,
} from '@/types/designAgent'
import { applyDesignCommand } from './designCommands'
import { buildDesignAgentContext, portableDesignPath } from './designAgentContext'
import { createDesign, createDesignNode, type DesignDocument } from './designTypes'

function fixture(): DesignDocument {
  const doc = createDesign('Launch poster', 1080, 1440)
  const nodes = [
    createDesignNode('rectangle', { id: 'bg', transform: [1, 0, 0, 1, 0, 0], width: 1080, height: 1440, fill: '#f4f1ff' }),
    createDesignNode('text', { id: 'headline', text: 'Make something matter', fontSize: 96, transform: [1, 0, 0, 1, 80, 120], width: 920, height: 220 }),
    createDesignNode('text', { id: 'body', text: 'An evening of ideas.', fontSize: 32, transform: [1, 0, 0, 1, 80, 400], width: 920, height: 80 }),
    createDesignNode('text', { id: 'label', text: 'MEETUP', fontSize: 18, transform: [1, 0, 0, 1, 80, 60], width: 300, height: 30 }),
    createDesignNode('ellipse', { id: 'dot', transform: [0, 1, -1, 0, 900, 1200], width: 120, height: 120, locked: true }),
  ]
  for (const node of nodes) {
    doc.nodes[node.id] = node
    doc.pages[0].children.push(node.id)
  }
  return doc
}

describe('buildDesignAgentContext', () => {
  it('describes the artboard and every layer with bounds, style, and a role hint', () => {
    const context = buildDesignAgentContext({
      document: fixture(),
      path: 'designs/launch.kidesign',
      selection: ['headline', 'headline', 'missing'],
      recentOperations: ['Aligned 2 layers', '  '],
    })
    expect(context).not.toBeNull()
    expectMatchesContract(context, 'agent-design', 'context')
    expect(context!.artboard).toEqual({ width: 1080, height: 1440, background: '#ffffff' })
    expect(context!.selected_layer_ids).toEqual(['headline'])
    expect(context!.recent_operations).toEqual(['Aligned 2 layers'])
    const roles = Object.fromEntries(context!.layers.map((layer) => [layer.id, layer.role]))
    expect(roles).toEqual({ bg: 'background', headline: 'headline', body: 'body', label: 'label', dot: 'accent' })
    const headline = context!.layers.find((layer) => layer.id === 'headline')!
    expect(headline.text).toBe('Make something matter')
    expect(headline.style).toMatchObject({ font_family: 'Arial', font_size: 96, font_weight: 700 })
    expect(headline.bounds).toEqual({ x: 80, y: 120, width: 920, height: 220 })
    const dot = context!.layers.find((layer) => layer.id === 'dot')!
    expect(dot.locked).toBe(true)
    expect(dot.rotation).toBe(90)
    expect(dot.style).toMatchObject({ stroke: '#5645d4', stroke_width: 0 })
    expect(dot.style).not.toHaveProperty('radius')
  })

  it('reports group membership and keeps the layer budget with the selection first', () => {
    const grouped = applyDesignCommand(fixture(), { type: 'group', ids: ['headline', 'body'] })
    const context = buildDesignAgentContext({ document: grouped, path: 'launch.kidesign', selection: [] })!
    const groupId = grouped.pages[0].children.find((id) => grouped.nodes[id].type === 'group')!
    expect(context.layers.find((layer) => layer.id === 'headline')!.parent_id).toBe(groupId)
    expect(context.layers.find((layer) => layer.id === groupId)!.role).toBe('group')
    expectMatchesContract(context, 'agent-design', 'context')

    const large = createDesign('Many', 1000, 1000)
    for (let index = 0; index < AGENT_DESIGN_CONTEXT_LAYER_LIMIT + 20; index += 1) {
      const node = createDesignNode('rectangle', { id: `r${index}`, width: 10, height: 10 })
      large.nodes[node.id] = node
      large.pages[0].children.push(node.id)
    }
    const last = `r${AGENT_DESIGN_CONTEXT_LAYER_LIMIT + 19}`
    const bounded = buildDesignAgentContext({ document: large, path: 'many.kidesign', selection: [last] })!
    expect(bounded.layers).toHaveLength(AGENT_DESIGN_CONTEXT_LAYER_LIMIT)
    expect(bounded.layers.at(-1)!.id).toBe(last)
    expectMatchesContract(bounded, 'agent-design', 'context')
  })

  it('rejects host paths and keeps the contract limits in lockstep', () => {
    expect(portableDesignPath('/Users/alice/launch.kidesign')).toBeNull()
    expect(portableDesignPath('C:\\Users\\alice\\launch.kidesign')).toBeNull()
    expect(portableDesignPath('designs/../secrets/launch.kidesign')).toBeNull()
    expect(portableDesignPath('designs\\launch.kidesign')).toBe('designs/launch.kidesign')
    expect(buildDesignAgentContext({ document: fixture(), path: '/tmp/x.kidesign', selection: [] })).toBeNull()

    const schema = JSON.parse(readFileSync(resolve('contracts/runtime/agent-design.schema.json'), 'utf8'))
    expect(schema['x-runtime-capability']).toBe(AGENT_DESIGN_CAPABILITY)
    expect(schema.$defs.context.properties.layers.maxItems).toBe(AGENT_DESIGN_CONTEXT_LAYER_LIMIT)
    expect(schema.$defs.context.properties.selected_layer_ids.maxItems).toBe(AGENT_DESIGN_SELECTION_LIMIT)
    expect(schema.$defs.patch.properties.operations.maxItems).toBe(AGENT_DESIGN_PATCH_OPERATION_LIMIT)
  })
})
