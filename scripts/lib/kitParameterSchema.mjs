import assert from 'node:assert/strict'

// KHP E7/A5 parameter schema validation, shared by the SDK check and its regressions.
const kinds = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json', 'file'])
const checkNode = (node, at, property) => {
  assert(node && typeof node === 'object' && !Array.isArray(node), `${at}: a schema node is an object`)
  if (property && 'required' in node) assert(node.required === true, `${at}: required must be true`)
  if (node.oneOf) {
    assert(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${at}: oneOf needs two branches`)
    node.oneOf.forEach((branch, index) => checkNode(branch, `${at}.oneOf[${index}]`, false))
    return
  }
  assert(kinds.has(node.type), `${at}: unknown type ${node.type}`)
  if (node.type === 'object') assert(typeof node.additionalProperties === 'boolean', `${at}: objects state additionalProperties`)
  // KHP A28: a file's declared access controls which host handle an agent may borrow.
  if (node.type === 'file') assert(['read', 'create', 'write'].includes(node.access), `${at}: a file states access read, create, or write`)
  if (node.items) checkNode(node.items, `${at}[]`, false)
  for (const [key, inner] of Object.entries(node.properties ?? {})) checkNode(inner, `${at}.${key}`, true)
}

export { checkNode as checkParameterSchema }
