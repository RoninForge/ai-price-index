# Price Sentinel

A zero-dependency, keyless watcher that tells us when a mainstream model is **new** or its price
**moved**, and drafts contribution-form records for the new ones. It never publishes prices on its
own: the default mode is dry-run and writes nothing. `--apply` appends drafted NEW-model records into
`data/records/<provider>.json` and writes a human-readable `sentinel-report.md`, but it never
auto-edits an existing model's price. A human (or the CI workflow) reviews the drafts and validates
them with `tools/validate.mjs` before anything lands.

It exists so the dataset stops drifting silently between manual sweeps.

## Run it

```bash
node tools/sentinel/run.mjs            # dry-run report (default; writes NOTHING)
node tools/sentinel/run.mjs --dry-run  # explicit, identical to the default
node tools/sentinel/run.mjs --json     # the same report as one compact JSON line (still dry-run)
node tools/sentinel/run.mjs --apply    # APPEND drafted NEW-model records into data/records/<provider>.json
                                       #   + write sentinel-report.md (new models, suggested CHANGED edits, errors)

# individual pieces, standalone (each prints JSON):
node tools/sentinel/tripwire.mjs
node tools/sentinel/collectors/anthropic.mjs
node tools/sentinel/collectors/llama.mjs
node tools/sentinel/collectors/amazon.mjs
node tools/sentinel/collectors/mistral.mjs
node tools/sentinel/collectors/deepseek.mjs
node tools/sentinel/collectors/google.mjs
node tools/sentinel/collectors/alibaba.mjs
XAI_API_KEY=... node tools/sentinel/collectors/xai.mjs   # xai needs a free key; BLOCKED without one
```

Deterministic "today" for tests/CI: `AIPI_TODAY=2026-06-20 node tools/sentinel/run.mjs` (same env var
the validator honors).

