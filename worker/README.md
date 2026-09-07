# worker — AGI Frontier automation

The only part of the system that talks to the network or writes `data/`.

It polls every lab source hourly, notices when a page changed, asks an LLM to extract flagship
releases and benchmark scores **with verbatim quotes**, throws away anything whose quote is not
literally on the page, merges what survives into `data/models/<lab>.json`, re-validates, rebuilds
`data/public/latest.json`, and (optionally) commits and pushes.

Runs on Bun (`oven/bun:1-alpine` in Docker). TypeScript is executed directly — there is no build step.

## Commands

Run from the repo root:

```bash
bun run worker/src/cli.ts validate                       # zod + cross-file checks on data/
bun run worker/src/cli.ts bundle                         # write data/public/latest.json
bun run worker/src/cli.ts verify [--lab id] [--only-unverified] [--limit N]
bun run worker/src/cli.ts poll   [--lab id] [--dry-run]
bun run worker/src/cli.ts discover [--lab id] [--dry-run]
bun run worker/src/cli.ts loop
```

Or through the package scripts, using the workspace name (`--filter worker` does not match in
bun 1.3): `bun run --filter '@agi/worker' validate|bundle|verify|poll|discover|loop`.

| command | what it does | exit code |
|---|---|---|
| `validate` | Loads `labs.json`, `benchmarks.json`, `models/*.json` (skipping `_`-prefixed templates) and `history/changes.jsonl`. Validates against the shared zod schemas and cross-checks benchmark ids, lab ids, file names, release ids duplicated across files and `changes.jsonl` rows. Prints warnings, errors and a one-line summary. | 1 on any error |
| `bundle` | `buildBundle(...)` + the worker's own run state → `data/public/latest.json`, 2-space JSON. Schema-checked before it is written. | 1 if the bundle would be invalid |
| `verify` | Re-fetches every `Source` in every lab file — `announcement`, each `sources[]`, each `score.source`, `expected_window.source` — and checks that `quote` is still a substring of the page. Writes `verified` / `verified_at` back, appends one `verified` ChangeEvent per release, and prints a table of everything that did **not** verify. | 0 (it reports, it does not gate) |
| `poll` | The hourly job. See the pipeline below. | 1 if any source failed or a merge had to be rolled back |
| `discover` | Once a day: asks an `:online` model what each lab shipped in the last 45 days, then re-derives everything from the primary page it points at. | 1 on errors |
| `loop` | `poll` on a timer, `discover` once per 24 h, structured JSON logs, graceful SIGTERM. | 0 |

`--dry-run` on `poll` does everything except writing files and calling the LLM: it fetches, parses,
diffs and prints the candidate table. It needs no API key, which makes it the fastest way to check
whether a source in `labs.json` still works.

## The poll pipeline

```
 for each lab, for each source in labs.json
   │
   ├─ fetch  (browser UA, 20 s timeout, 2 retries, 1 req/s per host)
   │     └─ 403 / blocked / empty  →  retry via https://r.jina.ai/<url>, remember via="r.jina.ai"
   │
   ├─ extract items          rss: <item>/<entry> · html: anchors + headings (hrefs resolved)
   │                         hf-org: model ids + lastModified · json: passthrough
   │                         (proxy output is Markdown — parsed as such)
   │
   ├─ sha256(item list)  vs  worker/.state/hashes.json
   │     ├─ first sight       →  record the baseline, extract nothing        ─╮
   │     ├─ hash unchanged    →  skip (logged)                                ├─ no LLM call
   │     └─ changed           →  keep only items whose link/id is new         ─╯
   │
   ├─ candidate filter (no LLM): flagship_hints regexes, else generic keywords
   │     (introducing, announcing, model, release, GPT, Claude, Gemini, Grok,
   │      Llama, DeepSeek, Qwen, Kimi, GLM, Mistral). Hint matches rank first.
   │
   ├─ for each candidate, up to MAX_LLM_CALLS_PER_RUN
   │     ├─ fetch the item page
   │     ├─ OpenRouter chat/completions, response_format json_schema (strict),
   │     │    falling back to json_object + zod if the model refuses the schema
   │     ├─ zod-validate the response
   │     └─ RE-CHECK EVERY QUOTE against the fetched page text
   │           · announcement quote not found      →  drop the whole release
   │           · score quote not found             →  drop the score
   │           · score quote without its own number→  drop the score
   │           · benchmark outside the basket      →  drop the score
   │           · released without a date, or dated in the future → drop the release
   │
   ├─ merge into data/models/<lab>.json
   │     · match by normalised name (case/space-insensitive)
   │     · new      → id `<lab>-<slug>`, retrieved_at now, quote marked verified
   │     · existing → add missing scores (benchmark+config), upgrade the status
   │                  (announced → released, never backwards, never touching
   │                   `cancelled`), sharpen the date only when precision improves
   │     · append ChangeEvents; releases sorted by date; 2-space JSON
   │
   ├─ write → run `validate` → on ANY error restore the previous bytes and log
   │          (data/ is never left failing validation)
   │
   ├─ bundle → data/public/latest.json
   ├─ state  → worker/.state/state.json (last_run_at, last_success_at, pages_polled,
   │            pages_changed, llm_model) — these show up in the site footer
   └─ GIT_PUSH=1 → git add data && commit as the bot → pull --rebase → push
                   (on a rebase conflict: abort, log, keep the commit for next run)
```

