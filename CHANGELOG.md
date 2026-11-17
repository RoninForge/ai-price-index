# Changelog

Per-release record of price additions and corrections (supersedes), so the history of what changed
and why is auditable. Hand-maintained for now (the export bot cuts the release tags + the
`data/ai-price-index/` artifacts; this file is updated alongside coverage work). Full provenance for
every price lives in `data/backfill/<provider>.md` and in each record's `source_url` /
`last_validated_at`.

## Engine: per-request prompt-length tiers (Claude Haiku 5.5) - 2026-11-17

- New `usdForRequest` / `usdForRequestRaw`: price ONE request and bill it entirely at the `tier2_*`
  rates when its prompt (input + cache read + cache writes) is over the provider's threshold.
  `PROMPT_TIER_THRESHOLDS` lists only published thresholds: `anthropic` 100,000 tokens (Claude Haiku
  5.5). Also exported: `tier2RateAt`, `promptTokens`.
- `usdForRollup` / `usdForRollupRaw` are unchanged: a rollup cannot show which requests crossed the
  threshold, so it prices at the base tier and is a lower bound for a tiered model.
- `examples/pricing-vectors.json`: each vector is now defined as one request, and two Haiku 5.5
  vectors pin the boundary (exactly 100,000 prompt tokens stays base; over it bills at tier2).
  BudgetClaw's `CostForModelAt` already reproduces both.

## New models: Gemini 4 Carbon, Gemini 4 Hydrogen, Qwen4-Max; openai collector repaired - 2026-11-16

- `google` gemini-4-carbon: $2.00 input / $10.00 output / $0.10 cached input, effective 2026-11-10
  (GA per the Gemini API release notes). Introductory pricing: Google's page doubles it to $4 / $20 /
  $0.20 on 2026-12-01, carried in `announced_change` (not yet a price), same shape as Gemini 4 Argon.
- `google` gemini-4-hydrogen: $1.50 input / $7.50 output / $0.075 cached input, effective 2026-11-12
  (GA per the release notes). No dated change on the page.
- `alibaba` qwen4-max: $1.50 input / $4.50 output, International scope, effective 2026-11-16 (Alibaba's
  Model releases and updates). Cache rates are READ from the pricing doc's own qwen4-max cache-price
  table, not derived: $0.075 cache read (`cache_read`, explicit and implicit alike; 5% of input, not
  the 10% general rule), $1.875 5-minute write (`cache_write_5m`), $3.00 1-hour write
  (`cache_write_1h`). The Context Cache doc names qwen4-max as an exception priced in the console;
  the pricing doc publishes the numbers.
- The `alibaba` collector now reads a captioned per-model cache-price table when one sits in the same
  region block as the model's International row, and its exception parse admits "qwen4-max: Explicit
  cache ...". Without both, tracking qwen4-max would have derived a $0.15 cache read.
- The `openai` collector threw "PIN model gpt-4o not found" from price-sentinel run 43386328275
  (2026-11-13 07:31 UTC; last clean run 43301983540, 2026-11-12 20:36 UTC). OpenAI began sending
  deprecated rows' model name as an object (`{label, deprecated}`) instead of a string, so 8 tracked
  models went unread. Repaired; the re-run emits all 30 tracked models and reports 0 price changes, so
  no current OpenAI rate differs from what we publish. The pricing page now marks gpt-4o, gpt-4o-mini, gpt-4.1, gpt-5,
  gpt-5.1, gpt-5.4-nano, o3 and o3-pro deprecated; OpenAI's deprecations page schedules shutdowns from
  2026-12-11. Records stay open until those dates.

## Addition: gpt-6-cyber long-context rates; openai collector repaired - 2026-11-10

- `openai` gpt-6-cyber: added the long-context (more than 272K input tokens) standard rates OpenAI now
  publishes, $40 input / $150 output / $4 cached input (`tier2_input`, `tier2_output`,
  `tier2_cache_read`). On 2026-11-09 the pricing page showed "-" for them; effective_from is the
  2026-11-10 observation date. No long-context cache write is published, so none is recorded.
- OpenAI folded its Cyber, Life sciences and Legal pricing sections into the Specialized-models table,
  whose cache-write column split into "30m write" / "12h write". The `openai` collector now reads that
  table by the main table's column labels, including each group's long-context rates.

## New model: Muse Ember (Meta Model API) - 2026-11-10

- `meta` muse-ember-1.0 (alias muse-ember, Standard mode only), priced by request length: up to 200K
  input tokens $0.10 input / $0.50 output / $0.004 cached input; over 200K input tokens the whole
  request is billed at $0.30 / $1.50 / $0.012 (`tier2_input` / `tier2_output` / `tier2_cache_read`).
  effective_from 2026-11-09 is the first first-party observation (absent at price-sentinel run
  42579926226, 07:31 UTC; on the page by run 42715293583, 22:49 UTC), not a stated launch date.
- Sentinel collector `meta` now reads a two-tier input-token table by its column labels and tracks
  muse-ember-1.0.

## New models: Claude Fable 5.2 and Claude Mythos 5.2 - 2026-11-10

