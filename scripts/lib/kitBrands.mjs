/**
 * Why kits' `ui.brand` colors differ from the palette in kits/kit-colors.json (docs/design.md, Kit
 * colors). `manifests` are `{ source, kitId, brand }`: an in-repo kit.json or a package's kit-ui.json.
 */
export function kitBrandProblems(palette, manifests) {
  const byKitId = new Map(Object.values(palette).filter((entry) => entry && entry.kitId).map((entry) => [entry.kitId, entry]))
  const problems = []
  for (const { source, kitId, brand } of manifests) {
    const entry = byKitId.get(kitId)
    if (!entry) {
      problems.push(`${source}: ${kitId} has no entry in kits/kit-colors.json (scripts/brand/kit_icons.py)`)
      continue
    }
    const expected = JSON.stringify({ light: entry.light, dark: entry.dark })
    if (!brand) problems.push(`${source}: ${kitId} declares no ui.brand; the palette has ${expected}`)
    else if (brand.light !== entry.light || brand.dark !== entry.dark) {
      problems.push(`${source}: ${kitId} declares ${JSON.stringify({ light: brand.light, dark: brand.dark })}; the palette has ${expected}`)
    }
  }
  return problems
}
