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
bun run --filter @agi/web build       # → web/dist (index.html + paper.html)
bun run --filter @agi/web preview     # serve web/dist on http://localhost:4173
```

The build is a **multi-page** build: `index.html` (the chart) and `paper.html` (the standard,
rendered from `docs/PAPER.md` at build time). `vite preview` serves `dist/` only, so a preview
needs `web/dist/latest.json` — copy `data/public/latest.json` there (`bun run bundle` writes it).

## Dev data

`vite.config.ts` registers a **serve-only** plugin that answers `/latest.json`:

1. If `data/models/` contains real lab files (`*.json` not starting with `_`), the bundle is
   assembled **live on every request** from `data/labs.json`, `data/benchmarks.json`, those lab
   files and `data/history/changes.jsonl`, using `buildBundle` from `@agi/shared` — the same
   function the worker uses. It also runs `calibrateForecast` and attaches the resulting
   `backtest` report exactly as `worker bundle` does (rows dropped), so the dev site draws the
   same σ-scaled windows and shows the Backtest card. That takes a few seconds, so it is cached
   against the newest data-file mtime and the current day. Editing any data file triggers a full
   page reload, so the site always mirrors what the data agents have written.
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

> `vite.config.ts` imports `buildBundle`, `calibrateForecast` and `todayISO` through *relative*
> paths (`../shared/src/…`) rather than `@agi/shared`. Vite bundles its config with esbuild and
> externalises bare specifiers, which would leave a `.ts` import for Node to choke on. It is
> still the one real implementation — never a copy. `marked` is a bare specifier and a plain
> npm package, so it is imported by name; it is a **dev** dependency and never reaches the
> browser bundle.

## Architecture

```
index.html            semantic shell + SEO/OG meta; JS only fills the data-driven parts
paper.html            the paper's shell: header, sticky TOC, reading column, print styles
src/main.ts           boot: load → compute → render, and all the control wiring
src/paper.ts          mounts virtual:paper, ids the headings, builds the TOC + scrollspy
src/data.ts           fetch /latest.json, call @agi/shared, shape the view models, memoise per asOf
src/state.ts          Store: asOf, lab filters, selection, hover, view flags (rAF-batched pub/sub)
src/dom.ts            tiny el()/svg()/qs() helpers, reduced-motion + live-region utilities

src/chart/index.ts        the <svg> shell, layer stack, redraw loop, y-domain tween
src/chart/scales.ts       geometry, x/y scales, the adaptive time-tick ladder
src/chart/layers.ts       grid, leadership stripes, lab lines, points, tiers, markers, labels, overlay
src/chart/ladder.ts       the level ladder in the right-hand gutter
src/chart/bands.ts        the per-lab family bands
src/chart/crossings.ts    the frontier trend fan and the predicted level crossings
src/chart/forecast.ts     capability fans, dashed medians, release-window circles
src/chart/backtest.ts     predicted-vs-actual hairlines, drawn while scrubbed
src/chart/pace.ts         the quarterly pace strip under the x axis
src/chart/interaction.ts  d3-zoom, the draggable "now" scrubber, arrow-key traversal, legend
src/chart/tooltip.ts      the floating tooltip and its content builders
src/chart/types.ts        RenderCtx / Interactions contracts + the shared palette constants

src/ui/controls.ts    the control bar: segmented groups, NOW nudge/date pill, mobile sheet
src/ui/shortcuts.ts   the key map and the `?` <dialog> that lists it
src/ui/tour.ts        the four-step first-visit tour (anchored, focus-trapped)
src/ui/progress.ts    the header "next research in …" bar (idle / running / unknown / overdue)
src/ui/intro.ts       header stamp, the three live stats, worker health, notices
src/ui/stages.ts      the Stages column: predicted crossings · NOW · eras · past crossings
src/ui/backtest.ts    the Backtest card (per-lab rows + report + calibration curve)
src/ui/researcher.ts  researcher status, gold-set evaluation, budget
src/ui/watch.ts       release-watch cards (P30/P90 bars, median window, sparkline)
src/ui/rankings.ts    rating-led table with the tier filter and family lines
src/ui/changes.ts     the audit-log feed
src/ui/drawer.ts      the audit drawer / mobile bottom sheet
src/ui/parallax.ts    gyroscope layer parallax (iOS permission pill included)
src/ui/persist.ts     the `agi:view` localStorage key (+ migration of the pre-redesign keys)
src/ui/format.ts      dates, numbers, ratings, percentages, HTML escaping
src/virtual-paper.d.ts  the type of the build-time `virtual:paper` module

