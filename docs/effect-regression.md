# Effect regression tests

Run the packaged Kition Effect engine against a frozen reference, then exercise its editor inside
Kition. Regular testing needs neither the reference application, its repository, Rust, nor a network
connection. Install repository dependencies and fetch/build the pinned `public/kits/effect-ui/`
package first, as described in [the kit SDK guide](kit-sdk.md).
The separate promotional-film benchmark also uses Playwright Chromium and the external `ffprobe`/`ffmpeg`
decoders; `test:effect:regression` itself still needs only Node and the packaged engine.

```sh
pnpm test:effect                 # Editor integration, frozen regression, and promotional-film workflow
pnpm test:effect:regression      # Engine regression only; Node, no browser
pnpm test:effect:e2e             # Editor integration only; Chromium
```

A missing engine, package manifest, baseline, or required replica capability is a failure, never a
skip. The engine suite writes `test-results/effect-regression/report.json`, including the package
version/commit, WASM SHA-256, reference commit, and individual case results. The combined command
runs the browser first so Playwright's output cleanup cannot remove this report.
Per-frame results include the maximum channel delta and actual image hash. Pixel failures also
write reference and actual `.rgba` files beside the report, with their dimensions recorded there.

## Reference and acceptance criteria

The baseline comes from the unmodified CPU engine at the upstream commit recorded by the Effect
kit's `kit.json`: version `0.7.0`, commit `4b58cd2eb733bdc7ad39161e93dd8e2ff4af6416`.
The capture adapter creates original synthetic projects through its command API. No desktop UI,
external fonts, footage, screenshots, or private user files are involved. These tests compare
engine behavior; they do not claim that the two applications have identical interfaces or that all
effects have been verified.

- [Case definitions](../scripts/effect-regression/cases.mjs) contain the exact ordered commands,
  parameters, sample times, property queries, and checkpoint names.
  [Advanced cases](../scripts/effect-regression/cases-advanced.mjs) extend the corpus with effect
  chains, expressions, nested timing, and basic 3D.
- [Frozen baseline](../scripts/effect-regression/baseline.json) contains reference state and complete
  compressed RGBA frames. Each frame has an integrity hash. The cases and capture adapter are hashed
  too, so a changed test recipe cannot silently reuse a stale baseline.
- Composition fields, layer order, switches, timing, and queried property values must match.
  Numeric tolerance is `1e-9`. Runtime object IDs are normalized while retaining relationships.
- Every RGBA channel of every pixel must differ by at most **1/255** between native reference and
  packaged WASM. No fraction of arbitrarily different pixels is allowed.
- Each checkpoint is checked again after saving and reopening a fresh document. The live document
  remains open so later undo/redo steps still exercise its original history.
- Expected command errors must leave the serialized document unchanged. Unexpected errors fail.
- Expression queries compare the stored value, evaluated value, source, and presence of an error.
  Simple expressions additionally have mathematical expectations independent of the reference
  output. Error wording is not compared across native and WASM JavaScript runtimes.

The baseline is a compatibility contract, not proof that inherited behavior is correct. A confirmed
bug should receive a separate explicit expected-behavior case and a reviewed contract change;
never regenerate expected frames from the implementation under test just to make failures pass.

## Test cases

The corpus contains **46 cases and 181 checkpoints**, checked both live and after reopening
(362 frame comparisons). The pinned package under test is `0.3.17`, commit
`a1aa484a5f2ca1c87fbecc2e654e29530ad272f6`. The original 26 cases and 87 checkpoints are retained
without changing their reference states or frames. All 362 frames matched exactly in the expanded
run. Negative controls confirmed that stale case hashes, a missing case, a two-unit pixel change,
and an incorrect evaluated expression value fail the runner.

All compositions start at 64 by 36 pixels, 30 fps, 10 seconds, with a black background. Each case
starts with a new document; commands and assertions never depend on a preceding case.

