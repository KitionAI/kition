// Original closed ribbon mesh, stored as a portable glTF binary with a PBR material.
export function ribbonModel(phase, hex) {
  const vertices = [], indices = [], segments = 128
  for (let i = 0; i <= segments; i++) {
    const u = i / segments * 2 - 1
    const x = u * 960, y = 105 * Math.sin(u * Math.PI * 1.15 + phase)
    const z = 135 * Math.cos(u * Math.PI + phase)
    const twist = u * 1.9 + phase * .6
    const half = 20 + 16 * (1 - u * u)
    const vy = Math.cos(twist), vz = Math.sin(twist)
    for (const [side, back] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      vertices.push(x, y + side * half * vy - back * 2 * vz, z + side * half * vz + back * 2 * vy)
    }
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < 4; j++) {
    const a = i * 4 + j, b = i * 4 + (j + 1) % 4, c = a + 4, d = b + 4
    indices.push(a, c, b, b, c, d)
  }
  indices.push(0, 1, 2, 0, 2, 3)
  const last = segments * 4; indices.push(last, last + 2, last + 1, last, last + 3, last + 2)
  return meshGlb(vertices, indices, hex)
}

// A small original torus sculpture for the animated campaign artwork.
export function orbitModel() {
  const vertices = [], indices = [], rings = 72, sides = 12
  for (let ring = 0; ring < rings; ring++) {
    const u = ring / rings * Math.PI * 2
    for (let side = 0; side < sides; side++) {
      const v = side / sides * Math.PI * 2, radius = 68 + 11 * Math.cos(v)
      vertices.push(radius * Math.cos(u), radius * Math.sin(u), 11 * Math.sin(v))
    }
  }
  for (let ring = 0; ring < rings; ring++) for (let side = 0; side < sides; side++) {
    const a = ring * sides + side, b = ((ring + 1) % rings) * sides + side
    const c = ring * sides + (side + 1) % sides, d = ((ring + 1) % rings) * sides + (side + 1) % sides
    indices.push(a, b, c, c, b, d)
  }
  return meshGlb(vertices, indices, '#cfb08a')
}

function meshGlb(vertices, indices, hex) {
  const normals = vertices.map(() => 0)
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map(n => n * 3)
    const u = vertices.slice(b, b + 3).map((n, j) => n - vertices[a + j])
    const v = vertices.slice(c, c + 3).map((n, j) => n - vertices[a + j])
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    for (const at of [a, b, c]) for (let j = 0; j < 3; j++) normals[at + j] += n[j]
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(...normals.slice(i, i + 3)) || 1
    for (let j = 0; j < 3; j++) normals[i + j] /= length
  }
  const p = Buffer.from(new Float32Array(vertices).buffer), n = Buffer.from(new Float32Array(normals).buffer), ix = Buffer.from(new Uint32Array(indices).buffer)
  const bin = Buffer.concat([p, n, ix])
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < vertices.length; i++) { min[i % 3] = Math.min(min[i % 3], vertices[i]); max[i % 3] = Math.max(max[i % 3], vertices[i]) }
  const rgb = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
  const gltf = { asset: { version: '2.0', generator: 'Kition original mesh generator' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: .22, roughnessFactor: .44 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: p.length, target: 34962 }, { buffer: 0, byteOffset: p.length, byteLength: n.length, target: 34962 }, { buffer: 0, byteOffset: p.length + n.length, byteLength: ix.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' }, { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' }] }
  let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const out = Buffer.alloc(12 + 8 + json.length + 8 + bin.length)
  out.write('glTF'); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12); out.write('JSON', 16); json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length); out.write('BIN\0', 24 + json.length); bin.copy(out, 28 + json.length)
  return out
}
