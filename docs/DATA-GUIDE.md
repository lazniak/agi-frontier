# Data guide — adding or fixing a release by hand

1. Open `data/models/<lab>.json`. One file per lab, schema in `shared/src/schema.ts`.
2. Add a release object (see `data/models/_example.json`). Rules:
   - `id`: `<lab>-<slug>` lowercase, dots allowed: `openai-gpt-5.1`.
   - `date`: public launch date, `date_precision` honest (`month` if you only know the month).
   - `announcement.url`: the lab's own post or model card. `announcement.quote`: a verbatim
     sentence from that page that states the release (≤300 chars).
   - Each `scores[]` entry: `benchmark` from `data/benchmarks.json`, `value` as a percentage,
     `config` as reported, `reported_by: "official"`, `source.url` + `source.quote` verbatim.
     The quote must contain the number.
   - `retrieved_at`: UTC timestamp when you looked, e.g. `2026-09-07T04:00:00Z`.
3. Append a row to `data/history/changes.jsonl`:
   `{"at":"…Z","actor":"manual","lab":"openai","release_id":"openai-gpt-5.1","kind":"release_added","summary":"GPT-5.1 launch post","source_url":"…"}`
4. `bun run validate` must pass. `bun run --filter worker verify --lab openai` re-fetches
   your sources and marks quotes verified.
5. Open a PR with title `data(<lab>): <what>`.

Fetching pages that block bots: `curl -A "Mozilla/5.0" -sL <url>`; if that 403s, use
`https://r.jina.ai/<url>` and set `source.via: "r.jina.ai"`.
