# Data guide — adding or fixing a release by hand

**Publication rule.** The site shows what the OpenRouter researcher found (`data/models/`,
`origin: researcher` once promoted). Human research goes to `data/gold/` — the frozen answer key
the researcher is graded against — and is never published directly. Fix the gold set when you
find a mistake; then re-run `eval`. See `docs/METHODOLOGY.md` §7 and `worker/README.md`.

1. Open `data/gold/<lab>.json` (or `data/models/<lab>.json` for a hotfix of what is live).
   One file per lab, schema in `shared/src/schema.ts`.
2. Add a release object (see `data/models/_example.json`). Rules:
   - `id`: `<lab>-<slug>` lowercase, dots allowed: `openai-gpt-5.1`.
   - `tier`: `flagship` (default when absent), `mid` (Sonnet / Flash / mini class) or `small`
     (Haiku / Flash-Lite / nano class). Every tier may be recorded; only flagships form the
     frontier line and the cadence, the rest draw the family band.
   - `date`: public launch date, `date_precision` honest (`month` if you only know the month).
   - `announcement.url`: the lab's own post or model card. `announcement.quote`: a verbatim
     sentence from that page that states the release (≤300 chars).
   - Each `scores[]` entry: `benchmark` from `data/benchmarks.json`, `value` in the benchmark's
     unit (a percentage, or an Elo for `lmarena-text`), `config` as reported,
     `reported_by: "official"` (`maintainer` for LMArena and other leaderboards), `source.url` +
     `source.quote` verbatim. The quote must contain the number. `validate` rejects values
     outside the benchmark's `min`/`max`.
   - `retrieved_at`: UTC timestamp when you looked, e.g. `2026-09-07T04:00:00Z`.
   - Early models: the legacy tier (`lambada`, `arc-challenge`, `hellaswag`, `winogrande`,
     `mmlu`, `humaneval`, `math`, `gsm8k`) is there so 2019–2024 releases can be fitted. A
     release with no index score at all is fine — it is drawn as a tick on the timeline.
   - Papers: prefer the ar5iv HTML mirror (`https://ar5iv.labs.arxiv.org/html/<id>`) over the
     PDF so `verify` can check the quote.
3. Append a row to `data/history/changes.jsonl`:
   `{"at":"…Z","actor":"manual","lab":"openai","release_id":"openai-gpt-5.1","kind":"release_added","summary":"GPT-5.1 launch post","source_url":"…"}`
4. `bun run validate` must pass. `bun run --filter @agi/worker verify --lab openai` re-fetches
   your sources and marks quotes verified.
5. Open a PR with title `data(<lab>): <what>`.

Fetching pages that block bots: `curl -A "Mozilla/5.0" -sL <url>`; if that 403s, use
`https://r.jina.ai/<url>` and set `source.via: "r.jina.ai"`.
