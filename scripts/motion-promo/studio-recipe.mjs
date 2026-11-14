// One continuous native 3D scene. The four work objects become the canonical mark.
export function studioFilm(run) {
  const width = 1280, height = 720, fps = 24, end = 480
  const clamp = x => Math.max(0, Math.min(1, x))
  const ease = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10) }
  const ramp = (f, a, b) => ease((f - a) / (b - a))
  const mix = (a, b, t) => Array.isArray(a) ? a.map((v, i) => mix(v, b[i], t)) : a + (b - a) * t
  const curve = (f, keys) => {
    for (let i = 1; i < keys.length; i++) if (f <= keys[i][0]) return mix(keys[i - 1][1], keys[i][1], ramp(f, keys[i - 1][0], keys[i][0]))
    return keys.at(-1)[1]
  }
  const set = (layer, path, value) => run('prop.set', { layer, path, value })
  const track = (layer, path, fn, start = 0, stop = end, step = 3) => {
    for (let f = start; f <= stop; f += step) run('prop.addKey', { layer, path, time: f / fps, value: fn(f) })
    if ((stop - start) % step) run('prop.addKey', { layer, path, time: stop / fps, value: fn(stop) })
  }
  const lifetime = (layer, start, stop = end) => run('layer.timing', { layers: [layer], in: start / fps, out: stop / fps })
  run('comp.settings', { name: 'Kition - One brief, a whole team', width, height, duration: 20, frameRate: fps, background: '#f8f7fb', renderer: 'advanced3d' })
  function image(name, file) {
    const imported = run('file.import', { paths: [`media/${file}`], addToComp: true })
    if (imported.errors?.length) throw new Error(JSON.stringify(imported.errors))
    run('layer.rename', { layer: run('comp.info').layers[0].id, name })
    return name
  }
  image('stage.soft-light', 'stage.svg')
  function attach(name, parent, position) {
    run('layer.setSwitch', { layers: [name], switch: 'threeD', value: true })
    if (parent) run('layer.setParent', { layers: [name], parent })
    set(name, 'transform/position', position)
  }
  function rig(name) {
    run('layer.newNull', { name })
    set(name, 'transform/anchor', [0, 0, 0]); attach(name, null, [0, 0, 0])
    return name
  }
  function shape(name, parent, size, position, fill, round = 12, depth = 0) {
    run('layer.newShape', { name, kind: 'rounded', size, position: [0, 0], fill })
    attach(name, parent, position)
    set(name, 'contents/group/contents/rect/roundness', round)
    if (depth) {
      set(name, 'geometryOptions/extrusionDepth', depth)
      set(name, 'geometryOptions/bevelStyle', 1)
      set(name, 'geometryOptions/bevelDepth', Math.min(5, depth / 3))
      run('material.set', { layers: [name], ambient: 110, diffuse: 35, specularIntensity: 12, specularShininess: 38 })
    } else run('material.set', { layers: [name], acceptsLights: false })
    return name
  }
  function text(name, copy, parent, size, position, fill = '#282333', weight = 'Medium') {
    run('layer.newText', { name, text: copy, font: 'Inter', style: weight, size, fill, position: [0, 0], justify: 'left' })
    if (parent) { attach(name, parent, position); run('material.set', { layers: [name], acceptsLights: false }) }
    else set(name, 'transform/position', position)
    return name
  }
  const contentFade = f => 100 * (1 - ramp(f, 348, 360))
  const hideContent = name => track(name, 'transform/opacity', contentFade, 345, 363)
  const purple = '#5645d4'
  const color = hex => [...hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255), 1]
  function morphBody(name, originalSize, finalSize, originalColor) {
    track(name, 'contents/group/contents/rect/size', f => mix(originalSize, finalSize, ramp(f, 354, 378)), 351, 381)
    track(name, 'contents/group/contents/rect/roundness', f => mix(12, 17.6, ramp(f, 354, 378)), 351, 381)
    track(name, 'contents/group/contents/fill/color', f => mix(color(originalColor), color(purple), ramp(f, 357, 378)), 354, 381)
    track(name, 'geometryOptions/extrusionDepth', f => mix(18, 0, ramp(f, 366, 405)), 363, 408)
    track(name, 'geometryOptions/bevelDepth', f => 5 * (1 - ramp(f, 366, 405)), 363, 408)
    track(name, 'materialOptions/ambient', f => mix(110, 100 / .72, ramp(f, 366, 405)), 363, 408)
    track(name, 'materialOptions/diffuse', f => 35 * (1 - ramp(f, 366, 405)), 363, 408)
    track(name, 'materialOptions/specularIntensity', f => 12 * (1 - ramp(f, 366, 405)), 363, 408)
  }

  // Three original satin ribbons carry the workstreams behind the product objects.
  for (let i = 0; i < 3; i++) {
    const name = `stream.${i}`
    run('layer.newModel', { name, path: `media/ribbon-${i}.glb`, position: [640, 440, 480 + i * 90] })
    set(name, 'geometryOptions/unitScale', 1)
    lifetime(name, 48, 390)
    track(name, 'transform/position', f => [640 + 60 * Math.sin(f / 130 + i), 460 + i * 35 + 30 * Math.cos(f / 110 + i), 480 + i * 90], 48, 390)
    track(name, 'transform/scale', f => { const s = ramp(f, 48 + i * 6, 108 + i * 6) * (1 - ramp(f, 342, 384)); return [100 * s, 100 * s, 100 * s] }, 48, 390)
    track(name, 'transform/opacity', f => curve(f, [[48, 75], [114, 75], [132, 32], [258, 32], [288, 65], [360, 0]]), 48, 390)
    track(name, 'transform/rotationX', f => 12 * Math.sin(f / 130 + i), 48, 390)
    track(name, 'transform/rotationY', f => -8 + i * 7 + 8 * Math.sin(f / 160), 48, 390)
    track(name, 'transform/rotation', f => -18 + i * 18 + 4 * Math.sin(f / 140 + i), 48, 390)
  }

  const brief = rig('brief.rig')
  const briefBody = shape('brief.body', brief, [840, 190], [0, 0, 0], '#ffffff', 12, 18)
  morphBody(briefBody, [840, 190], [70.4, 246.4], '#ffffff')
  const briefLabel = text('brief.label', 'YOUR NEXT BIG IDEA', brief, 16, [-370, -44, -6], '#847e94', 'SemiBold')
  const briefCopy = text('brief.prompt', 'Create a launch campaign.', brief, 35, [-370, 12, -6], '#252130', 'Medium')
  const briefSub = text('brief.meta', 'Research. Design. Bring it to life.', brief, 17, [-370, 58, -6], '#81798e')
  const button = shape('brief.action', brief, [64, 64], [350, 3, -9], purple, 8, 12)
  const arrow = text('brief.arrow', '↑', brief, 38, [337, 18, -24], '#ffffff')
  for (const n of [briefLabel, briefCopy, briefSub, button, arrow]) hideContent(n)
  track(button, 'transform/position', f => [350, 3, -9 + 5 * Math.sin(Math.PI * ramp(f, 42, 54))], 39, 57)
  track(brief, 'transform/position', f => curve(f, [[0, [640, 365, 0]], [54, [640, 365, 0]], [108, [640, 130, 180]], [132, [640, -100, 440]], [258, [640, -100, 440]], [288, [640, 115, 140]], [342, [640, 175, 160]], [378, [352, 360, 0]]]))
  track(brief, 'transform/rotationX', f => curve(f, [[0, 8], [54, 4], [108, -9], [300, -6], [348, 8], [396, 0]]))
  track(brief, 'transform/rotationY', f => curve(f, [[0, -14], [54, -8], [108, 2], [300, -4], [348, -18], [396, 0]]))
  track(brief, 'transform/rotation', f => curve(f, [[0, -5], [54, -2], [108, 0], [300, 1], [348, -10], [396, 0]]))
  track(brief, 'transform/scale', f => { const s = curve(f, [[0, 100], [54, 100], [108, 67], [321, 67], [396, 100]]); return [s, s, s] })

  const definitions = [
    { id: 'research', title: 'Research', label: '01 / FIND THE SIGNAL', color: '#fdfcfb', accent: '#2a9d99', place: [230, 390, 40], final: [528, 272, 0] },
    { id: 'design', title: 'Design', label: '02 / MAKE IT REAL', color: '#f2edff', accent: purple, place: [640, 400, -80], final: [440, 360, 0] },
    { id: 'launch', title: 'Launch plan', label: '03 / MOVE IT FORWARD', color: '#fffbf5', accent: '#dd5b00', place: [1050, 390, 40], final: [528, 448, 0] },
  ]
  const panels = []
  for (const [i, def] of definitions.entries()) {
    const panel = rig(`${def.id}.rig`); panels.push(panel)
    const body = shape(`${def.id}.body`, panel, [350, 350], [0, 0, 0], def.color, 12, 18)
    morphBody(body, [350, 350], [70.4, 70.4], def.color)
    const contents = []
    contents.push(text(`${def.id}.eyebrow`, def.label, panel, 13, [-145, -138, -6], def.accent, 'SemiBold'))
    contents.push(text(`${def.id}.title`, def.title, panel, 36, [-145, -91, -6], '#282333', 'SemiBold'))
    contents.push(shape(`${def.id}.rule`, panel, [290, 1], [0, -66, -5], '#dcd6e7', 0))
    const start = 63 + i * 8
    lifetime(panel, start)
    // The active deliverable comes forward while its neighbours recede in depth.
    const focus = f => ramp(f, 120 + i * 48, 132 + i * 48) * (1 - ramp(f, 162 + i * 48, 180 + i * 48))
    const tour = f => ramp(f, 114, 132) * (1 - ramp(f, 258, 282))
    track(panel, 'transform/scale', f => { const s = 100 * ramp(f, start, start + 48) * (1 - .24 * tour(f) * (1 - focus(f))); return [s, s, s] })
    track(panel, 'transform/position', f => {
      const p = curve(f, [[0, [960, 360, 10]], [start, [960, 360, 10]], [126 + i * 4, def.place], [282, def.place], [342, [285 + i * 355, 400, 30]], [378, [680 + i * 140, 120 + i * 240, 0]], [402, def.final]])
      return [p[0], p[1], p[2] + 260 * tour(f) * (1 - focus(f))]
    })
    track(panel, 'transform/rotationX', f => curve(f, [[0, 70], [start, 70], [126, i === 1 ? 4 : -5], [282, 3], [342, 6], [396, 0]]))
    track(panel, 'transform/rotationY', f => curve(f, [[0, -90], [start, -90], [126, 16 - i * 16], [282, 8 - i * 8], [342, 6 - i * 6], [396, 0]]))
    track(panel, 'transform/rotation', f => curve(f, [[0, -25], [start, -25], [126, -5 + i * 5], [282, -2 + i * 2], [342, -3 + i * 3], [396, 0]]))
    const line = (name, x, y, w, c, from, h = 7) => {
      const l = shape(`${def.id}.${name}`, panel, [w, h], [x + w / 2, y, -6], c, h / 2)
      set(l, 'transform/anchor', [-w / 2, 0, 0]); set(l, 'transform/position', [x, y, -6])
      track(l, 'transform/scale', f => [100 * ramp(f, from, from + 18), 100, 100], from - 3, from + 21)
      contents.push(l)
      return l
    }
    if (i === 0) {
      contents.push(text('research.question', 'Find your audience.', panel, 23, [-145, -29, -6], '#393242', 'Medium'))
      for (const [row, copy] of ['Product teams', 'Independent makers'].entries()) {
        contents.push(text(`research.insight-${row}`, copy, panel, 19, [-145, 8 + row * 27, -6], '#736b83'))
      }
      for (let bar = 0; bar < 5; bar++) {
        const h = [25, 39, 32, 55, 69][bar]
        const n = shape(`research.bar-${bar}`, panel, [37, h], [-123 + bar * 55, 130 - h / 2, -6], bar === 4 ? '#2a9d99' : '#b3dbd5', 5)
        set(n, 'transform/anchor', [0, h / 2, 0]); set(n, 'transform/position', [-123 + bar * 55, 130, -6])
        track(n, 'transform/scale', f => [100, 100 * ramp(f, 105 + bar * 4, 126 + bar * 4), 100], 102, 144)
        contents.push(n)
      }
    } else if (i === 1) {
      const graphic = image('design.artwork', 'poster.svg')
      attach(graphic, panel, [0, 46, -6]); contents.push(graphic)
      contents.push(text('design.poster-title', 'NE\nXT', panel, 48, [-125, 15, -12], '#ffffff', 'SemiBold'))
      track('design.poster-title', 'transform/position', f => [-125, 15 - 14 * (1 - ramp(f, 174, 195)), -12], 171, 198)
      const orbit = 'design.orbit'
      run('layer.newModel', { name: orbit, path: 'media/orbit.glb', position: [0, 0, 0] })
      attach(orbit, panel, [70, 25, -95]); set(orbit, 'geometryOptions/unitScale', 1)
      lifetime(orbit, start, 363)
      track(orbit, 'transform/rotationX', f => 15 + 16 * Math.sin(f / 44), start, 363)
      track(orbit, 'transform/rotationY', f => 30 + (f - start) * .85, start, 363)
      track(orbit, 'transform/scale', f => { const s = 88 * (1 - ramp(f, 345, 360)); return [s, s, s] }, start, 363)
      track(graphic, 'transform/scale', f => { const p = ramp(f, 174, 198); return [108 - 8 * p, 108 - 8 * p, 100] }, 171, 201)
    } else {
      const rows = [['Positioning', 'Ready'], ['Creative', 'Ready'], ['Launch', 'Review']]
      for (const [j, [label, status]] of rows.entries()) {
        const y = -20 + j * 58
        contents.push(shape(`launch.tick-${j}`, panel, [20, 20], [-134, y, -6], j < 2 ? '#d9eee8' : '#e7e0ff', 6))
        contents.push(text(`launch.task-${j}`, label, panel, 22, [-110, y + 7, -6], '#393242'))
        contents.push(text(`launch.status-${j}`, status, panel, 15, [88, y + 5, -6], j < 2 ? '#2a9d99' : purple))
        line(`progress-${j}`, -110, y + 24, 248, j < 2 ? '#c2dbd5' : '#beb1ed', 204 + j * 8, 3)
      }
    }
    for (const n of contents) {
      lifetime(n, start)
      track(n, 'transform/opacity', f => 100 * ramp(f, 80 + i * 3, 104 + i * 3) * (1 - ramp(f, 348, 360)))
    }
  }

  // A real camera travels through the same objects; it never resets between cards.
  const poses = [
    [0, [770, 260, -1330], [650, 365, 0]],
    [48, [745, 290, -1390], [650, 365, 0]],
    [114, [845, 180, -2040], [640, 325, 10]],
    [138, [245, 290, -1070], [235, 390, 35]],
    [162, [285, 295, -1095], [265, 390, 35]],
    [186, [625, 310, -1155], [625, 400, -80]],
    [210, [665, 315, -1180], [655, 400, -80]],
    [234, [1005, 300, -1070], [1020, 390, 35]],
    [258, [1045, 305, -1095], [1045, 390, 35]],
    [288, [820, 190, -2020], [640, 340, 0]],
    [342, [750, 255, -1820], [640, 355, 0]],
    [402, [640, 360, -1777.7778], [640, 360, 0]],
    [480, [640, 360, -1777.7778], [640, 360, 0]],
  ]
  // Monotone Hermite tangents retain a small velocity through each reading interval.
  // Sign changes stop at a turning point, and every component stays within its keys.
  const cameraCurve = (f, keys) => {
    let segment = keys.findIndex((key, index) => index > 0 && f <= key[0]) - 1
    if (segment < 0) return keys.at(-1)[1]
    const [t0, p0] = keys[segment], [t1, p1] = keys[segment + 1]
    const h = t1 - t0, u = clamp((f - t0) / h)
    const tangent = (index, axis) => {
      if (index === 0 || index === keys.length - 1) return 0
      const left = keys[index][0] - keys[index - 1][0], right = keys[index + 1][0] - keys[index][0]
      const a = (keys[index][1][axis] - keys[index - 1][1][axis]) / left
      const b = (keys[index + 1][1][axis] - keys[index][1][axis]) / right
      if (a * b <= 0) return 0
      const w1 = 2 * right + left, w2 = right + 2 * left
      return (w1 + w2) / (w1 / a + w2 / b)
    }
    return p0.map((v, axis) => (2 * u ** 3 - 3 * u ** 2 + 1) * v + (u ** 3 - 2 * u ** 2 + u) * h * tangent(segment, axis)
      + (-2 * u ** 3 + 3 * u ** 2) * p1[axis] + (u ** 3 - u ** 2) * h * tangent(segment + 1, axis))
  }
  run('layer.newCamera', { name: 'camera.continuous', preset: '50mm', dof: true, aperture: 9 })
  track('camera.continuous', 'transform/position', f => cameraCurve(f, poses.map(([n, p]) => [n, p])))
  track('camera.continuous', 'transform/poi', f => cameraCurve(f, poses.map(([n, , p]) => [n, p])))
  track('camera.continuous', 'cameraOptions/focusDistance', f => {
    const pos = cameraCurve(f, poses.map(([n, p]) => [n, p]))
    const poi = cameraCurve(f, poses.map(([n, , p]) => [n, p]))
    return Math.hypot(...pos.map((v, i) => v - poi[i]))
  })
  track('camera.continuous', 'cameraOptions/aperture', f => 9 * (1 - ramp(f, 348, 402)), 345, 405)
  run('layer.newLight', { name: 'light.soft-fill', kind: 'Ambient', color: '#ffffff', intensity: 72 })
  run('layer.newLight', { name: 'light.key', kind: 'Point', position: [-200, -500, -900], color: '#ffffff', intensity: 80 })
  run('layer.newLight', { name: 'light.lavender-rim', kind: 'Point', position: [1500, 250, -200], color: '#ddd4ff', intensity: 65 })

  const overlay = (name, copy, size, xy, from, until, fill = '#282333') => {
    text(name, copy, null, size, [...xy, 0], fill, 'Medium')
    lifetime(name, from, until)
    track(name, 'transform/position', f => [xy[0], xy[1] + 15 * (1 - ramp(f, from, from + 15)), 0], from, Math.min(end, from + 18))
    track(name, 'transform/opacity', f => 100 * ramp(f, from, from + 15) * (until < end ? 1 - ramp(f, until - 12, until) : 1), from, until)
  }
  overlay('copy.one-brief', 'One brief.', 58, [72, 110], 0, 66)
  overlay('copy.whole-team', 'A whole team.', 58, [72, 110], 78, 132)
  overlay('copy.together', 'Work, brought together.', 52, [72, 110], 276, 336)
  overlay('brand.wordmark', 'Kition', 88, [610, 378], 390, end)
  overlay('brand.promise', 'From one idea to real work.', 28, [615, 428], 408, end, '#736b83')
  overlay('brand.domain', 'kition.ai', 24, [615, 470], 414, end, purple)
  return { title: 'Kition - One brief, a whole team', width, height, frameRate: fps, duration: 20,
    revision: 3, checkpoints: [0.75, 2, 4.5, 6, 8, 10, 12, 14.5, 15.25, 15.75, 16.25, 17.5, 19], hold: [18, 19.5],
    features: ['Native Advanced 3D renderer', 'Extruded and beveled shape layers', 'Original PBR ribbon meshes', 'Continuous two-node camera with tracked focus distance', 'Four persistent work objects morph into the canonical mark', 'Independent document content animation', 'Native H.264/AAC export'],
    content: 'Illustrative product visualization; not a live recording or execution-speed claim' }
}
