# Agent-directed promotional films

Claude and Codex should produce an editable film, inspect its frames, make focused revisions, and
export a verified movie. A passing effects test is only the foundation: it does not establish
storytelling, typography, pacing, asset quality, or a finished soundtrack.

## Shared agent entry point

Both agents can use Kition's existing kit MCP endpoint, `POST /v1/mcp/kits`, or the
`kition-kits-mcp` stdio server. Connection details belong to the person's local configuration;
do not commit credentials or machine-specific paths. See [the kit module guide](kits.md).

Use `motion_inspect`, `motion_commands`, `motion_run`, and `motion_check`. The same commands reach
an open editor through the live bridge, including its undo history. With no editor open, the kit
runs headless. Discover available command parameters from `motion_commands`; the current Motion
command types also appear in `src/lib/script/kits/motion.ts` (generated; never edit it).

The repository provides an original four-shot, 12-second production fixture:

- [Recipe builder](../scripts/motion-promo/recipe.mjs): composition, shot timing, editable text,
  original vector artwork, staged entrances, and unique names for revision targets.
- [Workflow benchmark](../scripts/motion-promo/run.mjs): builds it with the shipped engine, checks
  timing and persistence, changes one shot without changing another, undoes that edit, captures
  previews, and exports a proof MP4.

```sh
pnpm test:motion:promo
```

This benchmark needs the shipped Motion package, Playwright Chromium, and `ffprobe`/`ffmpeg` on `PATH`.
The external decoder verifies frame count, delivery metadata, and sampled decoded pixels; it is not bundled
with or linked into Kition. A missing prerequisite fails the benchmark instead of skipping it.

Artifacts appear in `.cache/motion-promo/`, outside the directory Playwright clears between runs:

| Artifact | Purpose |
| --- | --- |
| `Launch.mp4` | 640 x 360, 24 fps, 12-second proof movie |
| `contact-sheet.png` | Inspect engine-rendered composition and text |
| `encoded-shots.png`, `encoded-transitions.png` | Inspect frames decoded from the delivered movie |
| `storyboard.json` | Shot IDs, purpose, and in/out times |
| `tool-calls.json` | Ordered `motion_run` payloads for a 1920 x 1080 editable project |
| `report.json` | Engine/movie hashes, timing, layers, decoded pixel errors, and workflow checks |
| `portrait/` | The same artifacts for a recomposed 360 x 640 proof and 1080 x 1920 tool payloads |

Both variants have 36 named editable layers and four shots. Portrait stacks the cards and steps,
changes text wrapping, and positions the CTA for a tall frame. It does not crop the landscape movie.
Each variant checks 17 sampled frames: five held shots (including the last movie frame) and four
frames around each of three cuts. The cuts intentionally fade through white. Save/reopen must
preserve all samples exactly; the decoded H.264 samples must match within fixed lossy-codec limits:
mean RGB error <= 4, foreground mean <= 12, and 99th-percentile channel error <= 32 (8-bit units).
Foreground includes pixels where either image has a channel below 240, preventing white margins
from hiding lost content. Wrong-scene and blank-output negative controls must fail these limits.
These checks cover selected frames, not every frame or perceptual pacing; watch the movies too.
Full-resolution payloads are generated but full-resolution rendering is not benchmarked here.

The benchmark executes the real packaged engine and validates the tool payload size; it does not
launch Claude/Codex or establish a live MCP connection. The browser gate additionally sends the
landscape and portrait recipes through the live editor bridge, requests before/after previews, revises a named text layer,
and verifies the project saved through the host. It models an external agent's requests without
requiring model credentials. Run that gate with `pnpm test:motion:e2e`, or all three layers with
`pnpm test:motion`. The proof movie has no soundtrack, voice-over, stock footage, or actual
product screenshots. It is a reproducible workflow sample, not a finished campaign.

## From brief to an editable film

1. Establish the product, audience, one central message, destination/aspect ratio, duration, CTA,
   and supplied reference links. Record which visual traits to follow: type scale, composition,
   movement, transitions, color, and rhythm. If references are absent, state a provisional direction
   and make a short proof before committing to an entire film.
