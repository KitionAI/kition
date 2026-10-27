# Kition agent film implementation

The current sample is a 12-second product animation built by issuing commands to
Kition's packaged Effect WebAssembly engine. A real product screenshot supplies
the interface; editable layers, a 3D parent rig, typography, and sound effects
turn it into a movie. It is a reconstruction of a completed agent task, not a
recording of an agent editing a document.

This explains both the working pipeline and its visual limit: the renderer can
reproduce the animation, but most of the product itself remains a flat, static
image. The sample has not been accepted as a commercially finished film.

## Components and responsibilities

| Component | Responsibility in this sample |
| --- | --- |
| Coding agent | Authors the story, composition recipe, timing, and revisions |
| Video Shotcraft skill | Supplies production guidance and bundled sound assets; it does not render this film |
| Motion From Reference skill | Guides reference analysis and continuous motion design |
| Node.js runner | Loads assets and the packaged engine, executes commands, checks output, and saves through the host |
| Effect WASM engine | Maintains editable layers, evaluates keyframes, renders pixels, and exports the H.264/AAC movie |
| Kition host | Persists the project, image assets, and movie in a new workspace folder |
| FFmpeg and ffprobe | Prepare the soundtrack and independently decode and inspect the exported movie |
| Playwright Chromium | Assembles preview sheets; a separate delivery check verifies browser playback |

Neither Effect Craft nor Remotion participates in this sample's build or export.
The recipe is authored JavaScript, not a prompt interpreted by the renderer.
Running it does not invoke Claude, Codex, or a model API. Although Kition also
exposes Effect commands through its kit MCP interface, this runner directly
calls the same packaged engine from Node.js; it does not exercise an MCP session.

The skill's installed name is `video-shotcraft`. It is an external authoring
resource, not a Kition product module. Its current runtime dependency here is
the audio asset directory under `$CODEX_HOME/skills`, defaulting to
`$HOME/.codex/skills`.

## Source files and data flow

| File | What to inspect |
| --- | --- |
| [agent-film.mjs](../scripts/effect-promo/agent-film.mjs) | Asset loading, engine setup, previews, persistence, export, validation |
| [agent-film-recipe.mjs](../scripts/effect-promo/agent-film-recipe.mjs) | Layer construction, motion keyframes, captions, branding |
| [agent-film-audio.mjs](../scripts/effect-promo/agent-film-audio.mjs) | Sound sources, cue times, mixing, WAV generation |
| [delivery.mjs](../scripts/effect-promo/delivery.mjs) | Decoded-frame comparisons and contact sheets |
| [Product capture](readme/agent-document-diff-review.webp) | The single source image containing the request, trace, and diff |

The processing order is:

```text
Product capture + brand SVG + generated gradients + sound assets
    -> allowlisted media map and prepared WAV
    -> EffectDocument + recipe commands
    -> editable layers and time-based property keys
    -> preview frames + save/reopen comparison
    -> host-saved .keffect and media
    -> Effect renderMovie
    -> independent MP4 checks
    -> host-saved MP4 and local report
```

The engine is loaded from `public/kits/effect-ui/engine/`. A `kitionHost` adapter
implements `size` and `readRange` over an allowlisted map of media bytes. Imported
paths such as `media/agent-review.webp` resolve through that adapter. They are
relative asset references, not embedded workstation paths.

The central API calls are:

```js
const doc = sdk.EffectDocument.create('Kition-Agent-Film.keffect', 1920, 1080)
doc.execute(command, JSON.stringify(params))
doc.render(0, 0, zoom, width, height)
doc.save()
doc.renderMovie('Kition-Agent-Film.mp4', 'h264')
```

`time.set` selects the composition time before a still render. `save()` supplies
project bytes; the runner sends those bytes to the kit host for persistence.

## How the apparent camera movement works

The recipe creates a native 35 mm camera and a 3D null layer named
`camera.product-rig`. The screenshot, its frame, trace covers, and change
highlight are parented to this rig. The camera itself stays fixed. The recipe
animates the rig's anchor, position, scale, and three rotation axes, making the
product plane appear to move under the camera.