The xAI collector requires `XAI_API_KEY` (free key from https://console.x.ai). Without it the collector
THROWS a clear `xai BLOCKED: ...` error that `run.mjs` records in `report.errors[]` - a loud, visible
BLOCKED state, never a silent skip and never a crash of the run.

## The report

`run.mjs` prints (dry-run / `--json`):

```jsonc
{
  "generated_at": "YYYY-MM-DD",
  "mode": "dry-run",
  "tripwire_candidates": [ /* advisory NEW/CHANGED from OpenRouter + HuggingFace */ ],
  "new_models":  [ /* models a first-party collector saw that are not in our index (carry effective_from) */ ],
  "price_changes": [ /* known models whose first-party price differs from current.json (LISTED only) */ ],
  "missing_variations": [ /* tracked models whose page carries a rate we publish NO row for (DRAFTED) */ ],
  "drafted_records": [ /* full, valid contribution-form records for the NEW models */ ],
  "errors": [ /* per-stage / per-collector failures; one dead source never kills the run */ ]
}
```

`drafted_records` are built through `makeRecord()`, which throws on any missing field, bad enum,
out-of-bounds price, or future date - so an invalid draft surfaces as an error rather than being
emitted. The sentinel does **not** auto-write bitemporal edits for `price_changes`; they are reported
for a human to action (and, under `--apply`, listed in `sentinel-report.md` as suggested edits).

### Missing variations

`classify()` answers one question: *did a price we already record move?* It deliberately skips any
variation absent from our data (`if (!(variation in have)) continue`), so a model tracked on
input+output alone stayed `UNCHANGED` forever while the collector read its cache and long-context
rates off the same page and threw them away. Found 2026-07-30 with **56 such rows standing** across
anthropic (33), xai (12), openai (8), google (2) and deepseek (1) - the same shape as the xAI
`cache_read` gap fixed three days earlier, which is what made it worth a durable fix instead of a
second one-off backfill.

`missingVariations()` in `lib.mjs` is the detector. It runs on every non-NEW item, independently of
the status branches, because a model can have a CHANGED input rate and an unrecorded cache rate in
the same run. Archived models are excluded by the same guard the NEW path uses.

These are **drafted into `--apply`**, not merely listed like a CHANGED price. A missing variation is
purely additive: no interval is closed and nothing is superseded, so it carries the same risk as a
NEW model's first record, which the sentinel already drafts.

`effective_from` is the **observation date**, never the model's launch date. Adding a rate we have
never recorded is not evidence that it applied when the model shipped, and back-dating it would
assert something nobody verified. Every drafted record says so in its note. Stale-but-labelled is
acceptable; silently back-dated is not.

A related drop lived one layer down: `RECORD_VARIATIONS` in `run.mjs` omitted `tier2_input` /
`tier2_output`, so long-context tiers were dropped even for NEW models. Both are now in the list,
along with `cache_write`, `tier2_cache_read` and `tier2_cache_write`.

`cache_write` is the **untimed** cache-write rate: OpenAI publishes a single "Cache writes" column
with no TTL dimension. It is deliberately separate from Anthropic's `cache_write_5m` /
`cache_write_1h`, because folding it into either would assert a TTL the vendor never stated.

### Untracked models on a provider page

Some collectors gate emission on an allow-list of canonical ids (`openai`, `alibaba`, `amazon`,
`cohere`), because their pages mix per-token text models with audio, image, embedding and dated
snapshot SKUs that must not be mapped by guesswork. The cost of that gate is that a genuinely new
model is not "detected and skipped", it is **invisible**: an unknown name is dropped before
`classify()` ever sees it, so there is nothing to report.

That is how OpenAI's entire `gpt-5.6` family (sol / terra / luna) shipped, sat on the vendor's own
pricing page, and never entered the index.

A collector may now export `getNotices()` alongside `collect()`. `run.mjs` reads it after a
successful collect and files each `untracked_model` notice into `report.untracked_models`, which gets
its own report section and its own term in the CI findings gate. Nothing is drafted: naming a model
is a human call. The decision it asks for is binary, and both answers are cheap:

- add the id to the collector's `TRACKED` set to start recording it, or
- add it to the collector's `KNOWN_UNTRACKED` map with a reason to keep ignoring it.

Leave it undecided and the notice fires again on the next run, which is the intended nag.

### Collector coverage

`openai.mjs` asserts **coverage**: every id in `TRACKED` must have been parsed, unless it is listed in
`PAGE_ABSENT` with a reason. This exists because the failure it catches is a silence rather than a
crash. OpenAI added a "Cache writes" column; the old parser hardcoded three price slots per row, so
the newest models' four-slot rows stopped matching and six tracked models vanished from the
collector's output while it went on reporting success. The gpt-4o PIN still passed, because gpt-4o is
a three-slot row.

Two guards now make that shape of drift loud. The column layout is read from the pricing table's own
**header** (`Input` / `Cached input` / `Cache writes` / `Output`, under a `Short context` /
`Long context` group) rather than assumed by position, and an unrecognised column or group throws
instead of shifting every value one place left. Coverage is then asserted over the result. A
collector that quietly covers less than it claims is worse than one that fails.

### `effective_from` for new models

For a NEW model, `effective_from` is taken from the tripwire's OpenRouter `created` timestamp (the model
launch date, converted to `YYYY-MM-DD`) when a matching tripwire candidate exists for that model id or
alias; otherwise it falls back to `today()`. A future date is clamped to today, and `last_validated_at`
is always today. The policy lives in `lib.mjs::effectiveFromForNew`.

### `--apply` mode

`--apply` is the mode the CI workflow runs. It:

- APPENDS the drafted NEW-model and missing-variation records into the matching
  `data/records/<provider>.json`, creating the file as a JSON array if it does not exist, preserving
  2-space indentation + a single trailing newline. An append that exactly matches an existing record on
  model + variation + `effective_from` + price is skipped, so a run landing in the window between a
  merge and the VPS re-export cannot double-write the same assertion;
- writes a human-readable `sentinel-report.md` (new models drafted, CHANGED prices as suggested edits,
  errors / BLOCKED providers, advisory tripwire candidates) for use as the PR body; and
- prints a one-line summary of what it wrote.

It does **not** auto-edit existing records for CHANGED prices.

## Per-provider source map

