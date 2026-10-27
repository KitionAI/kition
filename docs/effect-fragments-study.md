# Effect study: from fragments to focus

This ten-second Kition brand study chooses a scene that benefits from a compositing engine: a field of extruded pieces rotates in perspective, accelerates into the canonical Kition symbol, catches a light sweep, and settles into a brand lockup. The supplied artwork is one original SVG material plate containing the existing Kition symbol. It is not a rendered animation or a screenshot sequence.

## Why this scene

The earlier line-art film mainly exercised transforms and hierarchy, which HTML/CSS can handle well. Here, Effect's native Shatter effect creates the pieces and evaluates their force, mass variation, rotation, depth, lighting and projection. The recipe does not enumerate per-piece trajectories. The simulation sits inside a nested composition whose time is remapped backwards, with a faster final assembly.

Glow and a Screen-blended Lens Flare complete the compositing stack. The soundtrack is original deterministic synthesis: a low pulse, rising filtered air, an impact at four seconds and a harmonic decay. It does not reuse third-party music.

This is a workflow advantage to investigate, not evidence of an effect that browsers cannot produce. [WebGL supports interactive 2D and 3D rendering in browsers](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API). An HTML implementation can use WebGL and a graphics library; ordinary DOM/CSS animation does not supply this fracture simulation and material pipeline by itself. Neither token savings nor a speed advantage over a matching browser implementation has been measured.

## Timeline

| Time | Action |
| --- | --- |
| 0–2.8 seconds | Fragments drift and turn as the simulation camera approaches its final angle. |
| 2.8–4 seconds | Reverse simulation accelerates into the complete plate. |
| 4–5.2 seconds | Sound impact and optical sweep mark the assembly; faceted lighting resolves to clean artwork. |
| 5.2–7.6 seconds | The same plate moves and shrinks into the brand lockup; type arrives alongside it. |
| 8.5–10 seconds | The complete lockup holds still while the score decays. |

The effect is an authored motion treatment. It is not a measured product-performance claim or a demonstration of collision physics.

## Implementation and verification

- [Recipe](../scripts/effect-promo/fragments-recipe.mjs): native Shatter, simulation camera, materials, nested time remapping, Glow, Lens Flare and typography.
- [Asset generator](../scripts/effect-promo/fragments-assets.mjs): canonical symbol treatment and original stereo score.
- [Runner](../scripts/effect-promo/fragments-film.mjs): packaged WASM engine, allowlisted media, native movie rendering and host saves.
- [Review page](../scripts/effect-promo/fragments-review.mjs): original plate beside the delivered movie and actual browser playback verification.

```sh
node scripts/effect-promo/fragments-film.mjs --preview
node scripts/effect-promo/fragments-film.mjs
node scripts/effect-promo/fragments-review.mjs
```

Output goes to `.cache/effect-fragments/`. Each host export uses a new `Campaigns/Effect-Fragments-*` directory. The editable project is saved through the kit host with relative media paths. The runner verifies diagnostics, exact image equality after reopening, the closing still hold, all 300 encoded frames, sampled decoded pixels, stereo audio and both host-saved file hashes. The report records actual rendering time without comparing it to an unmeasured HTML implementation.

Review exposed excessive faceted highlights on the assembled artwork. The final recipe fades diffuse and specular contributions to zero and ambient contribution to one at simulation time zero. Moving fragments retain lighting; the settled artwork returns to its intended colors.