| Case | Actions | Expected result |
| --- | --- | --- |
| `composition` | Empty frame, change duration/fps/background, add solid | Settings match; solid covers the full composition |
| `transform` | Position, nonuniform scale, rotation, anchor, opacity | Queried values and transformed coverage match at each step |
| `blend-normal` | Two colored solids, then 50% opacity | Normal compositing and overlap match |
| `blend-multiply` | Same inputs with Multiply | Multiply output and half-opacity output match |
| `blend-screen` | Same inputs with Screen | Screen output and half-opacity output match |
| `blend-add` | Same inputs with Add | Add output and half-opacity output match |
| `blend-difference` | Same inputs with Difference | Difference output and half-opacity output match |
| `opacity-linear` | Keys at 0 and 1 s; forward and backward seeks | Samples at 0, .25, .5, .75, 1 s match; backward seek has no stale frame |
| `position-linear` | Move a green square across the canvas | Five sampled positions and frames match |
| `opacity-hold` | Change opacity keys to Hold | Value remains held until the next key |
| `opacity-ease` | Apply Easy Ease | Five sampled eased values and frames match |
| `mask-rect` | Add, invert, subtract a rectangular mask | Coverage and outside pixels match |
| `mask-ellipse` | Add, invert, subtract an elliptical mask | Curved coverage and edge pixels match |
| `shape-rect` | Create and rotate a filled/stroked rectangle | Shape geometry, fill, and stroke match |
| `shape-ellipse` | Create and rotate an ellipse | Curved geometry and antialiasing match |
| `shape-star` | Create and rotate a star | Concave geometry and antialiasing match |
| `effect-invert` | Apply Invert, disable effects, undo, redo | Each effect/history state reproduces the corresponding frame |
| `effect-blur` | Gaussian Blur at default and nonzero radius | Neutral and blurred frames match |
| `visibility` | Hide the top layer, undo, then solo it | Correct layers contribute pixels in each state |
| `duplicate-history` | Duplicate, move, delete, undo, redo | Layer content/order and pixels survive history changes |
| `precompose` | Nest two layers, undo, redo | Outer pixels remain unchanged; the outer layer structure changes correctly |
| `timing` | Trim a layer to 1-2 s and sample around its boundaries | In point is inclusive; out point is exclusive; reverse seek restores the frame |
| `parenting` | Parent a solid to a null, move the null, attempt a cycle | Child moves with its parent; rejected cycle leaves the document unchanged |
| `matte-alpha` | Assign an alpha matte, reduce matte opacity | Coverage and attenuated pixels match |
| `matte-luma` | Assign a gray luma matte, reduce matte opacity | Luminance and opacity contributions match |
| `invalid-commands` | Unknown command, property, and mask kind | Each rejects; document bytes and rendered frame remain unchanged |
| `effect-tint` | Tint a gradient, customize colors/amount, reset, undo | Pixel mapping and all selected parameters match |
| `effect-exposure` | Change exposure/gamma on a gradient, reset, undo | Tonal values and nested parameters match |
| `effect-posterize` | Quantize a gradient to three levels, reset, undo | Quantization bands and level values match |
| `effect-mosaic` | Change horizontal/vertical blocks, reset, undo | Block boundaries and block counts match |
| `effect-directional-blur` | Set angle and length, reset, undo | Directional edge spread and parameters match |
| `effect-drop-shadow` | Set colored shadow, distance, softness, reset, undo | Offset and soft shadow pixels match |
| `effect-glow` | Change threshold, radius, intensity, reset, undo | Bright-region spread and intensity match |
| `effect-chain` | Fill then Invert, reorder, undo, redo | Noncommuting order changes the output; history restores each order |
| `effect-animated-blur` | Key blur radius and seek in both directions | Animated radius and full frame match at five samples |
| `expression-time` | Evaluate `time * 50` | Evaluated opacity follows composition time, including backward seeks |
| `expression-vector` | Evaluate `[8 + time * 40, 18, 0]` | Numeric position and rendered motion agree |
| `expression-value-toggle` | Evaluate `value * 0.5`, disable, undo | Base value 80 produces 40; disabling restores 80 |
| `expression-loop` | Cycle opacity keys beyond the last key | 1.25 and 2.25 s reproduce the value at .25 s |
| `expression-error-syntax` | Invalid syntax, repair, undo repair | Error is reported; base value is preserved; repair evaluates correctly |
| `expression-error-runtime` | Undefined function call, repair, undo repair | Runtime error falls back without losing the document |
| `time-stretch-50` | Speed nested motion to 50%, undo | Source time, visibility interval, and restored timing match |
| `time-stretch-200` | Slow nested motion to 200%, undo | Source time, visibility interval, and restored timing match |
| `time-reverse` | Reverse nested animation, reverse again | Frames play backward; double reversal restores the original sample |
| `time-remap-freeze` | Freeze at .5 s, sample several times, undo | Frozen frames stay identical; undo restores motion |
| `three-d-transform` | Perspective camera, Y rotation, depth change, undo | Projected geometry, transform values, and history match |

The browser suite additionally covers opening in `KitFrame`, timeline scrubbing, creating a text
layer, dirty state, MP4 export through the host, project save, replica persistence on reopening,
and a file changed externally opening as its new contents. It also builds a four-shot promotional
film in landscape and portrait through external-agent bridge requests, previews and revises it, and checks the saved result.
The [promotional-film workflow](effect-promo-workflow.md) provides a reusable recipe, preview movie,
and production acceptance criteria for both Claude and Codex.

Not yet covered by the frozen corpus: text/font fidelity, scripts, imported media, audio, encoder
fidelity, lighting/shadows and advanced 3D, motion blur, the complete effects registry, and multi-user collaboration.
Existing collaboration tests remain available in `e2e/collab-effect.spec.ts`. Add further synthetic
cases and independently reviewed expectations as these areas become acceptance requirements.

## Deliberate reference maintenance

This is a one-time capture workflow, separate from normal testing. It needs a local reference
repository containing the pinned commit (given in full, 40 hex digits), a compatible Rust toolchain (1.95 or newer), and the
reference engine's Cargo dependencies. It extracts the exact commit into a temporary directory;
it neither checks out nor modifies the reference repository. Compiled reference dependencies are cached
in the system temporary directory, or in an explicit `CARGO_TARGET_DIR`.
The adapter wires the reference expression evaluator and syntax checker into its session; a plain
command session without those services would silently omit expression evaluation.

```sh
node scripts/effect-regression/capture.mjs <reference-repository> <commit> <new-candidate.json>
node scripts/effect-regression/run.mjs <new-candidate.json>
```

Capture writes only a new candidate and refuses to overwrite an existing file. It records the
commit, and the reference engine crate's version when its `Cargo.toml` (or the workspace's) states one. Review case changes,
reference provenance, and frame/state differences before replacing the tracked baseline. Default
tests have no update flag and never call the capture adapter. Once reviewed and committed, the
case definitions and baseline are sufficient for future regressions without the reference source.
