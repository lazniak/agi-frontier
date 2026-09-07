# `web/` — the AGI Frontier site

The static front end of **https://agi.pablogfx.com**: Vite 6 + TypeScript + D3 modules, no
framework, no runtime dependency beyond one JSON file.

The site makes **exactly one network request**: `GET /latest.json`. Fonts are self-hosted
(`@fontsource-variable/jost`, bundled as woff2), there is no analytics, no CDN and no
third-party script. Everything on the page — the index fit, the forecasts, the rankings — is
computed in the browser from that single bundle.

## Run it

```bash
bun install                 # at the repo root
bun run --filter @agi/web dev    # http://localhost:5173
```

The dev server serves `/latest.json` itself (see *Dev data* below), so nothing else has to run.

```bash
bun run --filter @agi/web typecheck   # tsc --noEmit (also type-checks ../shared)
bun run --filter @agi/web build       # → web/dist
bun run --filter @agi/web preview     # serve web/dist
```

## Dev data

`vite.config.ts` registers a **serve-only** plugin that answers `/latest.json`:

1. If `data/models/` contains real lab files (`*.json` not starting with `_`), the bundle is
   assembled **live on every request** from `data/labs.json`, `data/benchmarks.json`, those lab
   files and `data/history/changes.jsonl`, using `buildBundle` from `@agi/shared` — the same
   function the worker uses. Editing any data file triggers a full page reload, so the site
   always mirrors what the data agents have written.
2. If there are none, it falls back to **`web/fixtures/latest.json`** — a deterministic
   *synthetic* bundle (10 labs, 43 releases 2023–2026, every release tagged
   `SYNTHETIC FIXTURE — not real data`). The header stamp turns grey and a banner under the
   intro says so, so a fixture build can never be mistaken for the real thing.

Force the fixture even when real data exists:

```bash
AGI_FIXTURE=1 bun run --filter @agi/web dev
```

The plugin is `apply: 'serve'`, and the fixture lives outside `public/`, so **`vite build`
never embeds either one**. In production nginx serves the worker-generated
`data/public/latest.json` at `/latest.json`.

> `vite.config.ts` imports `buildBundle` through a *relative* path (`../shared/src/bundle`)
> rather than `@agi/shared`. Vite bundles its config with esbuild and externalises bare
> specifiers, which would leave a `.ts` import for Node to choke on. It is still the one real
> implementation — never a copy.

## Architecture

```
index.html            semantic shell + SEO/OG meta; JS only fills the data-driven parts
src/main.ts           boot: load → compute → render, and all the control wiring
src/data.ts           fetch /latest.json, call @agi/shared, shape the view models, memoise per asOf
src/state.ts          Store: asOf, lab filters, selection, hover, fit-to-data (rAF-batched pub/sub)
src/dom.ts            tiny el()/svg()/qs() helpers, reduced-motion + live-region utilities

src/chart/index.ts        the <svg> shell, layer stack, redraw loop, y-domain tween
src/chart/scales.ts       geometry, x/y scales, the adaptive time-tick ladder
src/chart/layers.ts       grid, leadership stripes, lab lines, points, markers, end labels, overlay
src/chart/forecast.ts     capability fans, dashed medians, release-window circles
src/chart/interaction.ts  d3-zoom, the draggable "now" scrubber, arrow-key traversal, legend
src/chart/tooltip.ts      the floating tooltip and its content builders
src/chart/types.ts        RenderCtx / Interactions contracts + the shared palette constants

src/ui/intro.ts       header stamp, the three live stats, worker health, notices
src/ui/watch.ts       release-watch cards (P30/P90 bars, median window, sparkline)
src/ui/rankings.ts    current-flagship table with per-benchmark chips
src/ui/changes.ts     the audit-log feed
src/ui/drawer.ts      the audit drawer / mobile bottom sheet
src/ui/parallax.ts    gyroscope layer parallax (iOS permission pill included)
src/ui/format.ts      dates, numbers, percentages, HTML escaping

src/styles/*.css      base tokens · layout · chart · ui   (no Tailwind, no preprocessor)
public/               favicon.svg, og.svg — copied verbatim to dist/
fixtures/             the synthetic dev bundle (never shipped)
```

