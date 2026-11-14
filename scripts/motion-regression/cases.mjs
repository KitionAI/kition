// Original, asset-free projects. Every checkpoint records state and a complete RGBA frame.
import { command, solid, prop, checkpoint, query, key, sample, scenario } from './case-helpers.mjs'
import { advancedCases } from './cases-advanced.mjs'

export const cases = [
  scenario('composition', 'Empty composition, settings, and a full-frame solid', [
    checkpoint('empty'), command('comp.settings', { duration: 2, frameRate: 24, background: '#123456' }),
    checkpoint('settings'), solid(), checkpoint('solid'),
  ]),
  scenario('transform', 'Position, scale, rotation, anchor, and opacity', [
    solid('Tile', '#ffcc00', { width: 20, height: 12 }), checkpoint('centered'),
    prop('position', [20, 12, 0]), checkpoint('position', 0, [query('position')]),
    prop('scale', [150, 50, 100]), checkpoint('scale', 0, [query('scale')]),
    prop('rotation', 35), checkpoint('rotation', 0, [query('rotation')]),
    prop('anchor', [0, 0, 0]), checkpoint('anchor', 0, [query('anchor')]),
    prop('opacity', 40), checkpoint('opacity', 0, [query('opacity')]),
  ]),
  ...['Normal', 'Multiply', 'Screen', 'Add', 'Difference'].map(mode => scenario(`blend-${mode.toLowerCase()}`, `Two colored solids with ${mode} blending`, [
    solid('Bottom', '#406080'), solid('Top', '#c08040', { width: 32, height: 20 }),
    command('layer.setBlendMode', { layers: ['#1'], mode }), checkpoint('blend'),
    prop('opacity', 50), checkpoint('half-opacity', 0, [query('opacity')]),
  ])),
  scenario('opacity-linear', 'Opacity keyframes at endpoints, fractional times, and reverse seeks', [
    solid(), key('opacity', 0, 0), key('opacity', 1, 100),
    ...sample([0, 0.25, 0.5, 0.75, 1, 0.5, 0], 'opacity'),
  ]),
  scenario('position-linear', 'Position animation preserves motion geometry', [
    solid('Moving', '#00ff00', { width: 12, height: 12 }),
    key('position', 0, [8, 18, 0]), key('position', 1, [56, 18, 0]),
    ...sample([0, 0.25, 0.5, 0.75, 1], 'position'),
  ]),
  ...['hold', 'ease'].map(kind => scenario(`opacity-${kind}`, `Opacity with ${kind} interpolation`, [
    solid(), key('opacity', 0, 0), key('opacity', 1, 100),
    command('prop.select', { layer: '#1', path: 'transform/opacity' }),
    kind === 'hold' ? command('keys.interpolation', { interpolation: 'hold' }) : command('keys.easyEase'),
    ...sample([0, 0.25, 0.5, 0.75, 1], 'opacity'),
  ])),
  ...['rect', 'ellipse'].map(shape => scenario(`mask-${shape}`, `Add, inverted, and subtract ${shape} masks`, [
    solid(), command('layer.addMask', { layer: '#1', shape, rect: [12, 6, 32, 24] }), checkpoint('add'),
    command('layer.setMask', { layer: '#1', mask: 1, inverted: true }), checkpoint('inverted'),
    command('layer.setMask', { layer: '#1', mask: 1, mode: 'Subtract', inverted: false }), checkpoint('subtract'),
  ])),
  ...['rect', 'ellipse', 'star'].map(kind => scenario(`shape-${kind}`, `Procedural ${kind} with fill and stroke`, [
    command('layer.newShape', { kind, fill: '#12b080', stroke: '#ffc040', strokeWidth: 2, size: [28, 20] }),
    checkpoint('shape'), prop('rotation', 25), checkpoint('rotated'),
  ])),
  scenario('effect-invert', 'Effect application, disable, undo, and redo', [
    solid('Color', '#123456'), checkpoint('original'),
    command('effect.apply', { layer: '#1', effect: 'Invert' }), checkpoint('inverted'),
    command('layer.setSwitch', { layers: ['#1'], switch: 'effects', value: false }), checkpoint('disabled'),
    command('edit.undo'), checkpoint('undo-disable'), command('edit.redo'), checkpoint('redo-disable'),
  ]),
  scenario('effect-blur', 'Gaussian blur at neutral and nonzero settings', [
    solid('Tile', '#ffffff', { width: 20, height: 12 }), checkpoint('original'),
    command('effect.apply', { layer: '#1', effect: 'Gaussian Blur' }), checkpoint('neutral'),
    command('prop.set', { layer: '#1', path: 'effects/#1/blurriness', value: 4 }), checkpoint('blurred'),
  ]),
  scenario('visibility', 'Layer visibility and solo select the correct render stack', [
    solid('Bottom', '#ff0000'), solid('Top', '#0000ff', { width: 24, height: 16 }), checkpoint('both'),
    command('layer.setSwitch', { layers: ['#1'], switch: 'video', value: false }), checkpoint('hidden'),
    command('edit.undo'), command('layer.setSwitch', { layers: ['#1'], switch: 'solo', value: true }), checkpoint('solo'),
  ]),
  scenario('duplicate-history', 'Duplicate, delete, undo, and redo retain content and order', [
    solid('Tile', '#00aaff', { width: 16, height: 12 }), checkpoint('one'),
    command('edit.duplicate'), prop('position', [12, 10, 0]), checkpoint('two'),
    command('edit.clear'), checkpoint('deleted'), command('edit.undo'), checkpoint('undo-delete'),
    command('edit.redo'), checkpoint('redo-delete'),
  ]),
  scenario('precompose', 'Precomposition preserves the outer image and supports undo', [
    solid('Bottom', '#204080'), solid('Tile', '#ff8000', { width: 24, height: 16 }), checkpoint('before'),
    command('layer.precompose', { layers: ['#1', '#2'], name: 'Nested' }), checkpoint('nested'),
    command('edit.undo'), checkpoint('undo'), command('edit.redo'), checkpoint('redo'),
  ]),
  scenario('timing', 'Layer in point is inclusive and out point is exclusive', [
    solid(), command('layer.timing', { layers: ['#1'], in: 1, out: 2 }),
    ...[0, 1, 1.5, 2, 1].map((time, index) => checkpoint(`sample-${index}`, time)),
  ]),
  scenario('parenting', 'Parent movement propagates to the child; cycles fail', [
    solid('Child', '#00ff00', { width: 12, height: 12 }), command('layer.newNull', { name: 'Parent' }),
    command('layer.setParent', { layers: ['#2'], parent: '#1' }), checkpoint('parented'),
    prop('position', [42, 24, 0]), checkpoint('moved'),
    command('layer.setParent', { layers: ['#1'], parent: '#2' }, true), checkpoint('cycle-rejected'),
  ]),
  ...['alpha', 'luma'].map(kind => scenario(`matte-${kind}`, `${kind} track matte composition`, [
    solid('Fill', '#ff8000'), solid('Matte', '#808080', { width: 24, height: 16 }),
    command('layer.setTrackMatte', { layer: '#2', matte: '#1', kind }), checkpoint('matte'),
    prop('opacity', 50), checkpoint('half-matte'),
  ])),
  scenario('invalid-commands', 'Invalid commands fail and preserve the prior image and state', [
    solid(), checkpoint('before'),
    command('missing.command', {}, true),
    command('prop.set', { layer: '#1', path: 'transform/missing', value: 1 }, true),
    command('layer.addMask', { layer: '#1', shape: 'missing' }, true), checkpoint('after'),
  ]),
  ...advancedCases,
]
