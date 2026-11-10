# Changelog

Per-release record of price additions and corrections (supersedes), so the history of what changed
and why is auditable. Hand-maintained for now (the export bot cuts the release tags + the
`data/ai-price-index/` artifacts; this file is updated alongside coverage work). Full provenance for
every price lives in `data/backfill/<provider>.md` and in each record's `source_url` /
`last_validated_at`.

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
