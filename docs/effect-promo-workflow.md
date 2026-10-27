# Agent-directed promotional films

Claude and Codex should produce an editable film, inspect its frames, make focused revisions, and
export a verified movie. A passing effects test is only the foundation: it does not establish
storytelling, typography, pacing, asset quality, or a finished soundtrack.

## Shared agent entry point

Both agents can use Kition's existing kit MCP endpoint, `POST /v1/mcp/kits`, or the
`kition-kits-mcp` stdio server. Connection details belong to the person's local configuration;
do not commit credentials or machine-specific paths. See [the kit SDK guide](kit-sdk.md).

Use `effect_inspect`, `effect_commands`, `effect_run`, and `effect_check`. The same commands reach
an open editor through the live bridge, including its undo history. With no editor open, the kit
runs headless. Discover available command parameters from `effect_commands`; the current Effect
command types also appear in `src/lib/sdk/kits/effect.ts` (generated; never edit it).

The repository provides an original four-shot, 12-second production fixture:

- [Recipe builder](../scripts/effect-promo/recipe.mjs): composition, shot timing, editable text,
  original vector artwork, staged entrances, and unique names for revision targets.
- [Workflow benchmark](../scripts/effect-promo/run.mjs): builds it with the shipped engine, checks
  timing and persistence, changes one shot without changing another, undoes that edit, captures
  previews, and exports a proof MP4.

```sh
pnpm test:effect:promo
```

This benchmark needs the shipped Effect package, Playwright Chromium, and `ffprobe`/`ffmpeg` on `PATH`.
The external decoder verifies frame count, delivery metadata, and sampled decoded pixels; it is not bundled
with or linked into Kition. A missing prerequisite fails the benchmark instead of skipping it.

Artifacts appear in `.cache/effect-promo/`, outside the directory Playwright clears between runs:

| Artifact | Purpose |
| --- | --- |
| `Launch.mp4` | 640 x 360, 24 fps, 12-second proof movie |
| `contact-sheet.png` | Inspect engine-rendered composition and text |
| `encoded-shots.png`, `encoded-transitions.png` | Inspect frames decoded from the delivered movie |
| `storyboard.json` | Shot IDs, purpose, and in/out times |
| `tool-calls.json` | Ordered `effect_run` payloads for a 1920 x 1080 editable project |
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
requiring model credentials. Run that gate with `pnpm test:effect:e2e`, or all three layers with
`pnpm test:effect`. The proof movie has no soundtrack, voice-over, stock footage, or actual
product screenshots. It is a reproducible workflow sample, not a finished campaign.

## Product campaign example

`node scripts/effect-promo/campaign.mjs --preview` builds a separate 24-second Kition campaign
from the README's product claims and screenshots. It renders six shots at 1280 x 720, using
editable typography, a vector brand symbol, moving screenshot layers, purple wipes, and an
original synthesized 120 BPM score. Preview artifacts appear in `.cache/kition-campaign/`.
The screenshots illustrate the product; they are not recordings of live interactions.

`node scripts/effect-promo/campaign.mjs` additionally saves the project and media into a new
timestamped `Campaigns/Kition-Launch-*` folder in the running Kition workspace and exports an
H.264/AAC MP4 using Effect itself. It verifies media relinking on reopen, saved project bytes,
decoded shot frames, frame count, duration, and audible, unclipped audio. The editable `.keffect`
and final MP4 are saved through `PUT /v1/kits/files`; the WAV is an ordinary generated media asset.
No existing campaign is replaced. The report records repository-relative source provenance.

The delivery runner defaults to the local macOS Kition profile and loopback API on port 18102.
Set `KITION_API_URL` (including its trailing `/api/v1/`), `KITION_API_TOKEN_FILE`, and
`KITION_CAMPAIGN_WORKSPACE` for another running profile. Tokens are read locally and never emitted
in the artifact or command log. This is a production example, separate from the synthetic regression
fixture above; it is not part of the default test suite and requires a running host to deliver.

## Single-story direction study

See [the implementation explanation](effect-agent-film-implementation.md) for the
asset pipeline, native 3D rig, screenshot reveals, soundtrack, export checks,
and the reasons this treatment still feels like an animated screenshot.

`node scripts/effect-promo/agent-film.mjs --preview` builds a 12-second, 1920 x 1080
study around the README's agent document-review capture. Run without `--preview` to
deliver a new editable project and H.264/AAC movie through the running kit host.
Artifacts and decoded-frame checks appear in `.cache/kition-agent-film/`.

The recipe uses native Effect 3D layers, a parent rig, and a 35 mm camera to move
from the request to the task trace, the changed text, and its review controls.
It studies the macro framing and detail-to-overview movement of
[Linear's Dashboards launch film](https://linear.app/changelog/2025-07-24-dashboards).
No reference-film media is included in the project.

This runner additionally requires the installed `video-shotcraft` skill's audio
assets under `$CODEX_HOME/skills` (default `$HOME/.codex/skills`). It uses four
Mixkit sound-effect cues, with exact source URLs recorded in `audio-cues.json`,
and no music bed. The skill supplies guidance and sound assets; Effect builds
and encodes the film without Effect Craft or Remotion.

This is a direction study, not an accepted commercial-quality baseline. The
task trace is revealed from a completed screenshot, not recorded live. Camera
travel does not demonstrate a before/after edit or a review decision. Encoding,
frame fidelity, audio levels, and save/reopen checks cannot establish persuasive
storytelling or commercial production quality. Evaluate those separately at
playback speed before expanding the treatment into a full campaign.

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
4. Create a new `.keffect` through Kition, then inspect it. The sample recipe requires an empty
   composition; do not clear an existing project to make it fit. Build scene by scene, using
   explicit layer names and retaining editable text, keyframes, masks, and source media.
5. Inspect the rendered shot at its opening, settled state, and exit, then inspect transition
   midpoints. Preview sampled frames with `time.set` through `effect_run`; the tool attaches a
   rendered preview. Watch a low-resolution movie as well: still frames cannot establish rhythm.
6. Revise the identified shot or layer instead of rebuilding the whole project. Compare before/after
   frames, verify adjacent shots remain intact, and keep undo available. Fix clipping, missing media,
   and diagnostics before exporting.
7. Render the delivery specification, inspect the encoded file's duration, frame rate, dimensions,
   and audio streams, and watch the result. Deliver the editable project, media references,
   storyboard, movie, and any unresolved limitations together.

## Tool use and targeted revisions

Every call in `tool-calls.json` has `tool`, `scene`, and `arguments`. Send its **arguments** to
`effect_run` in file order. There are at most 50 commands per call, matching the MCP contract.
These are command payloads, not a replacement document format. Kition saves the project through
its kit host; never reconstruct `.keffect` JSON or write it with a generic filesystem tool.

For example, after building the sample, revise the closing copy and preview that shot:

```json
{
  "path": "Launch.keffect",
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

The [frozen regression corpus](effect-regression.md) covers rendering, expressions, effects,
timing, and basic 3D independently of the reference application. The production fixture adds
multi-shot text/layout, vertical recomposition, targeted revisions, save/reopen, diagnostics,
transition sampling, and decoded MP4 checks. Imported media relinking, audio mixing/ducking,
subtitles, and final 1080p/4K
performance still need dedicated production fixtures; they are not implied by this sample passing.

For a first agent task, provide this guide, a reference video, the product's real assets, and a
brief such as: "Create a 15-second product film. First deliver an editable opening shot and a
preview; then apply the agreed direction to the remaining shots. Keep the project editable and
show the encoded final movie, not only screenshots."