2. Write a shot list with exact time ranges, the viewer's takeaway, on-screen copy, media, movement,
   and narration/sound cues. Give each shot a stable ID. Pace to the message; avoid transitions
   that compete with reading the copy or seeing the product.
3. Inventory assets with their provenance and intended shot. Use real product captures for claims
   about product behavior. Generated imagery may provide atmosphere; it should not impersonate a
   real feature demonstration. Keep assets in the workspace and import them through the kit's host.
4. Create a new `.kmotion` through Kition, then inspect it. The sample recipe requires an empty
   composition; do not clear an existing project to make it fit. Build scene by scene, using
   explicit layer names and retaining editable text, keyframes, masks, and source media.
5. Inspect the rendered shot at its opening, settled state, and exit, then inspect transition
   midpoints. Preview sampled frames with `time.set` through `motion_run`; the tool attaches a
   rendered preview. Watch a low-resolution movie as well: still frames cannot establish rhythm.
6. Revise the identified shot or layer instead of rebuilding the whole project. Compare before/after
   frames, verify adjacent shots remain intact, and keep undo available. Fix clipping, missing media,
   and diagnostics before exporting.
7. Render the delivery specification, inspect the encoded file's duration, frame rate, dimensions,
   and audio streams, and watch the result. Deliver the editable project, media references,
   storyboard, movie, and any unresolved limitations together.

## Tool use and targeted revisions

Every call in `tool-calls.json` has `tool`, `scene`, and `arguments`. Send its **arguments** to
`motion_run` in file order. There are at most 50 commands per call, matching the MCP contract.
These are command payloads, not a replacement document format. Kition saves the project through
its kit host; never reconstruct `.kmotion` JSON or write it with a generic filesystem tool.

For example, after building the sample, revise the closing copy and preview that shot:

```json
{
  "path": "Launch.kmotion",
  "steps": [
    {
      "command": "layer.setText",
      "params": {
        "layer": "promo.closing.headline",
        "text": "Make your next move."
      }
    },
    { "command": "time.set", "params": { "time": 10.5 } }
  ],
  "save": true
}
```

Keep scene selection separate from saving a rendered movie. In the embedded editor, the existing
Render MP4 action invokes `renderMovie`, then writes the result through the host. For headless
export, discover `renderQueue.add` and `renderQueue.render`, choose a new workspace-relative output
path, wait for completion, and inspect the reported output. Do not infer successful delivery from
the existence of a queued render.

## Acceptance criteria for campaign work

| Area | Evidence needed |
| --- | --- |
| Message | Each shot supports the brief; the final CTA is legible and held long enough |
| Art direction | Inspected reference board and frames; consistent type, color, spacing, imagery |
| Product truth | Supplied real captures support feature claims; illustrative graphics are identified |
| Motion | Watched transitions, stagger, easing, and holds at actual playback speed |
| Revision | A requested copy/color/timing change affects its target and preserves adjacent shots |
| Persistence | Reopening the editable project reproduces frames and maintains source references |
| Audio | Narration, music, cues, sync, and level checked in the encoded output when requested |
| Delivery | Encoded resolution, frame rate, duration, codec, and streams match the destination |

The [frozen regression corpus](motion-regression.md) covers rendering, expressions, effects,
timing, and basic 3D independently of the reference application. The production fixture adds
multi-shot text/layout, vertical recomposition, targeted revisions, save/reopen, diagnostics,
transition sampling, and decoded MP4 checks. Imported media relinking, audio mixing/ducking,
subtitles, and final 1080p/4K
performance still need dedicated production fixtures; they are not implied by this sample passing.

For a first agent task, provide this guide, a reference video, the product's real assets, and a
brief such as: "Create a 15-second product film. First deliver an editable opening shot and a
preview; then apply the agreed direction to the remaining shots. Keep the project editable and
show the encoded final movie, not only screenshots."
