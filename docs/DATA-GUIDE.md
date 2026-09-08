# Data guide — adding or fixing a release by hand

**Publication rule.** The site shows what the OpenRouter researcher found (`data/models/`,
`origin: researcher` once promoted). Human research goes to `data/gold/` — the frozen answer key
the researcher is graded against — and is never published directly. Fix the gold set when you
find a mistake; then re-run `eval`. See `docs/METHODOLOGY.md` §7 and `worker/README.md`.

## Which directory does my edit go in

| directory | who writes it | what it is for | published |
|---|---|---|---|
| `data/gold/<lab>.json` | humans | the frozen answer key the researcher is graded against — precision, recall, score recall | no, never |
| `data/researched/<lab>.json` | `worker backfill` / `worker arena` | the researcher's raw output, waiting for `eval` and `promote` | no |
| `data/models/<lab>.json` | `worker promote`, or a human hotfix | the live dataset the site reads | yes |

So: **your research belongs in `data/gold/`.** Writing a release straight into `data/models/`
publishes it without the researcher ever having found it, which both hides a researcher failure
and removes the thing the eval was supposed to measure — do it only as a hotfix for something
already live and wrong.

If `eval` lists your release under **unverified extras**, the researcher found something the gold
set lacks and its source is on the lab's own host. Check the source; if it holds, add the release
to `data/gold/<lab>.json` (that is exactly what the list is for) and re-run `eval`. It still
counts against precision on the run that found it — the evaluation is not allowed to excuse
itself — but the key is right from the next run on.

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

## Teaching the researcher a lab's family names (`name_prefixes`)

Labs write their own models' names loosely. A launch post that says "Opus 5 is available today"
made the extractor store a release called *Opus 5*, with the id `anthropic-opus-5` — a different
model, as far as the dataset is concerned, from Anthropic's *Claude Opus 5*.

`data/labs.json` fixes that per lab with `name_prefixes`: an ordered list of
`{ "match": "<regex>", "prefix": "<text>" }`, applied to an extracted name before its id is
built. The first `match` that hits (case-insensitively, on the trimmed name) wins.

```json
"name_prefixes": [
  { "match": "^(opus|sonnet|haiku|fable|mythos)\\b", "prefix": "Claude " }
]
```

Rules to keep in mind when you add one:

- **Prefix only.** It prepends text and can do nothing else. A prefix containing a version number
  is rejected, so a rule can never invent "Claude 5 " out of "Opus 5".
- **Idempotent.** A name that already starts with the prefix is left alone; you will not get
  "Claude Claude Opus 5".
- **Anchor the match.** `^(opus|sonnet|…)\b` — an unanchored pattern will fire on names that
  merely contain the word.
- **A broken rule is skipped, not fatal.** An invalid regular expression is ignored: `labs.json`
  is data, and a typo there must not be able to take the extractor down. That also means a rule
  that silently never fires looks exactly like a typo — test it against a real extracted name.
- The prefix carries its own trailing space (`"Claude "`).

`bun run validate` checks the shape; whether the rule does what you meant is on you.
