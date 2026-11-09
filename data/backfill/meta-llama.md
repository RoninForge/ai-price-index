# Backfill log: Meta (Llama)

Meta publishes open weights, not a hosted API price, so there is no first-party Meta price. The
`meta-llama` records price each model at Together AI as a designated reference host, always
`source_kind: aggregator` (or `wayback` for an archived capture of Together's page), with the note
"No first-party Meta price; Together AI reference host." Prices are USD per 1M tokens.

## 2026-11-09: Together removals, every interval closed

Together's deprecations page (https://docs.together.ai/docs/deprecations), section "Deprecation
history" > "Inference", headed "The table below lists all models removed from serverless inference,
most recent first", lists all five tracked models (columns: Removal date | Model | Supported by
on-demand dedicated endpoints):

| Removal date | Together model id | Dedicated | our `model_id` |
| --- | --- | --- | --- |
| 2026-02-06 | `meta-llama/Llama-4-Scout-17B-16E-Instruct` | Yes | llama-4-scout |
| 2026-02-06 | `meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo` | No | llama-3.1-405b |
| 2026-03-06 | `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` | Yes | llama-3.1-8b |
| 2026-03-31 | `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | Yes | llama-4-maverick |
| 2026-10-22 | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Yes | llama-3.3-70b |

The same page: "After the removal date, the model is no longer available via its serverless
endpoint". On-demand dedicated endpoints are "Charged on a price-per-minute basis", so they are not a
per-token successor price. Together's model and pricing pages kept displaying these prices after
removal (the 2026-03-02 capture of together.ai/pricing still lists Llama 3.1 405B at $3.50); the
deprecations page says "If a listed model returns unavailable or disabled errors, treat the runtime
API behavior and this page as the source of truth."

### Intervals closed at the removal date

| model | input | output | before | after |
| --- | --- | --- | --- | --- |
| llama-4-scout | 0.18 | 0.59 | 2025-04-05 -> open | 2025-04-05 -> 2026-02-06 |
| llama-4-maverick | 0.27 | 0.85 | 2025-04-05 -> open | 2025-04-05 -> 2026-03-31 |
| llama-3.3-70b | 1.04 | 1.04 | 2026-06-22 -> open | 2026-06-22 -> 2026-10-22 |

Provenance (source, confidence, `last_validated_at`) is unchanged on these rows; only the valid-time
end is new. Scout and Maverick serverless prices are corroborated by Wayback captures of
together.ai/pricing from 20250408012901 through 20260110114657 ($0.18/$0.59 and $0.27/$0.85).

### Corrected: llama-3.1-405b and llama-3.1-8b

Both rows were created 2026-06-22 as open intervals starting 2026-06-22, read from Together pages
that still showed a price. Together had removed both models before that date, so the rows asserted a
serverless price that did not exist during their whole interval; closing them at the removal date
would have inverted the interval. They are corrected, per METHODOLOGY ("Corrections supersede; they
never silently delete" and "A correction closes the prior assertion and inserts a new one"): the
2026-06-22 assertions are replaced by Wayback-backed intervals that end at the removal date. The
system of record supersedes the old rows on the next seed, so they stay in the audit trail.

| model | price (in = out) | before | after | evidence |
| --- | --- | --- | --- | --- |
| llama-3.1-405b | 3.50 | 2026-06-22 -> open, together.ai/pricing, `inferred` | 2024-09-27 -> 2026-02-06, `wayback` / `archived` | capture 20240927025044 |
| llama-3.1-8b | 0.18 | 2026-06-22 -> open, together.ai/models/llama-3-1-8b-instruct-turbo, `inferred` | 2024-08-12 -> 2026-03-06, `wayback` / `archived` | capture 20240812095045 |

- **effective_from is a capture date, not a change date.** Per METHODOLOGY's backfill rule, the row
  gets `source_snapshot_ts` and a `last_validated_at` equal to the evidence date. For 405B, the
  previous capture (20240922053205) shows "405B | TURBO | $5.00", so the cut to $3.50 happened between
  2024-09-22 and 2024-09-27; the $5.00 launch interval is not recorded. For 8B, the previous capture
  (20240725130005) has no Llama 3.1 table at all.
- **One price for input and output.** The Serverless Endpoints table states "Prices are per 1 million
  tokens including input and output tokens"; the later per-model table lists "Llama 3.1 405B | Llama |
  $3.50 | $3.50" and "Llama 3.1 8B | Llama | $0.18 | $0.18" (capture 20260130191400).
- **Checked captures.** One digest-distinct capture per month from 2024-09 through 2025-08 shows
  "405B | Text | TURBO | $3.50" and "8B | Text | LITE | $0.10 | TURBO | $0.18"; 20260130191400 and
  20260210173839 show the same two prices in the per-model table. The 2025-09 to 2025-12 captures use a
  different layout that our extraction did not match for these two rows, and were not read by hand.

### Not recorded

Together's pricing page shows Llama 3.3 70B at $0.88 / $0.88 in captures up to 20260302180711 and at
$1.04 / $1.04 from 20260621120924. The record keeps its 2026-06-22 start (our observation date); the
$0.88 era and the exact day of the change are not backfilled here.

### Collector

`tools/sentinel/collectors/llama.mjs` was removed. It published hard-coded Together figures guarded by
an OpenRouter reseller floor/ceiling check; with no tracked model left on Together's serverless
platform it had nothing true to emit, and an empty collector reports as broken every run. Tripwire hits
for the five models are skipped as archived because no interval is open.
