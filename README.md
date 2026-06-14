# AI Price Index

An open, dated, first-party-sourced record of AI model API prices over time.

Most price lists tell you what a model costs **today**. This one tells you what it cost **on a
given date**, **when that price was last confirmed**, and **links the first-party source that proves
it**. That provenance is the point: every value carries a verifiable source and a `last_validated_at`
date, including historical ones.

- **Data license:** CC BY 4.0 (see [DATA-LICENSE.md](DATA-LICENSE.md)). Use it anywhere, just attribute.
- **Tooling license:** MIT (see [LICENSE](LICENSE)).
- Maintained by [RoninForge](https://roninforge.org). Source of truth, methodology, and corrections
  are all in the open.

> Status: early. The schema, validation, and methodology are in place; coverage is being seeded
> flagship-first (see Roadmap). Prices can change and history is partly reconstructed; trust the
> `confidence` label and the `source_url` on each record, not this sentence.

## Why it exists

No first-party provider publishes its own price history. Several open lists have broad **current**
pricing, but none pairs each price with a dated, verifiable first-party source under a clear license,
and none surfaces when a price was last validated. Tools that need to value **past** usage (what did
this token cost back then) have nothing reliable to read. This fills that gap.

## What is in here

```
schema/        JSON Schemas: the price record, the published per-model series, the index
examples/      illustrative-but-accurate records + series that the validator checks
data/          the published dataset (generated from the system of record; appears as coverage lands)
tools/         validate.mjs, a zero-dependency validator (run in CI and locally)
METHODOLOGY.md how prices are sourced, confirmed, dated, and corrected
CONTRIBUTING.md how to report or fix a price (a first-party dated source is required)
```

### The price record

Every price is one record. The human-facing shape (what you contribute and what the validator
checks) is defined in [`schema/price-record.schema.json`](schema/price-record.schema.json). In short:

| field | meaning |
| --- | --- |
| `provider`, `model_id`, `variation`, `unit` | what is priced (e.g. anthropic / claude-opus-4-5-20251101 / input / usd_per_mtok) |
| `price_usd` | the price for one unit |
| `effective_from`, `effective_to` | the dates this price was in effect (`effective_to: null` = current) |
| `last_validated_at` | when this price was last confirmed against its source |
| `source_url`, `source_kind`, `confidence` | the first-party proof and how sure we are |

The published, served form is one file per model (`schema/model-series.schema.json`) plus a thin
`index.json` (`schema/index.schema.json`); a client binary-searches a model's interval array by date.

## Use the data

```bash
git clone https://github.com/RoninForge/ai-price-index
node tools/validate.mjs        # validate everything locally
```

When you publish anything derived from this data, attribute it: **"AI Price Index by RoninForge, CC
BY 4.0"** with a link to this repository and the validation date of the values you used.

## Roadmap

Coverage is seeded **flagship-first, deep on history**: the leading models (Claude, GPT, Gemini)
with their price history pushed back as far as it can be verifiably sourced, before widening to the
long tail. Reconstructed history is labelled by `confidence` (`archived` / `inferred` / `estimated`)
and never rendered with the same weight as a live-confirmed price.

## Contributing

Found a wrong or missing price? Open an issue or a PR with the correct value **and a first-party
source URL plus the date you saw it**. A contribution without a dated first-party source cannot be
accepted; that rule is what makes this trustworthy. See [CONTRIBUTING.md](CONTRIBUTING.md).