src/styles/*.css      base tokens · layout · chart · ui · controls · panels · paper
public/               favicon.svg, og.svg — copied verbatim to dist/
fixtures/             the synthetic dev bundle (never shipped)
```

### Where the maths comes from

Nothing numeric is implemented here. `src/data.ts` calls, and only calls, `@agi/shared`:

| what you see | function |
|---|---|
| θ per model, δ per benchmark, residuals | `fitFrontierIndex` |
| the Frontier Rating on the axis and in the rankings | `ratingFromTheta` |
| the black step line (running maximum), and the headline rating | `frontierLine` |
| “+1.1 logits / yr”, “odds double every 7.3 months” | `frontierVelocity`, `frontierPace` |
| the coloured band under the x axis | `leadershipStripes` |
| the rankings table and its tier filter | `rankCurrentFlagships` |
| the level ladder, the trend, the crossings, the eras | `benchmarkLevels`, `frontierTrend`, `frontierCrossings`, `paceEras` |
| the grey/yellow frontier continuation | `frontierFan` |
| the family bands | `lineupBand` |
| P(30 d), P(90 d), median date, 68 % window, chained releases | `cadencePrior` + `forecastAll` |
| the yellow per-lab fan | `capabilityFan` |
| the Backtest card's per-lab rows | `backtestAsOf` (the report itself is `bundle.backtest`) |
| what exists at a scrubbed date | `releasesAsOf`, `latestPerLab` |

If a shared function throws, `compute()` catches it, the page still renders with empty series,
and a “Compute error” banner names the failure instead of a blank screen.

### The chart

One `<svg>` with fifteen sibling `<g>` layers in a fixed z-order — `grid`, `ladder`, `stripes`,
`bands`, `frontierFan`, `fans`, `lines`, `points`, `tiers`, `markers`, `crossings`, `backtest`,
`labels`, `pace`, `overlay` — so `ui/parallax` can translate each by a different amount (its
`DEPTH` map is typed `Record<LayerName, number>`, so a new layer will not compile until it is
given a depth). The wide fills — `bands`, `frontierFan`, `fans`, `tiers`, `markers`, `crossings`,
`backtest` — are clipped to the plot rect; the others are not, so lab labels and the level ladder
can sit in the right-hand gutter and the stripe band below the axis.

- **x** is time and never ends: the default domain runs from a little before the first release
  (GPT-1, 2018) to today + 3 years, and **Range · Recent 2023→** moves the left edge to the start
  of the modern basket era. Either way `d3-zoom` pans and scales it (wheel, drag, pinch).
  Scrolling *out* at the default zoom is deliberately **not** captured, so the page keeps
  scrolling normally; scrolling *in* zooms.
- **Forecast · Next / Long** is the depth switch. `Next` (the default) shows one release ahead
  per lab; `Long` restores the full chained forecast (up to 24, REDESIGN §4). Flipping it resets
  the zoom, because the base x-domain it was built on has just changed.
- **y is always linear in the latent ability θ** (`chart/scales.ts: makeY`), and **Axis ·
  Rating / Index** only changes what the ticks are labelled with: the unbounded Frontier Rating
  (1000 + 173.72·θ, the default) or the bounded 0–100 Frontier Index. The resting domain is the
  extent of the data and its near fans as of *today* rather than as of the scrubber, so the axis
  does not breathe while dragging; **Fit** tweens it to whatever the legend is currently showing.
  The right-hand gutter carries the **level ladder** — human baselines, saturation points and
  generation ceilings, all fitted from the benchmark difficulties.
- **Pace strip** (`chart/pace.ts`): under the x axis, one bar per calendar quarter, height =
  the frontier's gain in θ that quarter (`frontierGains` in shared), scaled to the largest
  quarter as of today so bars do not re-scale under the scrubber; the trailing-year slope and
  odds-doubling time (`frontierPace`) sit top-right. The “now” rule continues through it.
- **Focus.** Hovering a legend chip, a point, a marker or a forecast sets a focus lab
  (`RenderCtx.focusLab`, from `store.hoverLab` → hovered/selected release's lab → solo). The
  other labs' lines drop to 16 % and their points/labels to 28 % (`DIM_LINE`, `DIM_POINT`), the
  focused line thickens, and the focused lab joins the forecast spotlight.
- **Unscored releases.** A released flagship with no index score at all (GPT-1, the first Kimi)
  has no height, so `drawTicks` puts a 2 px tick in the lab colour on the leadership strip;
  hover explains, click opens the audit drawer.
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
- **Spotlight, not ten fans.** Ten labs forecast into the same three months, so the layer draws
  two tiers (`chart/forecast.ts: spotlightLabs`): the three visible labs with the highest
  P(30 d) — always joined by the focus lab, and all of them when four or fewer are on — get the
  fan, the dashed median and the window circle; every other lab gets a **whisker**, a 1.25 px bar
  from the 16th to the 84th percentile date at its expected index with a dot on the median, at
  55 % opacity, hoverable and focusable with the same tooltip. Same information, a tenth of the
  ink.
- **The default view draws one release ahead, not five.** Each spotlight lab's fan runs from the
  scrubbed date to its own k = 1 `p95Date` + 30 days (`data.ts: nearFanEnd`, kept as
  `LabView.fanNear` beside the full-horizon `fan`); only the k = 1 circle is drawn. **Forecast ·
  Long** restores the full chain (fading with the chain index) for the spotlight labs and the
  long-horizon fans.
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
  index. Under **Forecast · Long** opacity falls with the chain index (1, .7, .5, .35, .25).
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

### Controls, shortcuts and the tour

One **control bar** (`ui/controls.ts`) replaces the old row of pills. Each group is a
`role="radiogroup"` with roving tabindex, a tooltip and a keyboard hint that fades in on hover:

| group | options | key |
|---|---|---|
| Axis | Rating · Index | `R` / `I` |
| Range | Story 2018→ · Recent 2023→ | `S` |
| Forecast | Next · Long | `F` |
| Bands | On · Off | `B` |
| Tiers | Flagship · All | `T` |
| View | Fit · Reset | `0` / `Esc` |
| Now | ◀ · date pill · ▶ · Back to today | `←` `→` (shift = one year) · `Home` |
| — | shortcut sheet | `?` |

`+` / `−` zoom the time axis. The handler ignores every keystroke that starts in an input, a
textarea or a contenteditable (the date pill becomes an `<input type="date">` when clicked), and
while the `?` sheet — a native `<dialog>`, so the focus trap and Escape are the platform's — is
open. Axis, range, forecast, bands and tiers are persisted as one JSON object under **`agi:view`**
(`ui/persist.ts`); the pre-redesign keys `agi:long-range`, `agi:full-history` and `agi:y-scale`
are read once, migrated into it and deleted.

Below 720 px the bar becomes a **bottom sheet** behind a fixed "Controls" button: same groups,
44 px targets, closes on a selection or a tap on the scrim.

The **tour** (`ui/tour.ts`) runs once per browser (`agi:tour`) and is reopened by the header's
"Tour" link. Four steps — the axis, a forecast circle, the NOW rule, Stages — each anchored by
selector *at show-time* and skipped when nothing matches, so an empty dataset cannot point at
a circle that was never drawn.

The header's **progress bar** (`ui/progress.ts`) reads `bundle.worker`: it fills with
`(now − last_run_at) / (next_run_at − last_run_at)`, re-reads the clock every 30 s and on
`visibilitychange`, and has four states — counting down, `Researching · <step>` with an
indeterminate shimmer, "Research schedule unknown" when `next_run_at` is null, and "Research
overdue since …" once it is more than two intervals late.

### The panels

- **Stages** (`ui/stages.ts`) is one column of time read downwards: predicted crossings
  (farthest future first, with their 68 % and 90 % windows), the NOW divider with the projected
  pace regime, the eras newest-first, then the levels already crossed with the model that did it
  (click opens the audit). Hovering a row and hovering the chart's ladder highlight each other
  through `Interactions.hoverLevel`. On the first paint the column is scrolled so NOW sits just
  below the middle; after that the scroll is the reader's.
- **Backtest** (`ui/backtest.ts`) is hidden on today and appears the moment the scrubber moves:
  per-lab predicted-vs-actual rows with a signed day error and a hit badge (68 % green, 90 %
  amber, miss red, "no release yet" grey), then the worker's whole-history report — coverage
  against its nominal targets, MAE / median / bias, θ MAE, the σ scale sentence, the optional
  cadence drift, and an inline calibration curve.
- **Researcher** (`ui/researcher.ts`) publishes the loop's schedule and step, the evaluation
  against the frozen gold set, the budget, and — while `ctx.researched` is false — a notice that
  the published dataset is still the human-curated seed.
- **Rankings** (`ui/rankings.ts`) lead with the rating (± 173.72·se) and carry the tier filter,
  which is bound to the same `store.tierView` the chart uses. Under `All tiers` each lab's best
  row is followed by a family line ("Family: 3 models · band 1 180 – 1 305") built from the lab's
  current lineup.

### The paper page

`/paper.html` renders `docs/PAPER.md`. A Vite plugin exposes it as the virtual module
**`virtual:paper`** (parsed with `marked` at build time — a *dev* dependency, nothing markdown
ships to the browser) and replaces `%PAPER_DESCRIPTION%` in the HTML with the first sentences of
the abstract. `src/paper.ts` mounts the HTML, gives every heading a stable id, builds the sticky
table of contents (the shallowest heading level present becomes the top level — this paper's
sections are `###`) with an `IntersectionObserver` scrollspy, wraps tables in their own
horizontal scroller, and marks external links `target="_blank" rel="noopener"`.
`@media print` drops the header, footer and TOC, blackens the text and sets page margins.

### Accessibility

Semantic landmarks and one `h1`; every interactive element is focusable; chart points are
`role="button"` with a full sentence as their label, and arrow keys walk a lab's own line
(up/down jumps to the nearest point on another lab). Prediction circles carry an invisible
14 px hit-ring so a 2 px stroke is not the only target. The audit drawer is a dialog with
Escape-to-close and focus restore. The control bar's groups are `role="radiogroup"` with roving
tabindex and arrow-key selection, the `?` sheet is a native `<dialog>` (platform focus trap) and
the tour traps Tab across its three buttons. Every state change is announced in the polite live
region (`dom.ts: announce`). Text colours are ≥ 4.5:1 on white — the prediction yellow and the
announced grey are *graphic* colours only and never carry text (`--predict-ink` and
`--announced-ink` are their readable counterparts). `prefers-reduced-motion` disables the
parallax, the scrubber easing, the progress shimmer and every transition.

### Gyroscope parallax

On a device that fires `deviceorientation`, the layers drift by up to ±8 px (grid ±2 … labels
±8), smoothed with a 0.08 lerp. iOS 13+ needs a gesture, so an “Enable motion” pill appears on
the chart until permission is granted. Absent sensors, reduced-motion users and desktops are
untouched — the layers keep an empty transform.

## Conventions

English UI, en-dash for ranges, no emoji. Jost at 200/300 for text and 600 for accents; brand
colours come from `data/labs.json`, prediction yellow is `#F5C400`, announced grey `#9AA0A6`,
text `#111` / `#555`. Keep CSS in `src/styles/*.css`; keep modules small.
