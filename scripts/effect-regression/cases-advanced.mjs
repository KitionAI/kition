import { command, solid, prop, checkpoint, query, key, scenario } from './case-helpers.mjs'

const apply = effect => command('effect.apply', { layer: '#1', effect })
const effectProp = (path, value, index = 2) => command('prop.set', { layer: '#1', path: `effects/#${index}/${path}`, value })
const effectQuery = (path, index = 2) => ({ layer: '#1', path: `effects/#${index}/${path}` })
const expression = (path, expression, enabled = true) => command('prop.setExpression', { layer: '#1', path: `transform/${path}`, expression, enabled })
const expressionQuery = (path, expected) => ({
  ...query(path), fields: ['value', 'animated', 'evaluated', 'expression', 'expressionError'], expected,
})
const expressionSamples = (path, times, evaluate) => times.map((time, index) => checkpoint(`sample-${index}`, time, [expressionQuery(path, { evaluated: evaluate(time), expressionError: false })]))
const movingPrecomp = () => [
  command('comp.settings', { duration: 2 }), solid('Moving', '#00ff80', { width: 12, height: 12 }),
  key('position', 0, [8, 18, 0]), key('position', 2, [56, 18, 0]),
  command('layer.precompose', { layers: ['#1'], name: 'Motion' }),
]

