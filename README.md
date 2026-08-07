# AI Price Index

[![npm](https://img.shields.io/npm/v/ai-price-index?color=informational)](https://www.npmjs.com/package/ai-price-index)
[![Data: CC BY 4.0](https://img.shields.io/badge/data-CC%20BY%204.0-informational)](DATA-LICENSE.md)
[![Tooling: MIT](https://img.shields.io/badge/tooling-MIT-informational)](LICENSE)
[![Cite this](https://img.shields.io/badge/cite-CITATION.cff-informational)](CITATION.cff)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20730240-informational)](https://doi.org/10.5281/zenodo.20730240)

RoninForge AI Price Index is a dated, first-party-sourced record of AI model API prices over
time, including what each model cost on a given date. The data is CC BY 4.0, every price links
the official source that proves it, and no result depends on an API key.

Part of [RoninForge.org](https://roninforge.org), an independent open-source workshop that
keeps dated, reproducible records of the AI developer tooling economy.

Most price lists tell you what a model costs **today**. This one tells you what it cost **on a
given date**, **when that price was last confirmed**, and **links the first-party source that proves
it**. That provenance is the point: every value carries a verifiable source and a `last_validated_at`
date, including historical ones.

Why this index exists, what it is for, and how it is kept honest:
**<https://roninforge.org/data/ai-price-index/>**

- **Data license:** CC BY 4.0 (see [DATA-LICENSE.md](DATA-LICENSE.md)). Use it anywhere, just attribute.
- **Tooling license:** MIT (see [LICENSE](LICENSE)).
- Maintained by [RoninForge](https://roninforge.org). Source of truth, methodology, and corrections
  are all in the open.

> Status: early. The schema, validation, and methodology are in place; coverage is being seeded
> flagship-first (see Roadmap). Prices can change and history is partly reconstructed; trust the
> `confidence` label and the `source_url` on each record, not this sentence.

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

Three ways, depending on what you are building.

### npm package (point-in-time lookups, no network)

```bash
npm install ai-price-index
```

The dataset ships **bundled inside the package** (no runtime network call), so a lookup is
deterministic and reproducible against the version you installed.

```js
import { current, priceOn, rate, meta } from 'ai-price-index';

current('claude-opus-4-8');        // today's input/output rate + the source that proves it
priceOn('gpt-4', '2024-01-01');    // the rate that was IN EFFECT on that date ($30 / $60 per Mtok)
rate('gpt-4', '2024-01-01');       // -> { provider, model, date, inputPerM: 30, outputPerM: 60 }
meta.dataModified;                 // the dataset date this install pins to
```

Short ids and a trailing `[1m]` display suffix resolve to the dated series (e.g. `claude-opus-4-5`
-> `claude-opus-4-5-20251101`); pass `{ provider }` to disambiguate a bare model id. `usdForRollup`
values a token rollup at a point in time with the shared cache multipliers (read 0.1x, write 1.25x /
2x). The package reproduces the same [golden vectors](examples/pricing-vectors.json) as the other
RoninForge pricing engines.

CLI (no install needed):

```bash
npx ai-price-index claude-opus-4-8                 # today's rate
npx ai-price-index gpt-4 --on 2024-01-01           # a past date
npx ai-price-index list --provider openai          # known models
npx ai-price-index claude-opus-4-8 --json          # machine-readable
```

### JSON API (fetch the current snapshot)

The current prices are served as JSON with permissive CORS, so you can fetch them from a browser or
a script. These are **stable URLs** (safe to depend on):

```
https://roninforge.org/data/ai-price-index/current.json   # current price of every model
https://roninforge.org/data/ai-price-index/index.json     # model list + per-model series file map
```

```js
const { prices } = await (await fetch('https://roninforge.org/data/ai-price-index/current.json')).json();
const opus = prices.find((p) => p.model === 'claude-opus-4-8' && p.variation === 'input');
console.log(opus.price_usd, opus.src);  // 5  https://www.anthropic.com/news/claude-opus-4-8
```

For full price **history** (every dated interval, not just current), use the npm package or clone the
repo. Per-model series filenames under `models/` are content-hashed and not stable; do not hardcode them.

### Clone the raw dataset

```bash
git clone https://github.com/RoninForge/ai-price-index
node tools/validate.mjs        # validate everything locally
```

When you publish anything derived from this data, attribute it: **"AI Price Index by RoninForge, CC
BY 4.0"** with a link to <https://roninforge.org/data/ai-price-index/> and the validation date of the
values you used. See [ATTRIBUTION.md](ATTRIBUTION.md) for copy-paste formats.

## How to cite

Prices change and corrections supersede without deleting history, so cite a **dated release** to keep
your snapshot reproducible. Machine-readable citation metadata is in [`CITATION.cff`](CITATION.cff)
(GitHub renders a "Cite this repository" button from it).

Plain:

> AI Price Index by RoninForge (https://roninforge.org/data/ai-price-index/), CC BY 4.0. Release `<tag>`, accessed `<date>`.

BibTeX:

```bibtex
@misc{roninforge_ai_price_index,
  author       = {{RoninForge}},
  title        = {{AI Price Index: dated, first-party AI model API prices over time}},
  howpublished = {\url{https://roninforge.org/data/ai-price-index/}},
  note         = {Release <tag>. Data licensed CC BY 4.0. Accessed <date>.}
}
```

For academic reuse, cite the DOI (Zenodo): **[10.5281/zenodo.20730240](https://doi.org/10.5281/zenodo.20730240)**.
This is the concept DOI and always resolves to the latest version; each release also gets its own
version DOI for an exact, reproducible snapshot.

## Verify a release (signed interval history)

`current.json` is a flat snapshot of today's prices. It carries no effective dates, so it cannot
price historical usage: a consumer would have to either reprice all history at today's rate or
invent a boundary date. For that, each release also publishes the full half-open `[from, to)`
interval history for Anthropic as a single file, with a detached signature:

```
https://roninforge.org/data/ai-price-index/history/anthropic.json
https://roninforge.org/data/ai-price-index/history/anthropic.json.minisig
```

The signature is [minisign](https://jedisct1.github.io/minisign/) format (Ed25519). Do not take our
word for the numbers, check them:

```bash
curl -fsSLO https://roninforge.org/data/ai-price-index/history/anthropic.json
curl -fsSLO https://roninforge.org/data/ai-price-index/history/anthropic.json.minisig

minisign -V -m anthropic.json \
  -P 'RWRFfFveQwl6NGYtfQNtpgdecGGC3U8k5iqK+vGmUq3D3SP0wIfmg8P1'
```

A successful check also prints the trusted comment, which names the dataset release and its data
date and is itself covered by the signature:

```
Signature and comment signature verified
Trusted comment: ai-price-index v2026.07.30-abc1234 dataModified=2026-07-29
```

Public key `RWRFfFveQwl6NGYtfQNtpgdecGGC3U8k5iqK+vGmUq3D3SP0wIfmg8P1` (key id `347A0943DE5B7C45`).

Signing happens in this repository's CI, and the private key exists only as a secret here. It is
deliberately **not** on the web server. That server terminates TLS with a valid certificate, so TLS
proves bytes came from that host, not that they are genuine; a host that both served and signed the
data would produce perfectly valid signatures after a single-box compromise. Keeping the key out of
the serving path means the web server is an untrusted mirror, and a tampered file simply fails to
verify.

What the signature does not cover, stated plainly: a price that was recorded wrongly in the first
place. It proves the file is the one we published, not that we published the right number. Prices
carry a `confidence` field and a first-party `src` for exactly that reason.

## Roadmap

Coverage is seeded **flagship-first, deep on history**: the leading models (Claude, GPT, Gemini)
with their price history pushed back as far as it can be verifiably sourced, before widening to the
long tail. Reconstructed history is labelled by `confidence` (`archived` / `inferred` / `estimated`)
and never rendered with the same weight as a live-confirmed price.

## Contributing

Found a wrong or missing price? Open an issue or a PR with the correct value **and a first-party
source URL plus the date you saw it**. A contribution without a dated first-party source cannot be
accepted; that rule is what makes this trustworthy. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs

- [The dataset, the current price table and why it exists](https://roninforge.org/data/ai-price-index/)
- [Query it from Claude Code or Cursor over MCP](https://roninforge.org/data/ai-price-index/#mcp)
- [Why a price change should not restate your recorded history](https://roninforge.org/data/ai-price-index/back-dating/)
- [AI prices did not fall, they fanned out](https://roninforge.org/data/ai-price-index/the-fan-out/)
- [Every dated price change, newest first](https://roninforge.org/data/ai-price-index/changelog/)
- [Per-model pricing pages with dated history](https://roninforge.org/data/ai-price-index/models/)

The AI Price Index is part of [RoninForge.org](https://roninforge.org).
