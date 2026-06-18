# Changelog

Per-release record of price additions and corrections (supersedes), so the history of what changed
and why is auditable. Hand-maintained for now (the export bot cuts the release tags + the
`data/ai-price-index/` artifacts; this file is updated alongside coverage work). Full provenance for
every price lives in `data/backfill/<provider>.md` and in each record's `source_url` /
`last_validated_at`.

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
