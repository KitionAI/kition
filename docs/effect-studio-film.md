# Kition: One brief, a whole team

This revision is a twenty-second product visualization rendered by Kition Effect.
It replaces the earlier fracture study with one connected scene: a brief releases
three workstreams, their documents become tangible objects, and those same objects
form the four parts of the canonical Kition mark.

## Reference measurement

The local Copilot creator-portfolio cut has 1,676 frames at 24 fps. Frame extraction
preserves that cadence. The useful picture runs approximately 1.0–44.375 seconds;
the remaining black tail is excluded from the study. This is not the 96-second
YouTube upload. Source: [Andrew Falk's project page](https://hexaflexagon-lilac-nh4w.squarespace.com/work/copilot-launch).

At reference frame 192 (8 seconds), the prompt occupies almost the full horizontal
field, with its right side outside the crop. Frame 240 (10 seconds) is an optical
transition, and frame 288 (12 seconds) reveals the prompt inside a larger workspace.
The first adaptation used a 72-frame macro-to-overview move; revision 2 uses 66
frames between the macro hold and overview. The reference's 26.667-second
cut and 41.125-second white end transition are detectable at a scene-change
threshold of 0.3; many intervening changes are spatial moves rather than hard cuts.

The borrowed grammar is macro framing, forward and backward depth travel, one
continuous object across transitions, and a short final hold. No reference picture,
audio, Microsoft mark, or interface artwork appears in the delivered film.

## Timeline

| Frames at 24 fps | Action |
| --- | --- |
| 0–48 | An oblique macro of a brief and its raised action button holds with a slow drift. |
| 48–114 | The camera pulls back as three sculptural workstreams unfold behind the brief. |
| 114–288 | The camera travels across research, design, and launch-plan objects, with a reading interval for each. |
| 288–342 | The outputs gather in one shared space. |
| 342–402 | The brief and three output surfaces reshape into the Kition mark. |
| 402–480 | The complete mark and wordmark settle; the score resolves. |

The interface is a condensed promotional visualization, not a screen recording or
a claim about execution speed. The roles and example campaign are illustrative.

## Implementation

- `studio-recipe.mjs`: native 3D shapes, extrusion, bevels, lighting, camera
  animation with tracked focus, parent transforms, and content animations.
- `studio-ribbon.mjs`: original closed ribbon meshes and PBR materials in glTF.
- `studio-assets.mjs`: original vector stage and graphic artwork, a twenty-second
  edit of Lily J's House Vibez, and provenance for local Mixkit recordings.
- `studio-film.mjs`: packaged Effect WASM rendering, visual checkpoints, native
  movie export, project reopen checks, host saves, and decoded media verification.

Commands run from the repository root:

```sh
node scripts/effect-promo/studio-film.mjs --preview
node scripts/effect-promo/studio-film.mjs
```

The first delivered cut and local reference analysis stay in `.cache/effect-studio/`.
Revision 2 stays in `.cache/effect-studio-v2/`. The current revision writes to
`.cache/effect-studio-v3/`, preserving both baselines.
Editable documents and exports are saved through the Kition kit host into a fresh
campaign directory. Rendering uses the actual Effect engine; no browser-recorded
animation or imported finished animation supplies the picture.

## Revision 2: reading time and continuity

Review of the first export found four concrete problems: the opening crop cut off
the prompt, the research chart completed after the camera had left it, neighbouring
objects competed with the active deliverable, and content disappeared too early
during the closing morph.

| Area | Previous cut | Revised cut |
| --- | --- | --- |
| Opening | Text extended outside the frame. | The complete prompt fits inside the macro framing. |
| Research | The last chart bar finished at frame 193. | It is fully sampled at frame 144, inside the reading interval at frames 138–162. |
| Reading intervals | The camera immediately continued to the next card. | Each deliverable gets 24 frames of slow drift, separated by 24-frame travel. |
| Neighbours | Full-size cards and the brief occupied the macro shots. | Other cards reduce to 76% scale and retreat by up to 260 depth units; the brief moves above the field. |
| Type | Titles were 31 units and status labels 12. | Titles are 36 and status labels 15; main headlines grow from 48 to 58. |
| Morph | Content faded during frames 324–354; shape resizing started at 342. | Content remains until frame 350 and fades through 369 while resizing runs 354–390. |
| Sound | Cues used file start times. | Measured 50 ms RMS peaks align with the physical moves, with brief music ducks. |

The measured sound offsets are 0.40 seconds for the air transition, 0.25 seconds
for the small sweep, and 0.10 seconds for the bass impact. The three camera-travel
peaks land at 5.25, 7.25, and 9.25 seconds. Music keeps its final 1.8-second fade.
Track identity and licensing remain in the generated audio provenance report.

`studio-review.mjs` decodes all 480 frames and checks for empty/black frames and
unexpected repeated frames before the intentional closing hold. It also measures
decoded audio for clipping, quiet gaps, and the ending fade. These checks establish
technical integrity; they do not certify artistic quality. The existing checks
still compare native and encoded checkpoints, reopen the editable project, and
verify saved project and movie hashes through the host.

The generated `compare.html` plays both versions from the same position, with
only the revised soundtrack audible. It supports frame stepping and named review
moments. On small screens the two players stack vertically. The original film is
referenced by its sibling cache directory, not duplicated or overwritten.

## Revision 3: animated artwork and separated assembly

The second cut had a visible typography defect: the poster title entered from a
lower baseline and briefly overlapped its subtitle in the overview. The revised
poster uses a stacked title on the left, an original rotating torus sculpture on
the right. Small decorative copy and the footer rule are removed. The title enters
from above. The full
sculpture sits in front of the poster plane throughout its rotation, avoiding the
clipped back half found in the first revision-3 preview. It is generated as glTF by
`orbitModel` and animated with native Effect model transforms.

The camera now uses monotone cubic Hermite interpolation. Adjacent segments retain
their tangents through the reading intervals; turning points and the final hold
stop deliberately. Each coordinate stays within its neighbouring key values.
This removes repeated zero-speed joins while preserving the twenty-second edit.

During the final assembly, the three deliverables shrink to their mark dimensions
by frame 378 while moving toward separate staging positions. The small pieces
then converge through frame 402. The brief follows its own leftward route. The
closing impact peaks at frame 402, and the wordmark, promise, and domain settle
before the verified hold at frame 432. The generated comparison page references
revision 2, so each pair compares consecutive edits.

Validation includes the overview title bounds, full rotation of the
sculpture without intersection with its backing plane, frame-stepped closing
assembly, phone-size frames, native/encoded image comparisons, all-frame and audio
integrity checks, project reopen checks, and synchronized playback to the end.