- `anthropic` claude-fable-5-2 and claude-mythos-5-2 at $8 input / $40 output, cache writes $10 (5m)
  and $16 (1h), cache reads $0.20, read from Anthropic's
  [pricing page](https://platform.claude.com/docs/en/about-claude/pricing). That is 20% below
  Fable 5.1 / Mythos 5.1 ($10 / $50), which keep their rows. The cache-read rate is 0.025x base input,
  as on 5.1. Mythos 5.2 is limited availability (Project Glasswing) at the same rates.
- effective_from 2026-11-09 is the first first-party observation (price-sentinel run 42715293583);
  the page did not list either model at 07:31 UTC the same day (run 42579926226) and states no launch date.
- Not recorded: fast mode ($16 / $80) and Batch API ($4 / $20) rates; the schema has no variation for
  either, on any model.

## New provider: Meta (Meta Model API); correction: Llama 3.3 70B history - 2026-11-09

- New provider **`meta`**: Meta's own Model API prices, read from
  [dev.meta.ai/docs/pricing-rate-limits](https://dev.meta.ai/docs/pricing-rate-limits). muse-spark-1.1,
  muse-spark-1.2 and muse-spark-1.3 at $1.25 input / $4.25 output / $0.15 cached input;
  muse-spark-1.2-contributor and muse-spark-1.3-contributor (Contributor mode, which lets Meta train on
  your content) at $0.10 / $0.20 / $0.002; muse-wonder-1.0 (alias muse-wonder) at $4 / $20 / $0.20.
  Start dates come from Meta's dated launch posts, or the earliest Wayback capture of the pricing page
  where no post states the date or rate. Evidence in `data/backfill/meta.md`.
- Not added: Muse Spark Open and Muse Glimmer (open weights, no Meta price) and Muse Image, Muse Voice
  Transcribe and SAM 3.1 (not per-token).
- New sentinel collector `meta`; OpenRouter's `meta/` vendor now maps to `meta` instead of `meta-llama`.
- `meta-llama` llama-3.3-70b: added the $0.88 Together interval (2025-01-31 to 2026-06-14, Wayback
  capture 20250131230329) and corrected the $1.04 interval to start 2026-06-14, the first capture showing
  it, instead of our 2026-06-22 observation date. Supersedes the 2026-06-22 rows. Evidence in
  `data/backfill/meta-llama.md`.

## Correction: Llama intervals closed at Together's removal dates - 2026-11-09

- `meta-llama` has no first-party price; it was priced at Together AI as reference host. Together's
  [deprecations page](https://docs.together.ai/docs/deprecations) lists all five tracked models as
  removed from serverless inference. Closed: llama-4-scout and llama-3.1-405b at 2026-02-06,
  llama-3.1-8b at 2026-03-06, llama-4-maverick at 2026-03-31, llama-3.3-70b at 2026-10-22. No
  meta-llama model has a current price any more.
- Supersedes the 2026-06-22 llama-3.1-405b ($3.50) and llama-3.1-8b ($0.18) rows, which opened after
  Together had already removed both models. Replaced by Wayback-backed intervals (2024-09-27 and
  2024-08-12 capture dates to the removal date). Evidence in `data/backfill/meta-llama.md`.
- Removed the llama sentinel collector: Together's model pages still display prices after removal.

## Tooling: npm package + documented JSON API - 2026-06-18

- Published the **`ai-price-index` npm package** (lib + CLI): point-in-time `priceOn` / `current` /
  `rate` lookups with the dataset bundled inline (no runtime network), reproducing the shared
  golden vectors. Built from the committed `data/ai-price-index/` artifacts via `tools/build-npm.mjs`;
  auto-published on each dataset release. MIT tooling, CC BY 4.0 data, provenance preserved per record.
- Documented the stable JSON endpoint (`current.json` / `index.json`) with permissive CORS for
  browser + script use. See the README "Use the data" section.

## v2026.06.15-f72ebe9 - 2026-06-15

- Widened coverage to 6 providers / 48 models (was 3 / 22). 52 new dated, first-party-sourced records.
- New providers: **Mistral** (11 models, mistral.ai/pricing), **xAI / Grok** (grok-4.3, grok-4.20,
  grok-build, docs.x.ai), **DeepSeek** (v4-flash, v4-pro, api-docs.deepseek.com).
- Gap-fills: **OpenAI** GPT-5.4 / 5.5 line, **Google** Gemini 3.x line, both off the live first-party
  pricing pages.
- `inferred` confidence used where the price is first-party but the effective date is not
  (mistral-medium-3.5, grok-4.20, grok-build, deepseek-v4-pro). Backfill logs added for the three new
  providers and updated for OpenAI / Google.

## v2026.06.15-10cb06a - 2026-06-15

- Added Claude **Fable 5** (`claude-fable-5`, $10 / $50), Anthropic's first public Mythos-class model.

## v2026.06.14-2e0a4ec - 2026-06-14

- Added **OpenAI (GPT)** and **Google (Gemini)** flagship price history (3 providers / 21 models).
  GPT-4 -> Turbo -> 4o (with the Aug-2024 step) -> 4.1 -> GPT-5; Gemini 1.5 / 2.0 / 2.5 lines.

## v2026.06.14-926e0f5 - 2026-06-14

- Backfilled **Claude flagship price history** (Claude 3 / 3.5 / 3.7), `archived`-confidence records
  from first-party announcements + Wayback pricing captures + the official deprecations page.

## v2026.06.14 - 2026-06-14

- First published export: the system-of-record SQLite (WAL) bitemporal store, the DB -> static
  artifact pipeline (`index.json`, `current.json`, per-model content-hashed series), and the seeded
  Anthropic flagships (Opus 4, Opus 4.5, Sonnet 4.5).

## Repository scaffold

- Schema (price record, per-model series, index), the zero-dependency validator, CI, methodology,
  contribution flow, and licensing (CC BY 4.0 data, MIT tooling).
