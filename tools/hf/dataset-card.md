---
license: cc-by-4.0
pretty_name: AI Price Index
language:
  - en
tags:
  - ai
  - llm
  - pricing
  - api-pricing
  - cost
  - finops
  - anthropic
  - openai
size_categories:
  - n<1K
configs:
  - config_name: default
    data_files:
      - split: train
        path: ai_price_index.csv
---

# AI Price Index

An open, dated, first-party-sourced record of AI model API prices over time.

Provider pricing pages change quietly with no changelog. This dataset is the changelog. Every price carries the date it became valid and the date it was last verified against the official source, so you can price historical token usage point-in-time instead of extrapolating from today's rate.

- **{{RECORDS}} price records, {{MODELS}} models, {{PROVIDERS}} providers**: Anthropic, OpenAI, Google, Mistral, xAI, DeepSeek, Cohere, Amazon Nova, AI21, Alibaba Qwen
- A first-party source URL on **every** price
- Maintained via a daily automated check against official pricing pages; **every change is human-reviewed before it lands**
- License: CC BY 4.0. DOI: [10.5281/zenodo.20730240](https://doi.org/10.5281/zenodo.20730240)

## Load it

```python
from datasets import load_dataset

ds = load_dataset("RoninForge/ai-price-index", split="train")
print(ds[0])
```

## Schema

One row is one price observation (a model's input or output rate during a dated validity window).

| column | description |
|---|---|
| `provider` | Provider slug (e.g. `anthropic`, `openai`). |
| `model_id` | Provider model id (e.g. `claude-opus-4-5-20251101`). |
| `variation` | `input` or `output` tokens. |
| `unit` | Price unit. Currently `usd_per_mtok` (USD per 1M tokens). |
| `price_usd` | The price, in USD, for that unit. |
| `effective_from` | Date this price became valid (ISO `YYYY-MM-DD`). |
| `effective_to` | Date this price stopped being valid, or empty if it is the current price. |
| `last_validated_at` | Date the price was last checked against the official source. |
| `source_kind` | How it was sourced (e.g. `provider_live`). |
| `confidence` | `verified` (first-party-confirmed) or `inferred` (price known, exact date estimated). |
| `aliases` | Other ids the model is known by (semicolon-separated). |
| `source_url` | First-party source for the price. |
| `notes` | Free-text context. |

To get the current price of a model, filter rows where `effective_to` is empty. To price usage on a given date `d`, take the row where `effective_from <= d` and (`effective_to` is empty or `effective_to > d`).

## Files

- `ai_price_index.csv`: the full flat table (loaded above).
- `ai_price_index.json`: the same records as JSON.

The bitemporal source of truth, per-provider history, methodology, and tooling live in the GitHub repository.

## Maintenance and methodology

A bot diffs each provider's official pricing page daily and flags drift. No price changes automatically: a human verifies every change against the first-party source before it is merged, because pricing is exactly the kind of data you do not want a scraper silently guessing on. Corrections and new-provider requests are welcome via GitHub issues and pull requests.

## Links

- GitHub (source of truth, issues, PRs): https://github.com/RoninForge/ai-price-index
- Browsable view: https://roninforge.org/data/ai-price-index

## Citation

```bibtex
@misc{roninforge_ai_price_index,
  author       = {{RoninForge}},
  title        = {{AI Price Index: dated, first-party AI model API prices over time}},
  year         = {2026},
  doi          = {10.5281/zenodo.20730240},
  howpublished = {\url{https://roninforge.org/data/ai-price-index/}},
  note         = {Data licensed CC BY 4.0.}
}
```
