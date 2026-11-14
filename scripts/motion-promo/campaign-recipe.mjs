// Original product campaign; factual claims and footage come from the repository README.
export function campaign(execute) {
  const W = 1280; const H = 720; const duration = 24
  const colors = { purple: '#5645d4', ink: '#1a1a1a', muted: '#787671', lavender: '#e6e0f5', peach: '#ffe8d4', mint: '#d9f3e1' }
  const scenes = [
    { id: 'brand', start: 0, end: 4, message: 'One desktop workspace connects the work.' },
    { id: 'documents', start: 4, end: 8, message: 'Write and connect knowledge in Markdown documents.' },
    { id: 'thinking', start: 8, end: 12, message: 'Structure records in tables and think visually on Boards.' },
    { id: 'agent', start: 12, end: 16, message: 'The Agent edits real files; review additions and deletions.' },
    { id: 'workflows', start: 16, end: 20, message: 'Build visible, repeatable trigger-and-action workflows.' },
    { id: 'closing', start: 20, end: 24, message: 'Explore Kition at kition.ai.' },
  ]
  execute('comp.settings', { name: 'Kition - Ideas into action', width: W, height: H, duration, frameRate: 24, background: '#faf9f7' })
  const key = (name, property, time, value) => execute('prop.addKey', { layer: name, path: `transform/${property}`, time, value })
  const set = (name, property, value) => execute('prop.set', { layer: name, path: `transform/${property}`, value })
  function motion(name, scene, x, y, { delay = 0, travel = 36, opacity = 100, fromX = 0, exit = true } = {}) {
    const start = scene.start + delay
    execute('layer.timing', { layers: [name], in: start, out: scene.end })
    key(name, 'position', start, [x + fromX, y + travel, 0])
    key(name, 'position', start + .65, [x, y, 0])
    if (exit) {
      key(name, 'position', scene.end - .35, [x, y, 0])
      key(name, 'position', scene.end, [x - 42, y - 8, 0])
    }
    execute('prop.select', { layer: name, path: 'transform/position' }); execute('keys.easyEase', {})
    key(name, 'opacity', start, 0); key(name, 'opacity', start + .25, opacity)
    key(name, 'opacity', scene.end - .2, opacity); key(name, 'opacity', scene.end, exit ? 0 : opacity)
  }
  function shape(scene, id, x, y, w, h, fill, opts = {}) {
    const name = `${scene.id}.${id}`
    execute('layer.newShape', { name, kind: opts.kind ?? 'rounded', size: [w, h], fill, position: [x, y] })
    if (!opts.kind) execute('prop.set', { layer: name, path: 'contents/group/contents/rect/roundness', value: opts.radius ?? 12 })
    motion(name, scene, x, y, opts)
    return name
  }
  function text(scene, id, copy, x, y, size, opts = {}) {
    const name = `${scene.id}.${id}`
    execute('layer.newText', { name, text: copy, font: 'Inter', style: opts.style ?? 'SemiBold', size, fill: opts.fill ?? colors.ink, justify: opts.justify ?? 'left', position: [x, y], leading: size * 1.08 })
    motion(name, scene, x, y, opts)
    return name
  }
  function media(scene, id, file, x, y, width, sourceWidth, opts = {}) {
    const imported = execute('file.import', { paths: [`media/${file}`], sequence: false, addToComp: true })
    if (imported.errors?.length) throw new Error(JSON.stringify(imported.errors))
    const layer = execute('comp.info', {}).layers[0].id
    const name = `${scene.id}.${id}`
    execute('layer.rename', { layer, name })
    const scale = width / sourceWidth * 100
    set(name, 'scale', [scale, scale, 100])
    motion(name, scene, x, y, { fromX: 65, ...opts })
    key(name, 'scale', scene.start + (opts.delay ?? 0), [scale * .97, scale * .97, 100])
    key(name, 'scale', scene.end, [scale * 1.025, scale * 1.025, 100])
    return name
  }
  function chrome(scene, index, label) {
    text(scene, 'chapter', `0${index}  /  ${label}`, 66, 60, 15, { fill: colors.purple, travel: 0 })
    text(scene, 'brand', 'Kition', 1214, 60, 20, { justify: 'right', travel: 0 })
    shape(scene, 'progress-track', 640, 673, 1148, 2, '#e5e3df', { kind: 'rect', travel: 0 })
    const progress = shape(scene, 'progress', 66, 673, 1148, 3, colors.purple, { kind: 'rect', travel: 0 })
    set(progress, 'anchor', [-574, 0, 0])
    key(progress, 'scale', scene.start, [0, 100, 100]); key(progress, 'scale', scene.end, [100, 100, 100])
  }

  const first = scenes[0]
  shape(first, 'halo', 1030, 290, 570, 570, colors.lavender, { kind: 'ellipse', opacity: 48, travel: 0 })
  shape(first, 'orbit', 1100, 570, 290, 290, colors.peach, { kind: 'ellipse', opacity: 60, delay: .2 })
  media(first, 'symbol', 'symbol.svg', 1060, 270, 190, 256, { fromX: 0, delay: .2 })
  text(first, 'eyebrow', 'MEET YOUR AI WORKSPACE', 76, 126, 18, { fill: colors.purple, delay: .08 })
  text(first, 'headline-1', 'Ideas,', 70, 290, 116, { delay: .12, travel: 60 })
  text(first, 'headline-2', 'meet action.', 70, 413, 116, { fill: colors.purple, delay: .35, travel: 65 })
  text(first, 'promise', 'Your knowledge. Your tools. One connected place.', 78, 495, 24, { style: 'Regular', delay: .6 })
  const labels = ['Documents', 'Tables', 'Boards', 'Agent', 'Workflows']
  for (const [i, label] of labels.entries()) {
    shape(first, `tile-${i}`, 154 + i * 218, 597, 198, 54, ['#e6e0f5', '#ffe8d4', '#d9f3e1', '#e6e0f5', '#f0eeec'][i], { delay: .85 + i * .1, radius: 8 })
    text(first, `label-${i}`, label, 154 + i * 218, 605, 18, { justify: 'center', delay: .9 + i * .1 })
  }

  const docs = scenes[1]
  chrome(docs, 1, 'CONNECTED KNOWLEDGE')
  shape(docs, 'backing', 880, 358, 738, 484, colors.lavender, { delay: .05 })
  media(docs, 'product', 'documents.webp', 880, 358, 710, 1200, { delay: .16, travel: 22 })
  text(docs, 'headline', 'Write.\nConnect.\nRemember.', 66, 224, 62, { delay: .12 })
  text(docs, 'detail', 'Markdown documents.\nLinks, backlinks, and context.', 70, 477, 22, { style: 'Regular', fill: colors.muted, delay: .4 })
  shape(docs, 'tag', 196, 565, 252, 42, '#ffffff', { delay: .6, radius: 8 })
  text(docs, 'tag-label', 'Knowledge that stays connected', 196, 572, 14, { justify: 'center', fill: colors.purple, delay: .65 })

  const thinking = scenes[2]
  chrome(thinking, 2, 'DATA + VISUAL THINKING')
  text(thinking, 'headline', 'Give your ideas structure.', 66, 158, 56, { delay: .08 })
  shape(thinking, 'table-frame', 347, 393, 562, 358, colors.peach, { delay: .12 })
  shape(thinking, 'board-frame', 933, 393, 562, 358, colors.mint, { delay: .3 })
  media(thinking, 'table', 'tables.webp', 347, 393, 538, 1200, { delay: .22, fromX: -65 })
  media(thinking, 'board', 'boards.webp', 933, 393, 538, 1200, { delay: .4 })
  text(thinking, 'tables-label', 'TABLES  /  Records into useful tools', 68, 622, 18, { delay: .5 })
  text(thinking, 'boards-label', 'BOARDS  /  A canvas for the big picture', 654, 622, 18, { delay: .65 })

  const agent = scenes[3]
  chrome(agent, 3, 'REVIEWABLE AI EDITS')
  shape(agent, 'backing', 880, 363, 738, 438, colors.lavender, { delay: .05 })
  media(agent, 'review', 'agent-review.webp', 880, 363, 710, 1920, { delay: .18 })
  text(agent, 'headline', 'AI does\nthe work.', 66, 227, 66, { delay: .1 })
  text(agent, 'control', 'You keep control.', 70, 423, 31, { fill: colors.purple, delay: .45 })
  text(agent, 'detail', 'Read the changes.\nKeep what matters.', 70, 487, 22, { style: 'Regular', fill: colors.muted, delay: .55 })
  shape(agent, 'review-badge', 970, 580, 330, 49, colors.mint, { delay: .8, radius: 8 })
  text(agent, 'review-label', 'Inspect. Accept. Reject.', 970, 589, 19, { justify: 'center', delay: .85 })

  const flows = scenes[4]
  chrome(flows, 4, 'VISIBLE AUTOMATION')
  shape(flows, 'backing', 880, 358, 738, 484, colors.peach, { delay: .05 })
  media(flows, 'product', 'workflows.webp', 880, 358, 710, 1200, { delay: .18 })
  text(flows, 'headline', 'Good work.\nOn repeat.', 66, 245, 65, { delay: .1 })
  text(flows, 'detail', 'Build the steps.\nSee the process.\nRun it again.', 70, 453, 24, { style: 'Regular', fill: colors.muted, delay: .45 })
  for (const [i, label] of ['Trigger', 'Action', 'Result'].entries()) {
    shape(flows, `node-${i}`, 125 + i * 130, 575, 110, 44, i === 1 ? colors.purple : '#e6e0f5', { delay: .65 + i * .15, radius: 8 })
    text(flows, `node-label-${i}`, label, 125 + i * 130, 582, 15, { fill: i === 1 ? '#ffffff' : colors.purple, justify: 'center', delay: .7 + i * .15 })
  }

  const close = scenes[5]
  shape(close, 'wash', 640, 270, 1480, 560, '#f0ecfa', { kind: 'ellipse', travel: 0, opacity: 65, exit: false })
  media(close, 'symbol', 'symbol.svg', 525, 210, 104, 256, { fromX: 0, travel: 0, exit: false })
  text(close, 'wordmark', 'Kition', 600, 238, 78, { delay: .12, exit: false })
  text(close, 'headline', 'One workspace. Every next step.', 640, 353, 52, { justify: 'center', delay: .3, exit: false })
  text(close, 'summary', 'Documents  /  Tables  /  Boards  /  Agent  /  Workflows', 640, 413, 22, { justify: 'center', style: 'Regular', fill: colors.muted, delay: .45, exit: false })
  shape(close, 'cta', 640, 518, 250, 64, colors.purple, { delay: .65, radius: 8, exit: false })
  text(close, 'cta-label', 'Explore Kition', 640, 528, 22, { justify: 'center', fill: '#ffffff', delay: .7, exit: false })
  text(close, 'url', 'kition.ai', 640, 615, 23, { justify: 'center', delay: .85, exit: false })

  // Transitions are actual editable shapes, timed to the music's four-second phrases.
  for (const boundary of [4, 8, 12, 16, 20]) {
    const scene = { id: `wipe-${boundary}`, start: boundary - .25, end: boundary + .25 }
    const name = `${scene.id}.panel`
    execute('layer.newShape', { name, kind: 'rect', size: [1450, 760], fill: colors.purple })
    execute('layer.timing', { layers: [name], in: scene.start, out: scene.end })
    key(name, 'position', boundary - .25, [-800, 360, 0]); key(name, 'position', boundary, [640, 360, 0]); key(name, 'position', boundary + .25, [2080, 360, 0])
    execute('prop.select', { layer: name, path: 'transform/position' }); execute('keys.easyEase', {})
  }
  return { title: 'Kition - Ideas into action', width: W, height: H, duration, frameRate: 24, scenes, checkpoints: [2, 6, 10, 14, 18, 22.5] }
}