| Provider | Source | Kind | Notes |
| --- | --- | --- | --- |
| `anthropic` | `platform.claude.com/.../pricing.md` | first-party (`provider_live`, `verified`) | Clean GFM markdown, no JS/auth. Parsed defensively; **throws** on header/structure drift. |
| `meta-llama` | `together.ai/pricing` | aggregator (`inferred` if scraped clean, else `estimated`) | No first-party Meta price exists. Together is a reference host; every record carries the note "No first-party Meta price; Together AI reference host." |
| `amazon` | AWS Bedrock Price List API | first-party (`provider_live`, `verified`) | Machine-readable bulk JSON, no auth. Nova text models; per-1K -> per-MTok. **Throws** on usagetype-scheme drift. |
| `mistral` | first-party Mistral pricing | first-party | See `collectors/mistral.mjs`. |
| `deepseek` | first-party DeepSeek pricing | first-party | See `collectors/deepseek.mjs`. |
| `google` | first-party Gemini pricing | first-party | See `collectors/google.mjs`. May intermittently drift; lands in `errors[]`, never crashes the run. |
| `alibaba` | first-party Qwen pricing | first-party | See `collectors/alibaba.mjs`. |
| `xai` | `api.x.ai/v1/language-models` | first-party (`provider_live`) | **Requires `XAI_API_KEY`** (free). Without it: a loud `xai BLOCKED: ...` error in `errors[]`, never a crash. |
| OpenRouter | `openrouter.ai/api/v1/models` | **tripwire only** | Keyless. Reseller per-token prices, used as a new/changed signal + the `effective_from` launch-date source, never published. |
| HuggingFace | `huggingface.co/api/models?author=<org>` | **tripwire only** | Keyless. Flags freshly-published open weights from meta-llama / mistralai / deepseek-ai / Qwen. No price implied. |
| `openai` | `developers.openai.com/api/docs/pricing` | first-party (`provider_live`, `verified`) | Standard tier only, selected explicitly by the island's `props.tier`. Reads the rendered table's own column HEADER (labelled, has the long-context tier) and cross-checks it against the island payload (complete, positional). Emission is gated on `TRACKED`; **asserts coverage** and reports untracked models. |
| `cohere` | first-party Cohere pricing | first-party | See `collectors/cohere.mjs`. Also allow-list gated. |
| `ai21` | (deferred) | — | Add as `collectors/<provider>.mjs` and one line in the `COLLECTORS` registry in `run.mjs`. |

Adding a provider: write `collectors/<provider>.mjs` exporting `async function collect()` (return per-model
`{ provider, model_id, prices, unit, source_url, source_kind, confidence, aliases? }`), then add one line
to the `COLLECTORS` array in `run.mjs`. The provider slug must match both what the collector emits and the
`data/records/<provider>.json` file name.

## Design constraints

- **Zero new npm dependencies.** Node ESM `.mjs`, Node >=18, built-in global `fetch`. HTML/markdown
  parsed with string/regex - no cheerio.
- **Fail loud, never guess.** The Anthropic collector throws if its expected table header is missing
  rather than emitting a guessed number.
- **Reseller prices are tripwires, never published.** OpenRouter/HuggingFace output is advisory.
- **Records match the contribution form exactly** (`schema/price-record.schema.json` +
  `tools/validate.mjs`): required fields, valid enums, ISO non-future dates, first-party `source_url`
  + `last_validated_at`.

## Files

- `lib.mjs` - shared helpers: `fetchText` / `fetchJson` (descriptive UA, ~15s timeout, retries),
  `today()`, `loadCurrent()` (alias-aware view of current.json + index.json), price normalization,
  `classify()` (NEW / CHANGED / UNCHANGED), `effectiveFromForNew()` / `unixSecToIsoDate()` (launch-date
  policy for new models), and `makeRecord()` (throws on anything invalid).
- `tripwire.mjs` - `findCandidates()` over OpenRouter + the 4 HF orgs, mapped to our provider slugs.
- `collectors/*.mjs` - first-party collectors: `anthropic`, `llama` (Together reference), `amazon`,
  `mistral`, `deepseek`, `google`, `alibaba`, `xai`.
- `run.mjs` - the orchestrator CLI (default dry-run; `--apply` to draft + write the report).

## CI workflow

`.github/workflows/price-sentinel.yml` is the multi-provider FIRST-PARTY sentinel
(OpenRouter/HF tripwire -> first-party collectors) and the sole price-findings source: it retired the
Anthropic-only `pricing-audit.yml`. It runs twice daily (01:00 + 13:00 UTC) and on manual dispatch,
running `node tools/sentinel/run.mjs --apply`. It keeps ONE rolling draft PR on branch
`sentinel/pending` (created/refreshed/skip-if-unchanged) with `sentinel-report.md` as the body, base
`main`. `XAI_API_KEY` is an optional repo secret; without it the xAI collector reports BLOCKED and every
other provider still runs. `validate.yml` gates the PR.

The LiteLLM aggregator-accuracy ledger that used to ride along in `pricing-audit.yml` now runs on its
own in `.github/workflows/aggregator-accuracy.yml` (commits `data/aggregator-accuracy/litellm.json`
straight to main; opens no PRs).

## Where this is going

Phase 2 adds the headless-rendered pages (OpenAI, Cohere) and `ai21`.
