// An original, editable production fixture. All edits use public Effect commands.
// Landscape uses a 960 x 540 design space; portrait is recomposed in 540 x 960.
export function productLaunch({ width = 1920, height = 1080, frameRate = 24 } = {}) {
  const portrait = width / height === 9 / 16
  if (!portrait && width / height !== 16 / 9) throw new Error('Supported delivery ratios are 16:9 and 9:16')
  const scale = width / (portrait ? 540 : 960)
  const cx = portrait ? 270 : 480
  const scenes = [
    { id: 'opening', start: 0, end: 3, purpose: 'Introduce the product and its central promise', steps: [] },
    { id: 'workspace', start: 3, end: 6, purpose: 'Bring fragmented work into one place', steps: [] },
    { id: 'create', start: 6, end: 9, purpose: 'Show the progression from an idea to an editable result', steps: [] },
    { id: 'closing', start: 9, end: 12, purpose: 'Hold the brand and call to action', steps: [] },
  ]
  const layers = []
  const color = { purple: '#5645d4', ink: '#1a1a1a', muted: '#787671', light: '#f6f5f4', lavender: '#e6e0f5', mint: '#d9f3e1', peach: '#ffe8d4' }
  const push = (scene, command, params) => scene.steps.push({ command, params })
  function animate(scene, name, x, y, delay = 0) {
    const start = scene.start + delay
    layers.push({ name, scene: scene.id, in: start, out: scene.end })
    push(scene, 'layer.timing', { layers: [name], in: start, out: scene.end })
    for (const [time, value] of [[start, 0], [start + 0.35, 100], [scene.end - 0.3, 100], [scene.end, scene.id === 'closing' ? 100 : 0]]) {
      push(scene, 'prop.addKey', { layer: name, path: 'transform/opacity', time, value })
    }
    for (const [time, value] of [[start, [x * scale, (y + 20) * scale, 0]], [start + 0.6, [x * scale, y * scale, 0]]]) {
      push(scene, 'prop.addKey', { layer: name, path: 'transform/position', time, value })
    }
    push(scene, 'prop.select', { layer: name, path: 'transform/position' })
    push(scene, 'keys.easyEase', {})
  }
  function shape(scene, suffix, x, y, w, h, fill, { delay = 0, kind = 'rounded', radius = 12 } = {}) {
    const name = `promo.${scene.id}.${suffix}`
    push(scene, 'layer.newShape', { name, kind, size: [w * scale, h * scale], position: [x * scale, y * scale], fill })
    if (kind === 'rounded') push(scene, 'prop.set', { layer: name, path: 'contents/group/contents/rect/roundness', value: radius * scale })
    animate(scene, name, x, y, delay)
    return name
  }
  function text(scene, suffix, value, x, y, size, { fill = color.ink, delay = 0, style = 'SemiBold', justify = 'center' } = {}) {
    const name = `promo.${scene.id}.${suffix}`
    push(scene, 'layer.newText', { name, text: value, font: 'Inter', style, size: size * scale, fill, justify, position: [x * scale, y * scale] })
    animate(scene, name, x, y, delay)
    return name
  }

  const opening = scenes[0]
  shape(opening, 'accent', cx, portrait ? 245 : 125, 56, 6, color.purple, { kind: 'rect' })
  text(opening, 'eyebrow', 'MEET KITION', cx, portrait ? 296 : 166, 17, { fill: color.purple, delay: 0.1 })
  text(opening, 'headline', portrait ? 'Make room\nfor ideas.' : 'Make room for ideas.', cx, portrait ? 410 : 263, portrait ? 58 : 62, { delay: 0.18 })
  text(opening, 'subhead', portrait ? 'One workspace.\nMore possibilities.' : 'One workspace. More possibilities.', cx, portrait ? 565 : 324, 23, { style: 'Regular', fill: color.muted, delay: 0.3 })
  shape(opening, 'line', cx, portrait ? 680 : 390, 240, 2, color.lavender, { delay: 0.4, kind: 'rect' })

  const workspace = scenes[1]
  text(workspace, 'eyebrow', 'LESS SWITCHING. MORE CREATING.', cx, portrait ? 130 : 105, 16, { fill: color.purple })
  text(workspace, 'headline', portrait ? 'Bring your work\ntogether.' : 'Bring your work together.', cx, portrait ? 200 : 169, 42, { delay: 0.08 })
  for (const [index, [label, detail, fill]] of [
    ['Think', 'Notes & ideas', color.lavender], ['Make', 'Design & motion', color.peach], ['Share', 'Work in context', color.mint],
  ].entries()) {
    const x = portrait ? cx : 210 + index * 270
    const y = portrait ? 376 + index * 170 : 320
    const delay = 0.15 + index * 0.12
    shape(workspace, `card-${index}`, x, y, portrait ? 410 : 238, portrait ? 148 : 202, fill, { delay })
    text(workspace, `number-${index}`, `0${index + 1}`, portrait ? x - 160 : x, portrait ? y + 5 : 277, 16, { fill: color.muted, delay })
    text(workspace, `label-${index}`, label, portrait ? x + 15 : x, portrait ? y - 5 : 331, 34, { delay: delay + 0.06 })
    text(workspace, `detail-${index}`, detail, portrait ? x + 15 : x, portrait ? y + 34 : 375, 17, { style: 'Regular', fill: color.muted, delay: delay + 0.12 })
  }

  const create = scenes[2]
  text(create, 'eyebrow', 'KEEP THE CREATIVE MOMENTUM', cx, portrait ? 130 : 110, 16, { fill: color.purple })
  text(create, 'headline', portrait ? 'From a thought\nto a thing.' : 'From a thought to a thing.', cx, portrait ? 200 : 179, 42, { delay: 0.08 })
  shape(create, 'rail', portrait ? 130 : 480, portrait ? 556 : 300, portrait ? 3 : 560, portrait ? 340 : 3, color.lavender, { delay: 0.1, kind: 'rect' })
  for (const [index, label] of ['Describe', 'Refine', 'Create'].entries()) {
    const x = portrait ? 130 : 240 + index * 240
    const y = portrait ? 386 + index * 170 : 300
    const delay = 0.2 + index * 0.25
    shape(create, `step-${index}`, x, y, 58, 58, color.purple, { delay, kind: 'ellipse' })
    text(create, `step-number-${index}`, String(index + 1), x, y + 9, 22, { fill: '#ffffff', delay: delay + 0.05 })
    text(create, `step-label-${index}`, label, portrait ? 320 : x, portrait ? y + 9 : 376, 25, { delay: delay + 0.1 })
  }

  const closing = scenes[3]
  text(closing, 'wordmark', 'Kition', cx, portrait ? 366 : 219, 82, { fill: color.purple })
  text(closing, 'headline', portrait ? 'Your next idea\nstarts here.' : 'Your next idea starts here.', cx, portrait ? 444 : 280, 27, { delay: 0.15 })
  shape(closing, 'cta', cx, portrait ? 585 : 365, 194, 54, color.purple, { delay: 0.25, radius: 8 })
  text(closing, 'cta-label', 'Explore Kition', cx, portrait ? 593 : 373, 18, { fill: '#ffffff', delay: 0.3 })
  text(closing, 'url', 'kition.ai', cx, portrait ? 730 : 448, 17, { fill: color.muted, style: 'Regular', delay: 0.4 })

  const setup = [{ command: 'comp.settings', params: { name: 'Kition product launch', width, height, duration: 12, frameRate, background: '#ffffff' } }]
  return { orientation: portrait ? 'portrait' : 'landscape', title: 'Kition product launch', width, height, frameRate, duration: 12, setup, scenes, layers, checkpoints: [1.5, 4.5, 7.5, 10.5, (12 * frameRate - 1) / frameRate],
    transitionTimes: [3, 6, 9].flatMap(time => [time - 4 / frameRate, time, time + 6 / frameRate, time + Math.ceil(1.4 * frameRate) / frameRate]),
  }
}

/** Payloads for either agent's effect_run MCP tool. Create/inspect an empty file first. */
export function toolCalls(recipe, documentPath) {
  const calls = []
  for (const [scene, steps] of [['setup', recipe.setup], ...recipe.scenes.map(scene => [scene.id, scene.steps])]) {
    for (let offset = 0; offset < steps.length; offset += 50) {
      calls.push({ scene, tool: 'effect_run', arguments: { path: documentPath, steps: steps.slice(offset, offset + 50), save: true } })
    }
  }
  return calls
}