The `focus` coordinates identify a point in the original screenshot, such as
the request bubble or review controls. Assigning that point to the rig's anchor
changes the pivot. Position places it in the composition; scale controls the
apparent proximity; X and Y rotation introduce perspective. Z rotation tilts
the frame in the screen plane.

This is 2.5D presentation: a flat image sits in a 3D composition. Small depth
offsets place the frame, covers, and highlight around it. There is no reconstructed
3D application, animated DOM, material simulation, depth-of-field treatment, or
explicit motion-blur pass in this recipe.

The following ranges describe the continuous rig motion, not separate clips:

| Approximate time | Visual focus | Implementation |
| --- | --- | --- |
| 0–1.5 s | User request | Close, tilted product plane; scale falls from 400% to 370% |
| 1.5–4.3 s | Agent task trace | Anchor travels down the right panel; trace rows are revealed |
| 4.3–7.1 s | Document changes | Rig moves toward the left panel and settles at 200% scale |
| 7.1–9.0 s | Accept and reject controls | Anchor approaches the review buttons; scale reaches 300%, then 290% |
| 9.0–10.6 s | Product overview and brand | Rig returns to the screenshot center and shrinks to 68% |
| 10.6–12.0 s | Closing hold | Product pose holds while the closing typography finishes appearing |

Each segment uses a clamped smoothstep interpolation:

```text
u = clamp((frame - startFrame) / (endFrame - startFrame), 0, 1)
progress = u * u * (3 - 2 * u)
value = startValue + (endValue - startValue) * progress
```

The runner bakes these values into native property keys every two frames at
30 fps. Every segment eases toward rest at its endpoints. This is predictable
but can produce a repeated move-and-settle rhythm; it is not a measured match
to a reference film's velocity. The composition renders frames 0–359, while a
key at frame 360 defines the 12-second endpoint.

## What actually changes inside the picture

The screenshot already contains the completed task and its red/green diff.
Eight rectangular shape layers cover task-trace rows. Each cover fades out
over five frames, with successive starts five frames apart. The first starts
at frame 54; all rows are revealed by frame 94. This exposes existing pixels;
it does not execute tools or generate new trace text.

A translucent green shape grows horizontally over one changed line. It draws
attention to that line without changing the document. Accept and reject buttons
are visible in the later framing, but neither is clicked and no accepted state
is shown.

The composition has 25 layers including its camera, rig, and audio layer.
Captions and brand text are separate editable text layers. The gradient stage,
caption shade, frame, and overlays are separate assets or shapes. Individual
words and controls inside the product capture remain raster pixels and cannot
be edited as text or UI objects in the Effect project.

## Typography and sound

Four 57 px captions introduce the request, agent work, review, and user control.
Their opacity fades and short vertical entrances run independently of the
product rig, keeping the captions in screen space. The opening label disappears
before the task-trace close-up. The ending combines the brand symbol, a 112 px
wordmark, a 42 px promise, and a 32 px URL.

The soundtrack consists of four timed Mixkit sound effects, with no music bed
or voice-over:

| Cue start | Sound | Source duration used |
| --- | --- | --- |
| 0.05 s | Air zoom | 1.5 s |
| 4.50 s | Fast sweep | 0.8 s |
| 7.40 s | Short bass hit | 1.5 s |
| 9.25 s | Air zoom | 1.7 s |

FFmpeg trims each source, resets its timestamps, applies a 0.3-second fade-out,
sets gain, delays it to its cue, mixes it over 12 seconds of silence, and limits
the result. The output is a 48 kHz stereo PCM WAV. Effect imports that WAV as an
audio-only layer and encodes the final movie with AAC audio. Source URLs and
the license label are recorded in `audio-cues.json`.

The code retains names such as `music` and `soundtrack.original-score`; these
names do not imply that this sample contains an original musical score. Its
sounds currently emphasize transitions, not typing, tool execution, or a
demonstrated review decision.

## Persistence and reproducibility

From the repository root, generate previews with:

```sh
node scripts/effect-promo/agent-film.mjs --preview
```

Deliver the editable project and movie with:

```sh
node scripts/effect-promo/agent-film.mjs
```

