// Continuous product reveal adapted from a measured panel-to-canvas motion study.
// Reference: https://github.com/Vincentwei1021/video-shotcraft
// All graphics, copy, and screenshots in the composition belong to Kition.
export function motionStudy(execute) {
  const width = 1280; const height = 720; const frameRate = 30; const duration = 10
  const purple = '#5645d4'; const ink = '#1a1a1a'; const muted = '#787671'
  execute('comp.settings', { name: 'Kition - Room for your ideas', width, height, duration, frameRate, background: '#fafaf9' })
  const set = (layer, path, value) => execute('prop.set', { layer, path, value })
  const key = (layer, path, frame, value) => execute('prop.addKey', { layer, path, time: frame / frameRate, value })
  const clamp = x => Math.max(0, Math.min(1, x))
  const mix = (a, b, t) => a + (b - a) * t
  const ramp = (f, start, end) => { const t = clamp((f - start) / (end - start)); return t * t * (3 - 2 * t) }
  function spring(f, start, damping = 17, stiffness = 95, mass = .9) {
    if (f <= start) return 0
    const t = (f - start) / frameRate; const w = Math.sqrt(stiffness / mass)
    const z = damping / (2 * Math.sqrt(stiffness * mass)); const wd = w * Math.sqrt(1 - z * z)
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + z * w / wd * Math.sin(wd * t))
  }
  // Sample the analytic motion into ordinary editable Effect keyframes.
  function animate(layer, path, value, start = 0, end = 300) {
    for (let f = start; f <= end; f += 2) key(layer, path, f, value(f))
    if ((end - start) % 2) key(layer, path, end, value(end))
  }
  function shape(name, w, h, fill, radius = 12) {
    execute('layer.newShape', { name, kind: 'rounded', size: [w, h], fill, position: [0, 0] })
    set(name, 'contents/group/contents/rect/roundness', radius)
    return name
  }
  function text(name, copy, size, color = ink, justify = 'left') {
    execute('layer.newText', { name, text: copy, font: 'Inter', style: 'SemiBold', size, fill: color, justify, position: [0, 0], leading: size * 1.1 })
    return name
  }
  function image(name, file) {
    const result = execute('file.import', { paths: [`media/${file}`], sequence: false, addToComp: true })
    if (result.errors?.length) throw new Error(JSON.stringify(result.errors))
    execute('layer.rename', { layer: execute('comp.info', {}).layers[0].id, name })
    return name
  }
  function place(name, x, y) { set(name, 'transform/position', [x, y, 0]) }

  // The opening is a designed feature index, not a simulated product interaction.
  const rule = shape('brand.rule', 1152, 1, '#e5e3df', 0); place(rule, 640, 96)
  const logo = image('brand.symbol', 'symbol.svg'); place(logo, 83, 51); set(logo, 'transform/scale', [14, 14, 100])
  const brand = text('brand.wordmark', 'Kition', 24); place(brand, 112, 61)
  const url = text('brand.url', 'kition.ai', 22, muted, 'right'); place(url, 1216, 61)

  const intro1 = text('opening.ideas', 'Ideas need', 72)
  const intro2 = text('opening.room', 'room to grow.', 72, purple)
  for (const [name, y, delay] of [[intro1, 284, 0], [intro2, 365, 5]]) {
    animate(name, 'transform/position', f => [68 - 70 * ramp(f, 46, 64), y + 40 * (1 - spring(f, delay, 19, 130)) - 50 * ramp(f, 46, 64), 0], 0, 64)
    animate(name, 'transform/opacity', f => 100 * ramp(f, delay, delay + 12) * (1 - ramp(f, 46, 62)), 0, 64)
    execute('layer.timing', { layers: [name], in: 0, out: 64 / 30 })
  }
  const introDetail = text('opening.detail', 'Write. Organize. Automate.', 22, muted)
  place(introDetail, 72, 426)
  animate(introDetail, 'transform/opacity', f => 100 * ramp(f, 10, 26) * (1 - ramp(f, 46, 60)), 0, 60)
  execute('layer.timing', { layers: [introDetail], in: 0, out: 2 })

  const headline = text('canvas.headline', 'Your work, connected.', 58, ink, 'center')
  animate(headline, 'transform/position', f => [640, 176 + 45 * (1 - ramp(f, 66, 98)) - 10 * ramp(f, 168, 210), 0], 0, 212)
  animate(headline, 'transform/opacity', f => 100 * ramp(f, 80, 100))
  const subline = text('canvas.detail', 'Documents. Tables. Workflows. One workspace.', 21, muted, 'center')
  place(subline, 640, 211); animate(subline, 'transform/opacity', f => 100 * ramp(f, 88, 108) * (1 - ramp(f, 164, 190)))

  const items = [
    { id: 'documents', label: 'Documents', action: 'Write', tint: '#e6e0f5', x: 240, y: 425, angle: -2.5 },
    { id: 'workflows', label: 'Workflows', action: 'Automate', tint: '#d9f3e1', x: 1040, y: 435, angle: 1.8 },
    { id: 'tables', label: 'Tables', action: 'Organize', tint: '#ffe8d4', x: 640, y: 414, angle: -1.2 },
  ]
  // Paint the future hero last so that it grows above the other cards without a z-order jump.
  for (const item of items) {
    const i = ['documents', 'tables', 'workflows'].indexOf(item.id)
    const start = 60 + i * 6; const rowY = 258 + i * 106
    const geometry = (f) => {
      const u = spring(f, start + 4); const q = clamp(u); const us = clamp(spring(f - 3, start + 4))
      const sx = 954 + 90 * (1 - spring(f, 5 + i * 5, 19, 130))
      const sy = rowY; const ex = item.x; const ey = item.y
      const cx = (954 + ex) / 2; const cy = Math.min(sy, ey) - 147
      const merge = ramp(f, 170, 218)
      let x = (1 - q) ** 2 * sx + 2 * (1 - q) * q * cx + q * q * ex + (u - q) * (ex - cx) * .6
      let y = (1 - q) ** 2 * sy + 2 * (1 - q) * q * cy + q * q * ey + (u - q) * (ey - cy) * .6
      const lift = ramp(f, start, start + 4) * (1 - ramp(f, start + 4, start + 12))
      y -= 3 * lift
      let w = mix(468, 352, us) * (1 + .02 * lift); let h = mix(82, 292, us) * (1 + .02 * lift)
      const hero = item.id === 'tables'
      x = mix(x, 640 + (hero ? 0 : (i === 0 ? -20 : 20)), merge)
      y = mix(y, hero ? 426 : 441, merge)
      w = mix(w, hero ? 744 : 680, merge); h = mix(h, hero ? 478 : 438, merge)
      const rot = mix(item.angle * u, hero ? 0 : item.angle * 1.2, merge)
      return { x, y, w, h, rot, us, merge, lift, visible: 1 - (hero ? 0 : ramp(f, 205, 220)) }
    }
    const move = (name, local, opacity = () => 1) => {
      animate(name, 'transform/position', f => {
        const g = geometry(f); const [x, y] = local(g, f); const a = g.rot * Math.PI / 180
        return [g.x + x * Math.cos(a) - y * Math.sin(a), g.y + x * Math.sin(a) + y * Math.cos(a), 0]
      })
      animate(name, 'transform/rotation', f => geometry(f).rot)
      animate(name, 'transform/opacity', f => 100 * geometry(f).visible * opacity(geometry(f), f) * ramp(f, i * 4, 14 + i * 4))
    }
    const shadow = shape(`${item.id}.shadow`, 468, 82, '#1a1a1a')
    move(shadow, g => [0, 8 + 6 * g.lift + 16 * Math.sin(Math.PI * clamp(g.us))], g => .055 + .035 * g.lift)
    animate(shadow, 'contents/group/contents/rect/size', f => { const g = geometry(f); return [g.w + 8, g.h + 8] })
    const border = shape(`${item.id}.border`, 468, 82, '#e5e3df')
    move(border, () => [0, 0]); animate(border, 'contents/group/contents/rect/size', f => { const g = geometry(f); return [g.w + 2, g.h + 2] })
    const card = shape(`${item.id}.surface`, 468, 82, '#ffffff')
    move(card, () => [0, 0]); animate(card, 'contents/group/contents/rect/size', f => { const g = geometry(f); return [g.w, g.h] })
    const accent = shape(`${item.id}.accent`, 42, 42, item.tint, 8)
    move(accent, g => [mix(-195, -g.w / 2 + 30, g.us), mix(0, -g.h / 2 + 29, g.us)])
    animate(accent, 'transform/scale', f => { const s = mix(100, 50, geometry(f).us); return [s, s, 100] })
    const number = text(`${item.id}.index`, `0${i + 1}`, 15, purple, 'center')
    move(number, () => [-195, 6], g => 1 - clamp((g.us - .05) / .3))
    const rowText = text(`${item.id}.row-label`, item.label, 29)
    move(rowText, () => [-156, 10], g => 1 - clamp((g.us - .08) / .32))
    const label = text(`${item.id}.card-label`, item.label, 26)
    move(label, g => [-g.w / 2 + 51, -g.h / 2 + 36], g => clamp((g.us - .5) / .3) * (1 - ramp(g.merge, .2, .65)))
    const screenshot = image(`${item.id}.product`, `${item.id}.webp`)
    move(screenshot, g => [0, mix(2, 0, g.merge)], g => clamp((g.us - .5) / .3))
    animate(screenshot, 'transform/scale', f => {
      const g = geometry(f)
      // Fit both axes throughout the morph, leaving room for the animated labels.
      const innerHeight = g.h - mix(100, 24, g.merge)
      const s = Math.max(0, Math.min((g.w - 24) / 1200, innerHeight / 750)) * 100
      return [s, s, 100]
    })
    const action = text(`${item.id}.action`, item.action, 24, muted)
    move(action, g => [-g.w / 2 + 18, g.h / 2 - 12], g => clamp((g.us - .65) / .3) * (1 - ramp(g.merge, 0, .3)))
  }

  const endLabel = text('closing.label', 'One workspace. Every next step.', 26, purple, 'center')
  place(endLabel, 640, 695); animate(endLabel, 'transform/opacity', f => 100 * ramp(f, 222, 246))

  return {
    title: 'Kition - Room for your ideas', width, height, frameRate, duration,
    scenes: [{ id: 'continuous-reveal', start: 0, end: duration, message: 'Documents, tables, and workflows share one Kition workspace.' }],
    checkpoints: [1, 2, 2.4, 2.8, 3.2, 4, 5, 6.2, 7.1, 8.5],
    reference: { url: 'https://vincentwei1021.github.io/video-shotcraft/media/panel-to-canvas.mp4', style: 'panel-to-canvas', preserved: ['6-frame stagger', '4-frame anticipation', 'spring damping 17, stiffness 95, mass 0.9', '3-frame size lag', 'curved flight', 'separate row and card reveal windows'], adaptation: 'A branded feature index unfolds into real product captures, then the same cards gather into the table hero. No simulated application commands.' },
  }
}
