export function isGeneratedImageArtifact(input: {
  kind?: string
  mime_type?: string
  path?: string
}) {
  const path = String(input.path || '')
  return input.kind === 'image'
    || String(input.mime_type || '').startsWith('image/')
    || /\.(?:png|jpe?g|webp|gif|avif)$/i.test(path)
}

export function getGeneratedImageToolOutputPaths(input: {
  output_data?: unknown
  status?: string
  tool_name?: string
}) {
  if (input.tool_name !== 'image_generation' || input.status !== 'completed') {
    return []
  }

  const output = input.output_data
  if (!output || typeof output !== 'object' || Array.isArray(output)) return []
  const record = output as Record<string, unknown>
  const paths = new Set<string>()

  const collect = (candidate: unknown, pathField = false) => {
    if (typeof candidate === 'string') {
      const path = candidate.trim()
      if (path && (pathField || isGeneratedImageArtifact({ path }))) paths.add(path)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => collect(item, pathField))
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    const item = candidate as Record<string, unknown>
    collect(item.path, true)
    collect(item.workspace_path, true)
  }

  collect(record.path, true)
  collect(record.workspace_path, true)
  collect(record.paths, true)
  collect(record.workspace_paths, true)
  const nestedCandidates = [
    record.image,
    record.images,
    record.artifact,
    record.artifacts,
    record.item,
    record.items,
    record.result,
    record.results,
  ]
  nestedCandidates.forEach((candidate) => collect(candidate))
  return Array.from(paths)
}