export const advancedCases = [
  ...[
    ['tint', 'Tint', [['white', [1, 0.2, 0, 1]], ['amount', 75]]],
    ['exposure', 'Exposure', [['master/exposure', 1.5], ['master/gamma', 1.2]]],
    ['posterize', 'Posterize', [['level', 3]]],
    ['mosaic', 'Mosaic', [['horizontal', 4], ['vertical', 3]]],
    ['directional-blur', 'Directional Blur', [['direction', 45], ['length', 12]]],
    ['drop-shadow', 'Drop Shadow', [['color', [0.1, 0.3, 1, 1]], ['distance', 8], ['softness', 4]]],
    ['glow', 'Glow', [['threshold', 20], ['radius', 4], ['intensity', 2]]],
  ].map(([id, effect, settings]) => scenario(`effect-${id}`, `${effect}: defaults, parameters, reset, and undo on a gradient tile`, [
    solid('Gradient', '#ffffff', { width: 40, height: 24 }), apply('Gradient Ramp'),
    effectProp('start', [0, 0], 1), effectProp('end', [40, 24], 1), checkpoint('input'),
    apply(effect), checkpoint('default', 0, settings.map(([path]) => effectQuery(path))),
    ...settings.map(([path, value]) => effectProp(path, value)), checkpoint('custom', 0, settings.map(([path]) => effectQuery(path))),
    command('effect.reset', { layer: '#1', effect }), checkpoint('reset', 0, settings.map(([path]) => effectQuery(path))),
    command('edit.undo'), checkpoint('undo-reset', 0, settings.map(([path]) => effectQuery(path))),
  ])),
  scenario('effect-chain', 'Noncommuting effect order survives undo and redo', [
    solid('Tile', '#804020', { width: 28, height: 20 }), apply('Fill'), effectProp('color', [0.2, 0.6, 0.9, 1], 1),
    apply('Invert'), checkpoint('fill-then-invert'),
    command('effect.reorder', { layer: '#1', effect: 'Invert', index: 1 }), checkpoint('invert-then-fill'),
    command('edit.undo'), checkpoint('undo-reorder'), command('edit.redo'), checkpoint('redo-reorder'),
  ]),
  scenario('effect-animated-blur', 'Animated effect parameters evaluate at sampled times and reverse seeks', [
    solid('Tile', '#ffc040', { width: 20, height: 12 }), apply('Gaussian Blur'),
    command('prop.addKey', { layer: '#1', path: 'effects/#1/blurriness', time: 0, value: 0 }),
    command('prop.addKey', { layer: '#1', path: 'effects/#1/blurriness', time: 1, value: 10 }),
    ...[0, 0.5, 1, 0.25, 0].map((time, index) => checkpoint(`sample-${index}`, time, [effectQuery('blurriness', 1)])),
  ]),
  scenario('expression-time', 'An expression evaluates composition time rather than the stored base value', [
    solid(), expression('opacity', 'time * 50'), ...expressionSamples('opacity', [0, 0.5, 1, 1.5, 0.5], time => time * 50),
  ]),
  scenario('expression-vector', 'Vector expressions move the rendered layer', [
    solid('Moving', '#00ff80', { width: 12, height: 12 }), expression('position', '[8 + time * 40, 18, 0]'),
    ...expressionSamples('position', [0, 0.25, 0.5, 1, 0], time => [8 + time * 40, 18, 0]),
  ]),
  scenario('expression-value-toggle', 'Expression base value, disable, and undo have distinct results', [
    solid(), prop('opacity', 80), expression('opacity', 'value * 0.5'),
    checkpoint('enabled', 0, [expressionQuery('opacity', { value: 80, evaluated: 40, expressionError: false })]),
    expression('opacity', 'value * 0.5', false),
    checkpoint('disabled', 0, [expressionQuery('opacity', { evaluated: 80, expressionError: false })]),
    command('edit.undo'), checkpoint('undo-disable', 0, [expressionQuery('opacity', { evaluated: 40, expressionError: false })]),
  ]),
  scenario('expression-loop', 'Looped keyframes repeat beyond the last key', [
    solid(), key('opacity', 0, 0), key('opacity', 1, 100), expression('opacity', 'loopOut("cycle")'),
    ...expressionSamples('opacity', [0.25, 1.25, 1.75, 2.25], time => (time % 1) * 100),
  ]),
  ...[
    ['syntax', 'value +'], ['runtime', 'missingFunction()'],
  ].map(([kind, source]) => scenario(`expression-error-${kind}`, `An expression ${kind} error preserves the base value and can be repaired`, [
    solid(), prop('opacity', 60), expression('opacity', source),
    checkpoint('error', 0, [expressionQuery('opacity', { evaluated: 60, expressionError: true })]),
    expression('opacity', 'value / 2'), checkpoint('repaired', 0, [expressionQuery('opacity', { evaluated: 30, expressionError: false })]),
    command('edit.undo'), checkpoint('undo-repair', 0, [expressionQuery('opacity', { evaluated: 60, expressionError: true })]),
  ])),
  ...[50, 200].map(percent => scenario(`time-stretch-${percent}`, `Nested motion at ${percent}% stretch`, [
    ...movingPrecomp(), command('layer.timeStretch', { layers: ['#1'], percent }),
    ...[0, 0.5, 0.75, 1, 0].map((time, index) => checkpoint(`sample-${index}`, time)),
    command('edit.undo'), checkpoint('undo-stretch', 0.5),
  ])),
  scenario('time-reverse', 'Reversed nested motion and double reversal', [
    ...movingPrecomp(), checkpoint('forward', 0.5), command('layer.timeReverse', { layers: ['#1'] }),
    ...[0, 0.5, 1, 1.5].map((time, index) => checkpoint(`reverse-${index}`, time)),
    command('layer.timeReverse', { layers: ['#1'] }), checkpoint('restored', 0.5),
  ]),
  scenario('time-remap-freeze', 'Freeze a nested animation at the current time', [
    ...movingPrecomp(), command('time.set', { time: 0.5 }), command('layer.freezeFrame', { layers: ['#1'] }),
    ...[0, 0.5, 1, 1.5].map((time, index) => checkpoint(`frozen-${index}`, time)),
    command('edit.undo'), checkpoint('undo-freeze', 1),
  ]),
  scenario('three-d-transform', 'A 3D solid rotates and changes depth under a perspective camera', [
    solid('Plane', '#ff8040', { width: 28, height: 20 }), command('layer.setSwitch', { layers: ['#1'], switch: 'threeD', value: true }),
    command('layer.newCamera', { preset: '35mm' }), checkpoint('front'),
    prop('rotationY', 35, '#2'), checkpoint('rotated', 0, [query('rotationY', '#2')]),
    prop('position', [32, 18, 24], '#2'), checkpoint('depth', 0, [query('position', '#2')]),
    command('edit.undo'), checkpoint('undo-depth'),
  ]),
]
