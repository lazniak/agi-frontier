# TASKS

Status: `todo` · `doing` · `review` · `done` · `parked`. Claim = set `claimed_by` and push.

| id | task | scope | status | claimed_by |
|---|---|---|---|---|
| T01 | Data contract: types, zod schema, labs.json, benchmarks.json | shared, data | done | main-session |
| T02 | Frontier Index math (Rasch fit, coverage, uncertainty, qualified flag) + tests | shared | done | opus-math |
| T03 | Release prediction math (log-normal cadence, conditional on elapsed time, capability fan) + tests | shared | done | opus-math |
| T04 | Worker: validate / bundle / verify / poll / discover / loop, OpenRouter extraction, git commit | worker | done | opus-worker |
| T05 | Web: chart, intro, release watch, rankings, methodology, mobile gyro parallax | web | done | opus-web |
| T06 | Seed data: 10 labs, primary sources + quotes (90 releases, 313 scores) | data | done | sonnet-data |
| T07 | Deploy: Docker, compose, nginx, certbot, deploy key, first deploy (live 2026-09-07) | deploy | done | main-session |
| T08 | CI: typecheck + test + validate + build on PR | .github | done | main-session |
| T09 | OG image PNG (1200×630) rendered from web/public/og.svg | web | done | main-session |
| T10 | Branch protection on main once bot key is set (allow bot for data/**) | repo | parked | |
| T11 | Web: provisional vs qualified rendering; headline from frontier line | web | done | opus-web |
| T12 | Data coverage where launch pages hide numbers: Grok 4 ✓, Gemini 3.1 Pro ✓, Kimi K3 ✓. Still no official basket numbers anywhere: Fable 5 / 5.1 (system cards drop GPQA as saturated), GLM-5.3, Muse Spark, Mistral Large 3, Grok 4.1/4.5/4.6, Qwen2.5-Max & Qwen3.5–3.7. Re-check when labs publish. | data | doing | |
| T13 | Worker `verify` full pass on seed data (320 verified / 77 unverified, mostly PDFs) | worker, data | done | main-session |
| T14 | Announced entries: add `expected_window` when labs state one (Gemini 3.5 Pro / Gemini 4 / Grok 5 / Qwen4); Grok 5 Q1 2026 window is stale — kept as history | data | todo | |
| T15 | Worker `verify`: extract text from PDF sources (model/system cards) so those quotes can be verified; ~60 of the 77 unverified quotes are PDFs | worker | todo | |
| T16 | Anthropic Opus line continues in parallel to Fable (Opus 4.7 ~Apr 2026, Claude Opus 5 per Fable 5.1 system card comparison table) — add releases with sources | data | todo | |
| T17 | Chart polish: k=1 circles only by default + long-range toggle, lines through qualified points only, label de-confliction, announced markers on trend | web | done | opus-web |
| T18 | Worker: sitemap source kind (z.ai/sitemap.xml lists blog posts; the blog index 404s) | worker, data | todo | |
| T19 | Z.ai `docs.z.ai/release-notes` html parser sees 34 items — confirm the poller detects a new GLM post end-to-end (dry run against a synthetic change) | worker | todo | |
| T20 | Deep history: legacy benchmark tier (LAMBADA, ARC-C, HellaSwag, WinoGrande, GSM8K) + releases back to GPT-1/GPT-2 for all 10 labs (102 releases, 413 scores), anchor recentring on the non-legacy basket | shared, data | done | sonnet-data ×3 |
| T21 | Web: logit y axis (default) with linear toggle, spotlight forecasts (3 labs + focus) with whiskers for the rest, legend-hover focus, pace strip + odds-doubling stat, timeline ticks for unscored releases | shared, web | done | main-session |
| T30 | Redesign · shared maths I: Frontier Rating, weighted Rasch, Elo→p, generations, levels ladder, frontier trend + fan, level crossings, pace eras (REDESIGN §1–2, §9) | shared | done | glm-worker |
| T31 | Redesign · shared maths II: lineup bands, tier filter, infinite forecast/fan, backtest & calibration (REDESIGN §3–5, §9) | shared | done | glm-worker |
| T32 | Redesign · worker: researcher v2 — backfill, arena, eval, promote; retry/backoff + concurrency; state/progress fields; weekly loop steps (REDESIGN §6) | worker | review | glm-worker |
| T33 | Redesign · web chart core: rating axis + ladder, 2-D zoom, family bands, infinite fans + frontier fan, crossings circles, backtest overlay, tier markers (REDESIGN §7.1) | web | done | glm-worker |
| T34 | Redesign · web UI: control bar + shortcuts + tour, next-run progress bar, Stages / Backtest / Researcher panels, rankings with rating + tiers, paper page build (REDESIGN §7.2–7.3) | web | in-progress | glm-worker |
| T35 | Redesign · docs: PAPER.md (the standard, in the user's name), METHODOLOGY/DATA-GUIDE/README updates | docs | done | main-session |
| T36 | Redesign · contract + data: types/schema/bundle, benchmarks generations + weights + lmarena, gold freeze, CLAUDE.md rules | shared, data | done | main-session |
