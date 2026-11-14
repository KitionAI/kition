// A native simulation inside a time-remapped composition: no authored shard trajectories.
export function fragmentsFilm(run) {
  const fps = 30, end = 300
  const set = (layer, path, value) => run('prop.set', { layer, path, value })
  const key = (layer, path, frame, value) => run('prop.addKey', { layer, path, time: frame / fps, value })
  const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }
  const ramp = (f, a, b) => smooth((f - a) / (b - a))
  const mix = (a, b, p) => a + (b - a) * p
  const track = (layer, path, fn, a = 0, b = end, step = 2) => {
    for (let f = a; f <= b; f += step) key(layer, path, f, fn(f))
  }
  run('comp.settings', { name: 'Kition - From fragments to focus', width: 1280, height: 720, duration: 10, frameRate: fps, background: '#070f24' })
  run('file.import', { paths: ['media/material.svg'], addToComp: true })
  run('layer.rename', { layer: run('comp.info').layers[0].id, name: 'material.fracture' })
  run('effect.apply', { layer: 'material.fracture', effect: 'Shatter' })
  const fx = 'effects/#1/'
  for (const [param, value] of Object.entries({
    view: 0, 'shape/pattern': 3, 'shape/repetitions': 22, 'shape/extrusionDepth': .18,
    'shape/origin': [640, 360], 'force1/force1Position': [640, 360],
    'force1/force1Radius': 1.3, 'force1/force1Depth': .12, 'force1/force1Strength': 3.5,
    'force2/force2Strength': 0, 'physics/gravity': 0, 'physics/randomness': .3,
    'physics/rotationSpeed': .095, 'physics/viscosity': .05, 'physics/massVariance': 35,
    'textures/color': [0.32, 0.22, 0.74, 1], 'textures/sideMode': 0,
    'lighting/lightType': 1, 'lighting/lightIntensity': 1.05,
    'lighting/lightPosition': [340, 80], 'lighting/lightDepth': .9, 'lighting/ambientLight': .3,
    'material/diffuse': .7, 'material/specular': .18, 'material/highlightSharpness': 45,
    randomSeed: 41,
  })) set('material.fracture', fx + param, value)
  // These keys are in simulation time. The outer composition later reverses them.
  track('material.fracture', fx + 'cameraPosition/yRotation', f => 23 * ramp(f, 0, 48), 0, 60)
  track('material.fracture', fx + 'cameraPosition/xRotation', f => -11 * ramp(f, 0, 48), 0, 60)
  track('material.fracture', fx + 'cameraPosition/zRotation', f => -8 * ramp(f, 0, 48), 0, 60)
  track('material.fracture', fx + 'cameraPosition/cameraZ', f => mix(4, 3.4, ramp(f, 0, 48)), 0, 60)
  // Return to the exact artwork as the pieces settle; avoid faceted highlights at rest.
  track('material.fracture', fx + 'lighting/ambientLight', f => mix(1, .3, ramp(f, 0, 6)), 0, 60)
  track('material.fracture', fx + 'material/diffuse', f => .7 * ramp(f, 0, 6), 0, 60)
  track('material.fracture', fx + 'material/specular', f => .18 * ramp(f, 0, 6), 0, 60)
  run('layer.precompose', { layers: ['material.fracture'], name: 'Native fracture simulation' })
  const assembly = run('comp.info').layers[0].id
  run('layer.rename', { layer: assembly, name: 'assembly.reverse-simulation' })
  run('layer.enableTimeRemap', { layers: [assembly], value: true })
  const simulationTime = f => f < 45 ? mix(1.65, 1.38, ramp(f, 0, 45))
    : f < 84 ? mix(1.38, .98, ramp(f, 45, 84))
      : f < 120 ? mix(.98, 0, ramp(f, 84, 120)) : 0
  track(assembly, 'timeRemap', simulationTime, 0, 300)
  run('effect.apply', { layer: assembly, effect: 'Glow' })
  set(assembly, 'effects/#1/threshold', 80)
  set(assembly, 'effects/#1/based', 1)
  set(assembly, 'effects/#1/radius', 8)
  track(assembly, 'effects/#1/intensity', f => .05 + .12 * Math.exp(-(((f - 120) / 9) ** 2)))
  track(assembly, 'transform/scale', f => { const s = mix(112, 66, ramp(f, 156, 198)); return [s, s, 100] })
  track(assembly, 'transform/position', f => [mix(640, 440, ramp(f, 156, 198)), mix(360, 332, ramp(f, 156, 198)), 0])

  run('layer.newSolid', { name: 'light.optical-sweep', color: '#000000', width: 1280, height: 720 })
  run('layer.setBlendMode', { layers: ['light.optical-sweep'], mode: 'Screen' })
  run('effect.apply', { layer: 'light.optical-sweep', effect: 'Lens Flare' })
  set('light.optical-sweep', 'effects/#1/lensType', 1)
  run('layer.timing', { layers: ['light.optical-sweep'], in: 3.65, out: 5.1 })
  track('light.optical-sweep', 'effects/#1/flareCenter', f => [mix(420, 840, ramp(f, 110, 150)), 300], 110, 152)
  track('light.optical-sweep', 'effects/#1/flareBrightness', f => 60 * Math.exp(-(((f - 122) / 8) ** 2)), 110, 152)
  track('light.optical-sweep', 'transform/opacity', f => 100 * ramp(f, 110, 116) * (1 - ramp(f, 140, 152)), 110, 152)

  const title = (name, text, size, x, y, color, start) => {
    run('layer.newText', { name, text, font: 'Inter', style: 'Medium', size, position: [x, y], justify: 'left', fill: color })
    run('layer.timing', { layers: [name], in: start / fps, out: 10 })
    track(name, 'transform/position', f => [x, y + 24 * (1 - ramp(f, start, start + 20)), 0], start, start + 24)
    track(name, 'transform/opacity', f => 100 * ramp(f, start, start + 18), start, start + 24)
  }
  title('copy.brand', 'Kition', 100, 592, 365, '#FFFFFF', 180)
  title('copy.promise', 'Bring your work together.', 27, 598, 420, '#C8C3E2', 192)
  title('copy.domain', 'kition.ai', 19, 600, 467, '#A99DEC', 204)
  return { title: 'Kition - From fragments to focus', width: 1280, height: 720, frameRate: fps, duration: 10,
    checkpoints: [0, 1.5, 2.8, 3.5, 4, 4.6, 6.6, 8.5], hold: [8.5, 9.5],
    nativeFeatures: ['Shatter: procedural 3D pieces, extrusion, force, mass and rotation', 'Native simulation camera and specular lighting', 'Nested composition with reverse time remapping and speed ramp', 'Glow and Screen-blended Lens Flare', 'Native H.264/AAC movie export'],
    limitations: ['A brand motion study, not a product feature demonstration', 'WebGL can reproduce this class of graphics; this is not evidence that the web cannot do it'] }
}