Both modes need the shipped Effect package, repository dependencies, Playwright
Chromium, FFmpeg, and the installed skill's sound assets. Full delivery also
needs ffprobe and a running Kition host. Defaults target the local macOS Kition
profile and `http://127.0.0.1:18102/api/v1/`. Overrides are
`KITION_API_URL`, `KITION_API_TOKEN_FILE`, and `KITION_CAMPAIGN_WORKSPACE`.
The workspace override must match the running host's active workspace.

Full delivery creates a new `Campaigns/Kition-Agent-Film-<timestamp>/` folder.
Images, the `.keffect` document, and the final MP4 are saved using
`PUT /api/v1/kits/files`. The WAV is written as an ordinary media asset after the
host creates the folder. Existing campaigns are preserved. The editable project
needs its accompanying `media/` directory; copying only the `.keffect` file does
not make a self-contained delivery.

Local previews and reports are regenerated under `.cache/kition-agent-film/`:

| Artifact | Purpose |
| --- | --- |
| `storyboard.png` | Six engine-rendered preview frames |
| `encoded-storyboard.png` | The corresponding decoded movie frames |
| `commands.json` | Recorded engine command sequence |
| `storyboard.json`, `brief.json` | Timing, sources, intended treatment, limitations |
| `audio-cues.json` | Timed sounds and source URLs |
| `report.json` | Delivered file hashes, dimensions, frames, audio levels, pixel errors |
| `Kition-Agent-Film.mp4` | Local copy of the exported movie |

`playback.json` was produced by a separate browser delivery check; the main
runner does not currently regenerate it. A failed rerun may leave older cached
files, so use a successful exit and the new report's hashes and workspace folder
to identify the delivered version.

## What the checks prove

The runner checks diagnostics, unique layer names, distinct checkpoint frames,
and exact frame reproduction after saving and reopening the project. It compares
the host-saved project bytes with the in-memory project and verifies that movie
rendering does not alter the project.

The exported movie must contain 360 frames at 1920 x 1080 and 30 fps, an AAC
audio stream, and a duration within 0.1 seconds of 12 seconds. Six samples at
1, 3.2, 5.7, 7, 9, and 11.2 seconds are independently decoded. Their RGB error
limits are mean <= 4, foreground mean <= 12, and 99th percentile <= 32 on an
8-bit scale. On this dark film, the foreground mask includes nearly all pixels.
Audio RMS must exceed 0.005 and peak amplitude must stay below 1; these checks
detect weak or clipped signals, not a satisfying mix.

The inspected delivery contained 25 layers, 4,888 recorded commands, 360 frames,
and a 22,287,203-byte MP4. Container duration was 12.01 seconds. A separate browser
check advanced playback beyond one second and decoded 43 frames without a video
error. These are delivery checks, not a complete viewing or listening assessment.

## Why it still feels like an animated screenshot

The dominant movement is the product plane changing position, angle, and scale.
The product does not visibly progress from an initial document to an edit and
then to an accepted result. Captions describe a process whose state transitions
are mostly absent. Repeated smoothstep stops and a long return to the overview
can further resemble a presentation moving between focal points.

The dense capture also creates a framing tradeoff: showing complete changes and
their controls makes text smaller; enlarging text crops the surrounding context.
Sound sweeps reinforce camera movement but provide little evidence of product
action. None of these weaknesses is resolved by passing an encoding test.

The reference treatment studied was
[Linear's Dashboards launch film](https://linear.app/changelog/2025-07-24-dashboards).
No Linear media is included. This implementation borrows a direction—close
product framing, oblique travel, and an overview reveal—without implementing a
frame-matched recreation.

For a subsequent iteration, the missing input is a controlled sequence of
product states: an initial document, the submitted request, visible edits,
a review choice, and its resulting document. Those could come from real captures
or a faithful, explicitly identified reconstruction. Individual product elements
would then drive the motion and sound. Judge a short opening at playback speed
before expanding the film. This is proposed work, not functionality already
present in this recipe.

See [the production workflow](effect-promo-workflow.md) for the broader authoring
process and [the regression guide](effect-regression.md) for engine correctness
tests independent of this film's visual quality.
