# Price Sentinel (Round 1 PoC)

A zero-dependency, keyless watcher that tells us when a mainstream model is **new** or its price
**moved**, and drafts contribution-form records for the new ones. It never publishes prices on its
own: the default mode is dry-run and writes nothing. A human (or the orchestrator's CI step) reviews
the drafts and validates them with `tools/validate.mjs` before anything lands in `data/records/`.

It exists so the dataset stops drifting silently between manual sweeps.

## Run it

```bash
node tools/sentinel/run.mjs            # dry-run report (default; writes NOTHING)
node tools/sentinel/run.mjs --dry-run  # explicit, identical to the default
node tools/sentinel/run.mjs --json     # the same report as one compact JSON line

# individual pieces, standalone (each prints JSON):
node tools/sentinel/tripwire.mjs
node tools/sentinel/collectors/anthropic.mjs
node tools/sentinel/collectors/llama.mjs
```

Deterministic "today" for tests/CI: `AIPI_TODAY=2026-06-20 node tools/sentinel/run.mjs` (same env var
the validator honors).

## The report

`run.mjs` prints:

```jsonc
{
  "generated_at": "YYYY-MM-DD",
  "mode": "dry-run",
  "tripwire_candidates": [ /* advisory NEW/CHANGED from OpenRouter + HuggingFace */ ],
  "new_models":  [ /* models a first-party collector saw that are not in our index */ ],
  "price_changes": [ /* known models whose first-party price differs from current.json (LISTED only) */ ],
  "drafted_records": [ /* full, valid contribution-form records for the NEW models */ ],
  "errors": [ /* per-stage / per-collector failures; one dead source never kills the run */ ]
}
```

`drafted_records` are built through `makeRecord()`, which throws on any missing field, bad enum,
out-of-bounds price, or future date - so an invalid draft surfaces as an error rather than being
emitted. Round 1 does **not** auto-write bitemporal edits for `price_changes`; they are reported for a
human to action.

## Per-provider source map

| Provider | Round 1 source | Kind | Notes |
| --- | --- | --- | --- |
| `anthropic` | `platform.claude.com/.../pricing.md` | first-party (`provider_live`, `verified`) | Clean GFM markdown, no JS/auth. Parsed defensively; **throws** on header/structure drift. |
| `meta-llama` | `together.ai/pricing` | aggregator (`inferred` if scraped clean, else `estimated`) | No first-party Meta price exists. Together is a reference host; every record carries the note "No first-party Meta price; Together AI reference host." All Llama models are NEW (no `meta-llama` in the index yet). |
| OpenRouter | `openrouter.ai/api/v1/models` | **tripwire only** | Keyless. Reseller per-token prices, used solely as a new/changed signal + sanity cross-check, never published. |
| HuggingFace | `huggingface.co/api/models?author=<org>` | **tripwire only** | Keyless. Flags freshly-published open weights from meta-llama / mistralai / deepseek-ai / Qwen. No price implied. |
| `openai`, `cohere` | (deferred) | — | Pricing pages need headless rendering. **Phase 2.** |
| `xai` | (deferred) | — | First-party price needs a free API key. **Round 2.** |
| `google`, `mistral`, `deepseek`, `amazon`, `alibaba`, `ai21` | (deferred) | — | Add as `collectors/<provider>.mjs` and one line in the `COLLECTORS` registry in `run.mjs`. |

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
  `classify()` (NEW / CHANGED / UNCHANGED), and `makeRecord()` (throws on anything invalid).
- `tripwire.mjs` - `findCandidates()` over OpenRouter + the 4 HF orgs, mapped to our provider slugs.
- `collectors/anthropic.mjs` - first-party Claude prices from `pricing.md`.
- `collectors/llama.mjs` - Together-reference Llama prices, clearly labelled.
- `run.mjs` - the orchestrator CLI (default dry-run).

## Where this is going

The orchestrator wires `run.mjs` into a scheduled CI workflow (daily). The job posts the report and,
for clean `drafted_records`, opens a PR that adds them to `data/records/<provider>.json` for human
review + the existing `tools/validate.mjs` gate. Round 2 adds the xAI collector (free key) and more
provider collectors; Phase 2 adds the headless-rendered pages (OpenAI, Cohere).
