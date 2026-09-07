# TASKS

Status: `todo` · `doing` · `review` · `done` · `parked`. Claim = set `claimed_by` and push.

| id | task | scope | status | claimed_by |
|---|---|---|---|---|
| T01 | Data contract: types, zod schema, labs.json, benchmarks.json | shared, data | done | main-session |
| T02 | Frontier Index math (Rasch fit, coverage, uncertainty, qualified flag) + tests | shared | done | opus-math |
| T03 | Release prediction math (log-normal cadence, conditional on elapsed time, capability fan) + tests | shared | done | opus-math |
| T04 | Worker: validate / bundle / verify / poll / discover / loop, OpenRouter extraction, git commit | worker | doing | opus-worker |
| T05 | Web: chart (pan/zoom, scrubber, fans, circles, audit drawer), intro, release watch, rankings, methodology, mobile gyro parallax | web | doing | opus-web |
| T06 | Seed data: 10 labs, primary sources + quotes | data | doing (9/10, anthropic pending) | sonnet-data |
| T07 | Deploy: Docker, compose, nginx, certbot, deploy key, first deploy | deploy | doing (infra done, first deploy after T04/T05) | main-session |
| T08 | CI: typecheck + test + validate + build on PR | .github | done | main-session |
| T09 | OG image PNG (1200×630) rendered from web/public/og.svg | web | todo | |
| T10 | Branch protection on main once bot key is set (allow bot for data/**) | repo | parked | |
| T11 | Web: render `ModelIndex.qualified=false` as hollow marker + "provisional" badge; rankings list provisional after qualified | web | todo | |
| T12 | Data coverage gaps where launch pages hide numbers in images/JS charts: Grok 4 / 4.1 / 4.6 (x.ai React payload), Gemini 3.1 Pro (model-card image tables), Qwen2.5-Max & Qwen3.5–3.7-Max (image tables), Mistral Large 3 (image benchmarks), Muse Spark. Approach: headless browser text extraction or official PDFs; still official-only. | data | todo | |
| T13 | Worker `verify` full pass on seed data → mark `verified` flags; list quotes that fail | worker, data | todo | |
| T14 | Gemini 3.5 Pro / Gemini 4 / Grok 5 / Qwen4 announced entries: add `expected_window` when labs state one; Grok 5 window (Q1 2026) is stale — keep as history, notes explain | data | todo | |