### Where the maths comes from

Nothing numeric is implemented here. `src/data.ts` calls, and only calls, `@agi/shared`:

| what you see | function |
|---|---|
| Frontier Index per model, δ per benchmark, residuals | `fitFrontierIndex` |
| the black step line (running maximum), and the “Frontier Index today” stat | `frontierLine` |
| “+0.68 pts / mo” | `frontierVelocity` |
| the coloured band under the x axis | `leadershipStripes` |
| the rankings table | `rankCurrentFlagships` |
| P(30 d), P(90 d), median date, 68 % window, chained releases | `cadencePrior` + `forecastAll` |
| the yellow fan | `capabilityFan` |
| what exists at a scrubbed date | `releasesAsOf`, `latestPerLab` |

If a shared function throws, `compute()` catches it, the page still renders with empty series,
and a “Compute error” banner names the failure instead of a blank screen.

### The chart

One `<svg>` with eight sibling `<g>` layers in a fixed z-order — `grid`, `stripes`, `fans`,
`lines`, `points`, `markers`, `labels`, `overlay` — so `ui/parallax` can translate each by a
different amount. `fans` and `markers` are clipped to the plot rect; the others are not, so lab
labels can sit in the right-hand gutter and the stripe band below the axis.

- **x** is time and never ends: the default domain is 2023-01 → today + 12 months, and
  `d3-zoom` pans and scales it (wheel, drag, pinch). Scrolling *out* at the default zoom is
  deliberately **not** captured, so the page keeps scrolling normally; scrolling *in* zooms.
- **“Long-range forecast (3 years)”** is the one view switch. Off (the default) the chart shows
  the *next* release per lab and stops the right edge at today + 12 months; on, it restores the
  full chained forecast and the today + 3 years horizon that matches METHODOLOGY §4. The choice
  is kept in `localStorage` under `agi:long-range`, and flipping it resets the zoom, because the
  base x-domain it was built on has just changed. What each mode draws is listed below.
- **y** is the index, 0–100 by default; “Fit to data” tweens to the range of whatever the
  legend is currently showing (and of whichever fan the toggle has on). The **“Frontier index”**
  caption sits above the plot, flush with the y axis, and a grey **“Saturation of the basket”**
  note marks 100 from inside the plot's top-left, where nothing is ever drawn.
- The **time-tick ladder thins by pixel distance, not by index** (`chart/scales.ts`): a year mark
  is never dropped, and a quarter that would collide with one is. Keeping every n-th tick instead
  is what used to print “Q2” on top of “2024” on a phone.
- The **“now” rule is the time scrubber**. Drag its handle (or use the range input below the
  chart, or focus the handle and press arrow keys) and every number on the page — the fit, the
  frontier, the forecasts, the rankings, the watch cards — is recomputed as of that date.
  “Back to today” eases back over ~0.5 s.
- **Overlapping translucency is composited, not stacked.** Ten labs' fans drawn at 14 % each
  would add up to a solid yellow block, so the fills are opaque inside a group that carries the
  opacity: the union sits at exactly 14 % however many labs are on. Prediction-circle fills use
  the same trick at 10 %; their strokes stay outside it so each window still reads as a ring.
  The future tint right of the “now” rule is a separate 3.2 % wash — deliberately below the fan,
  so the region reads as “after today”, never as a forecast.
- **The default view draws one release ahead, not five.** Each lab's fan runs from the scrubbed
  date to its own k = 1 `p95Date` + 30 days (`data.ts: nearFanEnd`, kept as `LabView.fanNear`
  beside the full-horizon `fan`); its k = 1 circle is drawn in full, k = 2 as a ghost — dashed
  1 px, 30 % opacity, no fill — and k ≥ 3 not at all. Chained out to three years, ten labs put
  fifty circles and ten full-width fans in the same corner and the future became one yellow
  blob. The long-range toggle brings all of it back.
