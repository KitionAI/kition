// A single product story: a request, visible agent work, and reviewable file changes.
// Camera direction studied from Linear's public Dashboards launch film; no borrowed assets.
export function agentFilm(execute) {
  const width = 1920; const height = 1080; const duration = 12; const frameRate = 30
  execute('comp.settings', { name: 'Kition - From intent to action', width, height, duration, frameRate, background: '#070f24' })
  const set = (layer, path, value) => execute('prop.set', { layer, path, value })
  const key = (layer, path, f, value) => execute('prop.addKey', { layer, path, time: f / frameRate, value })
  const clamp = n => Math.max(0, Math.min(1, n))
  const smooth = n => { const x = clamp(n); return x * x * (3 - 2 * x) }
  const ramp = (f, a, b) => smooth((f - a) / (b - a))
  const mix = (a, b, p) => Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * p) : a + (b - a) * p
  function animate(layer, path, fn, start = 0, end = 360) {
    for (let f = start; f <= end; f += 2) key(layer, path, f, fn(f))
  }
  function image(name, file) {
    const result = execute('file.import', { paths: [`media/${file}`], sequence: false, addToComp: true })
    if (result.errors?.length) throw new Error(JSON.stringify(result.errors))
    execute('layer.rename', { layer: execute('comp.info', {}).layers[0].id, name })
    return name
  }
  function text(name, copy, size, position, fill = '#ffffff', justify = 'left') {
    execute('layer.newText', { name, text: copy, size, font: 'Inter', style: 'SemiBold', fill, justify, position, leading: size * 1.08 })
    return name
  }
  function shape(name, size, fill, position, radius = 0) {
    execute('layer.newShape', { name, kind: 'rounded', size, fill, position })
    set(name, 'contents/group/contents/rect/roundness', radius)
    return name
  }
  const glow = image('stage.light', 'stage-light.svg')
  set(glow, 'transform/position', [960, 540, 0])
  animate(glow, 'transform/opacity', f => 65 + 30 * ramp(f, 210, 300))

  execute('layer.newNull', { name: 'camera.product-rig' })
  const rig = 'camera.product-rig'
  set(rig, 'transform/position', [0, 0, 0]); set(rig, 'transform/anchor', [0, 0, 0])
  execute('layer.setSwitch', { layers: [rig], switch: 'threeD', value: true })
  function attach(layer, depth = 0) {
    execute('layer.setSwitch', { layers: [layer], switch: 'threeD', value: true })
    execute('layer.setParent', { layers: [layer], parent: rig })
    if (depth) {
      const p = execute('prop.get', { layer, path: 'transform/position' }).value
      set(layer, 'transform/position', [p[0], p[1], depth])
    }
  }
  const frame = shape('product.frame', [1940, 1088], '#373b49', [960, 534], 14); attach(frame, 4)
  const product = image('product.real-review', 'agent-review.webp')
  set(product, 'transform/position', [960, 534, 0]); attach(product)

  // Reveal the task trace from the actual screenshot, keeping its wording and geometry.
  for (let i = 0; i < 8; i++) {
    const cover = shape(`trace.reveal-${i}`, [607, 34], '#1b1d22', [1605, 120 + i * 35.3])
    attach(cover, -1)
    animate(cover, 'transform/opacity', f => 100 * (1 - ramp(f, 54 + i * 5, 59 + i * 5)), 0, 104)
    execute('layer.timing', { layers: [cover], in: 0, out: 104 / 30 })
  }
  const highlight = shape('review.changed-line', [1158, 35], '#b4f2ce', [655, 405], 0)
  attach(highlight, -2)
  animate(highlight, 'transform/opacity', f => 17 * ramp(f, 152, 170) * (1 - ramp(f, 198, 218)))
  animate(highlight, 'transform/scale', f => [100 * ramp(f, 148, 176), 100, 100])

  // Source-space focus points travel from prompt to task trace, then to the file diff.
  const shots = [
    { f: 0, focus: [1700, 60, 0], position: [1040, 420, 0], scale: 400, rx: 8, ry: -19, rz: -5 },
    { f: 45, focus: [1700, 75, 0], position: [1040, 420, 0], scale: 370, rx: 6, ry: -16, rz: -4 },
    { f: 94, focus: [1595, 240, 0], position: [1040, 470, 0], scale: 270, rx: 4, ry: -12, rz: -2 },
    { f: 130, focus: [1570, 360, 0], position: [1040, 470, 0], scale: 260, rx: 2, ry: -10, rz: -2 },
    { f: 166, focus: [650, 409, 0], position: [960, 500, 0], scale: 200, rx: -7, ry: 8, rz: 2 },
    { f: 214, focus: [650, 440, 0], position: [960, 500, 0], scale: 200, rx: -4, ry: 6, rz: 1 },
    { f: 250, focus: [1120, 350, 0], position: [960, 500, 0], scale: 300, rx: -3, ry: 6, rz: 1 },
    { f: 270, focus: [1120, 350, 0], position: [960, 500, 0], scale: 290, rx: -2, ry: 4, rz: 0 },
    { f: 318, focus: [960, 534, 0], position: [960, 760, 0], scale: 68, rx: 0, ry: 0, rz: 0 },
    { f: 360, focus: [960, 534, 0], position: [960, 760, 0], scale: 68, rx: 0, ry: 0, rz: 0 },
  ]
  function camera(f, field) {
    for (let i = 1; i < shots.length; i++) {
      if (f <= shots[i].f) return mix(shots[i - 1][field], shots[i][field], ramp(f, shots[i - 1].f, shots[i].f))
    }
    return shots.at(-1)[field]
  }
  animate(rig, 'transform/anchor', f => camera(f, 'focus'))
  animate(rig, 'transform/position', f => camera(f, 'position'))
  animate(rig, 'transform/scale', f => { const s = camera(f, 'scale'); return [s, s, s] })
  for (const [axis, field] of [['rotationX', 'rx'], ['rotationY', 'ry'], ['rotation', 'rz']]) animate(rig, `transform/${axis}`, f => camera(f, field))
  animate(rig, 'transform/opacity', f => 100 * ramp(f, 0, 14))
  execute('layer.newCamera', { preset: '35mm' })

  const shade = image('stage.caption-shade', 'caption-shade.svg'); set(shade, 'transform/position', [960, 540, 0])
  animate(shade, 'transform/opacity', f => 100 * (1 - ramp(f, 272, 292)))
  const captions = [
    { copy: 'Start with what you need.', from: 4, to: 75 },
    { copy: 'Let your agent do the work.', from: 78, to: 141 },
    { copy: 'Review every change.', from: 148, to: 238 },
    { copy: 'Your files. Your control.', from: 240, to: 288 },
  ]
  for (const [i, cue] of captions.entries()) {
    const name = text(`story.caption-${i}`, cue.copy, 57, [110, 962])
    animate(name, 'transform/position', f => [110, 962 + 24 * (1 - ramp(f, cue.from, cue.from + 10)), 0])
    animate(name, 'transform/opacity', f => 100 * ramp(f, cue.from, cue.from + 10) * (1 - ramp(f, cue.to - 8, cue.to)))
  }
  const label = text('brand.opening-label', 'KITION  /  YOUR AI WORKSPACE', 32, [110, 85], '#d6b6f6')
  animate(label, 'transform/opacity', f => 100 * ramp(f, 4, 22) * (1 - ramp(f, 44, 60)))
  execute('layer.timing', { layers: [label], in: 0, out: 2.1 })
  const symbol = image('brand.symbol', 'symbol.svg')
  set(symbol, 'transform/position', [773, 250, 0]); set(symbol, 'transform/scale', [42, 42, 100])
  animate(symbol, 'transform/opacity', f => 100 * ramp(f, 290, 312))
  const wordmark = text('brand.wordmark', 'Kition', 112, [852, 288])
  animate(wordmark, 'transform/opacity', f => 100 * ramp(f, 294, 316))
  const close = text('brand.promise', 'From intent to action.', 42, [960, 378], '#ffffff', 'center')
  animate(close, 'transform/opacity', f => 100 * ramp(f, 302, 322))
  const url = text('brand.url', 'kition.ai', 32, [960, 1030], '#d6b6f6', 'center')
  animate(url, 'transform/opacity', f => 100 * ramp(f, 312, 332))
  return { title: 'Kition - From intent to action', width, height, frameRate, duration, scenes: [{ id: 'agent-story', start: 0, end: duration }], checkpoints: [1, 3.2, 5.7, 7, 9, 11.2], reference: { url: 'https://linear.app/changelog/2025-07-24-dashboards', method: 'Product macro framing, oblique spatial travel, detail-to-overview reveal', adaptation: 'One genuine Kition agent task and its file diff; no Linear media or design assets' } }
}
