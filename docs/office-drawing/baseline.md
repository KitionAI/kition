# Shared Office Drawing: Frozen Visual Baseline

Status: Phase 0 baseline, measured 2026-10-21. Part of the
[shared office drawing editing plan](../office-editing-unification-plan.md).
Every later report compares against these numbers with the same settings; a
change to the metric, the fonts, or the corpus starts a new baseline instead
of editing this one.

## Settings

| Setting | Value |
| --- | --- |
| Tool | The Slide kit's `kition-slide-visual` reference test (`crates/render/visual/tests/reference.rs`), run optimized |
| Slide kit revision | `cfa3929` (the geometry moved to `kition-drawing` unchanged afterwards) |
| Renderer | `kition-slide-render` 0.5.0, native, clean show-mode render, `macos-aarch64` |
| Fonts | The kit's bundled fonts plus installed system fonts (the renderer's native default) |
| Date fields | Frozen at 2026-01-01 00:00 |
| Image size | The reference's pixel size; no resampling of either image |
| Metric | `slide-visual-metric/2` |
| Strict pass | SSIM ≥ 0.999 and diff ratio ≤ 0.001 (pixels whose largest channel difference exceeds 8) |
| SSIM | Luma (0.299 R + 0.587 G + 0.114 B), 11×11 Gaussian window, σ 1.5, K1 0.01, K2 0.03, valid windows only, full resolution |
| Region check | Worst 32×32 tile SSIM ≥ 0.95 (`pass_local`), reported beside the strict gate |
| Layout gate | The same metric after a σ 2 px blur; reported only, never a substitute for the strict gate |
| References | The PPTX corpus's own `*_PPTX_TO_PNG_WPS` renders |
| Derived decks | Excluded (the corpus's PDF round-trip decks are not reference cases) |

Scorecards and per-case diffs are kept outside the repository in
`$HOME/.cache/kition-fidelity/phase0/` (`slide-shape.json`,
`slide-chart.json`, and the ink scorecard).

## Results

| Set | Cases | Slides | Strict pass | Pass rate | SSIM median | SSIM min | Layout gate pass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shapes | 84 | 12,382 | 133 | 1.07% | 0.96484 | 0.74317 | 150 |
| Charts | 88 | 1,971 | 1 | 0.05% | 0.96453 | 0.69441 | 0 |
| Ink | 1 | 4 | 0 | 0% | 0.98138 | 0.96158 | 0 |

Chart categories: full-property decks 0 of 821 slides pass (SSIM median
0.95213); basic-property decks 1 of 1,102 (median 0.96941). Shape categories
range from 0 passes with medians of 0.948 to 0.979; per-category counts are
in the scorecard.

The required target, 99.9% of required cases at the strict gate, is far from
met. This baseline is the starting point, not a result.

## Renderer and font differences

The strict gate cannot pass where the renderer draws a different font from
the reference. The shape run substituted, among others:

Family names below use English names; exact requested names remain in the local scorecards.

| Requested family | Drawn with |
| --- | --- |
| Microsoft YaHei, SimSun, SimHei, DengXian (including Light), PingFang SC, Source Han Sans (including CN), MiSans, FangZheng XiaoBiaoSong, YouYuan, STZhongsong, KaiTi, PMingLiU, Gulim, Malgun Gothic | Helvetica Neue with Droid Sans Fallback for East Asian text |
| Calibri, Calibri Light | Arial |
| Agency FB, Montserrat, Neris Black | Helvetica Neue |

The kits may not bundle vendor fonts (each kit's asset policy), and the Slide
kit excludes the Source Han and Noto CJK families by policy. Slides whose
text uses these fonts cannot reach SSIM 0.999 until this difference is
resolved. Resolving it is an owner decision, recorded as open:

- **Open decision F1:** how the visual target treats text set in fonts the
  kits cannot ship. Options include measuring with openly licensed,
  metric-compatible substitutes installed for the comparison only, restricting
  the strict gate to slides whose fonts are available, or keeping the gate as
  it is and accepting that these slides stay failing. None of them may loosen
  the metric itself (the plan forbids blur, masking, and looser thresholds).

## Word and Sheet

The Word and Sheet corpora are archives next to the PPTX corpus. Neither kit
has a reference comparison harness, a drawing case list, or a baseline yet.

Sheet's preset outlines moved to the shared catalog on 2026-10-21, before a
Sheet baseline existed. The change is geometry only (fills, pens, text, and
anchors are drawn as before), and the shapes it changes were approximations
(a pentagon from ellipse points, a fixed-ratio star) or not drawn at all (any
preset outside about thirty names fell back to a rectangle). Its unit tests
compare Sheet's outline with the shared catalog's. Phase 1 adds a Sheet and a
Word harness with this page's metric settings, and the first Sheet baseline
is measured on the shared geometry.
