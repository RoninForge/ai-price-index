# Backfill log: Meta (Meta Model API, Muse)

Meta sells its Muse models on its own Meta Model API, so these are first-party prices. Source of
record: https://dev.meta.ai/docs/pricing-rate-limits (Markdown twin at the same URL plus `.md`,
listed in https://dev.meta.ai/llms.txt). Prices are USD per 1M tokens. Llama is not here: Meta sells
no hosted Llama API, and the `meta-llama` records are Together AI reference-host history (see
`meta-llama.md`).

## 2026-11-09: first records

Live page, read 2026-11-09, section "Model pricing" (columns: Usage | Standard mode (per 1M tokens) |
Contributor mode (per 1M tokens)):

| section | model ids on the page | Cached input | Input | Output |
| --- | --- | --- | --- | --- |
| Muse Wonder | `muse-wonder-1.0` | $0.20 / Not available | $4.00 / Not available | $20.00 / Not available |
| Muse Spark | Standard: `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`; Contributor: `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` | $0.15 / $0.002 | $1.25 / $0.10 | $4.25 / $0.20 |

The page: "Contributor mode runs the same models at heavily discounted token prices, in exchange for
permission to use your content to train future Meta models", called as its own model id. Each
contributor id is recorded as its own `model_id`; the Standard-mode price is the base id.

| model_id | input | output | cache_read | effective_from | basis |
| --- | --- | --- | --- | --- | --- |
| muse-spark-1.1 | 1.25 | 4.25 | | 2026-07-08 | launch post states price |
| muse-spark-1.1 | | | 0.15 | 2026-08-04 | earliest first-party evidence |
| muse-spark-1.2 | 1.25 | 4.25 | 0.15 | 2026-08-05 | launch post |
| muse-spark-1.3 | 1.25 | 4.25 | 0.15 | 2026-09-02 | launch post |
| muse-spark-1.2-contributor | 0.10 | 0.20 | 0.002 | 2026-08-26 | earliest first-party evidence |
| muse-spark-1.3-contributor | 0.10 | 0.20 | 0.002 | 2026-09-09 | earliest first-party evidence |
| muse-wonder-1.0 | 4.00 | 20.00 | | 2026-10-12 | launch post states price |
| muse-wonder-1.0 | | | 0.20 | 2026-10-14 | earliest first-party evidence |

All rows are `provider_live` / `verified`, `last_validated_at` 2026-11-09, open intervals.
`muse-wonder-1.0` carries the alias `muse-wonder` (the OpenRouter id).

### Dated first-party sources

- 2026-07-08, https://dev.meta.ai/resources/blog/build-with-muse-spark ("Jul 08, 2026"): "Today, Muse
  Spark is accessible in public preview on Meta Model API to developers in the US." and "Pay-as-you-go
  pricing starts at $1.25 input/$4.25 output per million tokens." The post introduces Muse Spark 1.1.
  Meta AI Research dates its own 1.1 post (https://research.meta.ai/blog/introducing-muse-spark-meta-model-api)
  July 9, 2026; the developer post is the one that states availability and price, so it sets the date.
- 2026-08-05, https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2: "Muse Spark 1.2 is
  available today in Muse Code and in Meta Model API with expanded global access." No price stated.
- 2026-09-02, https://research.meta.ai/blog/introducing-muse-spark-1-3: "Muse Spark 1.3 is available
  today in Muse Code and in Meta Model API." No price stated; no mention of a contributor id.
- 2026-10-12, https://dev.meta.ai/resources/blog/build-with-muse-wonder ("Oct 12, 2026"): "Today we're
  excited to launch Muse Wonder on Muse Code and Meta Model API at $4 input / $20 output per million
  tokens (USD)."

### Wayback captures of the pricing page

CDX over `dev.meta.ai/docs/pricing*` and `ai.developer.meta.com/docs/pricing*`, `collapse=digest`. The
earliest capture is 20260804014526; nothing earlier exists. Several captures in between returned an
archive rate-limit page and were not read; every capture that was read shows the same prices.

| capture | what it shows |
| --- | --- |
| 20260804014526 | one table, no model ids (only Muse Spark 1.1 existed): "Input \| $1.25", "Cached input \| $0.15", "Output \| $4.25" |
| 20260826103112 | "Standard tier ... Models: `muse-spark-1.1`, `muse-spark-1.2`. ... Both checkpoints share the same standard pricing" ($0.15 / $1.25 / $4.25); "Contributor tier ... Model: `muse-spark-1.2-contributor`" ($0.002 / $0.10 / $0.20) |
| 20260909002023 | Standard tier adds `muse-spark-1.3` ("These versions share the same standard pricing"); Contributor tier adds `muse-spark-1.3-contributor`; same prices |
| 20260918183820, 20260925191632, 20261004025312, 20261007113351 | same Spark prices |
| 20261014155040 | first capture with the Muse Wonder table: $0.20 / $4.00 / $20.00, Contributor "Not available" |
| 20261015030325, 20261021081512, 20261023092618, 20261029114331 | same as the live page |

### effective_from rule used

- A dated first-party post that says the model is available on Meta Model API sets the start for the
  price it states, or for the shared Muse Spark rate already published (1.2 and 1.3 are listed under
  "share the same standard pricing").
- A rate the launch post does not state (1.1 and Wonder cached input) and an id with no dated
  announcement (both contributor ids) start at the earliest first-party evidence: the first Wayback
  capture of the pricing page that shows it. These are not change dates and the notes say so.

### Not recorded

- `muse-spark-open` and `muse-glimmer` (OpenRouter `muse-glimmer-30b`): open weights. The models page
  says "You don't call it over Model API" for Muse Spark Open, and Muse Glimmer is self-hosted. Meta
  publishes no price for either; reseller prices are not recorded.
- Muse Image ($0.01 per generated image), Muse Voice Transcribe ($0.18 per hour of audio) and SAM 3.1
  ($2.50 per 1,000 images, $0.20 per 1,000 video frames): not per-token. The index records per-token
  prices only. They are `KNOWN_UNTRACKED` in the collector.
- Web search grounding ($2.50 per 1,000 search queries): a per-request surcharge with no variation in
  the schema.
- Muse Wonder Full: available only in Muse Code subscriptions, no per-token price. Muse Code
  subscription plans are not per-token prices.

### Collector

`tools/sentinel/collectors/meta.mjs` reads the `.md` twin, maps each table column to the ids its
sentence names for that mode, asserts coverage of every tracked id, and reports any other backticked
API model id on the page as an untracked model. OpenRouter's `meta/` vendor now maps to `meta`, so the
tripwire no longer lists these models as awaiting a first-party price.