`discover` reuses the second half of that pipeline. Items whose URL is on the lab's own domain go
through the normal extraction. Items from elsewhere are only accepted from an allowlist
(reuters, bloomberg, theinformation, techcrunch, cnbc, theverge, wired, ft, wsj, nytimes, axios,
semafor), can only ever produce a `rumored` entry, and never contribute a score — press coverage is
not an official number.

## Cost

Only changed pages trigger LLM calls, and within a changed page only genuinely new items do.

| stage | cost |
|---|---|
| fetch + parse + hash | free, ~24 requests per run |
| unchanged source | free — no LLM call at all |
| first sight of a source | free — the baseline is recorded, nothing is extracted |
| already-seen item | free |
| non-candidate item | free |
| candidate item | 1 chat completion, ~15–20k input tokens (page truncated to 60k chars), small JSON out |
| `discover` | 1 web-search call per lab per day, plus 1 extraction per accepted item |

A steady-state hour is normally **zero** LLM calls: nothing shipped, so no hash moved.
A launch day costs a handful. `MAX_LLM_CALLS_PER_RUN` (default 20) bounds the worst case — a site
redesign that changes every URL at once. Raise it only if you are watching the bill.

The default model is `google/gemini-2.5-flash-lite`; the id in use is recorded in
`latest.json → worker.llm_model` so the site can state which model produced a row. At startup the
worker fetches `GET /api/v1/models` and warns if the configured id is not in the catalogue.

## State

`worker/.state/` (git-ignored):

| file | contents |
|---|---|
| `state.json` | `last_run_at`, `last_success_at`, `pages_polled`, `pages_changed`, `llm_model`, `last_discover_at` |
| `hashes.json` | per source: last item-list hash, `checked_at`, `changed_at`, and the item keys already processed (capped at 1200) |
| `pages/<sha1>.txt` | fetched page text with a JSON header line (`url`, `fetched_at`, `status`, `via`) |

Delete `hashes.json` and the next poll re-baselines every source without extracting anything;
delete `state.json` and the footer's health numbers reset. Neither loses data.

## Environment

See [`.env.example`](./.env.example). Nothing here is required for `validate`, `bundle`, `verify`
or `poll --dry-run`; `OPENROUTER_API_KEY` is required for real `poll` and `discover` runs.

## Guarantees this code is built around

- **No quote, no data.** Every date, status and score written to `data/` carries a quote that was
  checked as a substring of the page the worker actually fetched, after NFKC normalisation, quote
  and dash folding, whitespace collapsing and case folding. The same normaliser is used by
  `verify`, so an entry that stops matching later shows up in the unverified table.
- **Idempotent.** Running the same extraction twice produces a byte-identical file and no new
  ChangeEvents. `updated_at` only moves when something actually changed.
- **Never invalid.** Every write is followed by `validate`; a failure restores the previous bytes
  and drops the pending ChangeEvents.
- **Monotonic.** Statuses move `rumored → announced → released` and never backwards; `cancelled`
  is never set or cleared automatically; dates only become more precise; scores are added, never
  overwritten; history is append-only.

## Tests

```bash
cd worker && bun run typecheck && bun test
```

No network: the fetcher takes an injected `fetch`, the OpenRouter client takes one too, and git
takes an injected runner. Coverage is on the parts that decide what reaches `data/` — the
normaliser and quote matching, hashing and state diffing, feed/HTML/Markdown/HF parsing, the
candidate filter, extraction post-validation, merge idempotence and monotonicity, the rollback,
slug generation and the commit-message builder.