- The **k = 1 circle of the lab with the highest P(30 d)** carries a soft yellow halo (25 %,
  a 6 px blur from a `feGaussianBlur` filter the chart shell puts in `<defs>`), so the eye lands
  on the release the cadence model actually expects first.
- **Qualified vs provisional** (METHODOLOGY §3) is drawn everywhere the index is shown. A release
  with fewer than `MIN_QUALIFIED_SCORES` index benchmarks (`fit.models[id].qualified === false`) is
  a **hollow point** — white fill, 1.5 px lab-colour stroke — and its tooltip says how many of the
  basket it reported. **The lab line joins qualified releases only** (`LabView.qualified`), so a
  provisional point floats off the line rather than dragging the curve down to a number the index
  never measured; a lab with fewer than two qualified releases gets no line at all, just its
  points. Whisker, hover and selected states are unchanged. `fill` and `stroke` are set as
  presentation attributes in `chart/layers.ts`
  precisely because CSS would beat them; only `stroke-width` and the selected ring live in
  `chart.css`. Downstream: the rankings table breaks the two groups with a divider row (rank
  numbers keep counting), badges the model and drops its rows to `--ink-2`; the release-watch card
  badges a provisional flagship and links to `docs/DATA-GUIDE.md`; the audit drawer badges the
  header and names the missing index benchmarks as grey chips.
- Each predicted release is a **true circle** whose *diameter* is the pixel distance from
  `p16Date` to `p84Date` (clamped 8–160 px, and to 16 % of the plot width and 60 % of the plot
  height, so a circle can never swallow the axis), centred on the median date at the expected
  index. In the long-range view opacity falls with the chain index (1, .7, .5, .35, .25).
  Announced-sourced predictions are grey instead of yellow.
- **Announced / rumored / cancelled markers have no scores**, so their height is *indicative* and
  is chosen to be the least misleading value available (`chart/layers.ts: markerLevel`): the k = 1
  predicted index for a future date, the lab's last qualified index before that date for a past
  one, otherwise the frontier at that date. They are never placed on the lab line, and both the
  tooltip and the accessible name say the position is indicative.
- **End-labels are de-conflicted, not just drawn.** They follow each lab's *last qualified*
  release (where the line actually ends), are sorted by y and pushed apart to ≥ 13 px keeping
  their order, then clamped against the bottom and top edges; a label displaced by more than 6 px
  gets a hairline leader back to its line end. Below 560 px they are dropped altogether and the
  right-hand gutter collapses with them, and a lab switched off in the legend loses its label
  with the rest of its series.

### Accessibility

Semantic landmarks and one `h1`; every interactive element is focusable; chart points are
`role="button"` with a full sentence as their label, and arrow keys walk a lab's own line
(up/down jumps to the nearest point on another lab). Prediction circles carry an invisible
14 px hit-ring so a 2 px stroke is not the only target. The audit drawer is a dialog with
Escape-to-close and focus restore. Text colours are ≥ 4.5:1 on white — the prediction yellow
and the announced grey are *graphic* colours only and never carry text (`--predict-ink` and
`--announced-ink` are their readable counterparts). `prefers-reduced-motion` disables the
parallax, the scrubber easing and every transition.

### Gyroscope parallax

On a device that fires `deviceorientation`, the layers drift by up to ±8 px (grid ±2 … labels
±8), smoothed with a 0.08 lerp. iOS 13+ needs a gesture, so an “Enable motion” pill appears on
the chart until permission is granted. Absent sensors, reduced-motion users and desktops are
untouched — the layers keep an empty transform.

## Conventions

English UI, en-dash for ranges, no emoji. Jost at 200/300 for text and 600 for accents; brand
colours come from `data/labs.json`, prediction yellow is `#F5C400`, announced grey `#9AA0A6`,
text `#111` / `#555`. Keep CSS in `src/styles/*.css`; keep modules small.
