# AI Price Index

An open, dated, first-party-sourced record of AI model API prices over time. {{RECORDS}} price records, {{MODELS}} models, {{PROVIDERS}} providers, back to the launch of GPT-4 in March 2023.

Provider pricing pages change quietly with no changelog, and old prices get overwritten and deleted. This dataset is the changelog. Every price carries the date it became valid and a link to the official source it came from, so you can price historical token usage at the rate that was actually in effect on the day, instead of extrapolating from today's number.

## Why this one is different

Most "LLM pricing" resources show only today's prices, or reconstruct history after the fact (one widely cited analysis had to scrape the Internet Archive to recover old prices, because the originals were gone). This index keeps the receipts: a first-party source URL on **every** price, an effective date on every change, and a human review before any change lands. A bot diffs each provider's official pricing page daily and flags drift; nothing changes automatically.

## What the data shows

AI prices did not fall in a tidy line. They fanned out. The cheapest input price fell about 857x, from $30 per million tokens at GPT-4's launch to $0.035 today, while a new premium reasoning tier pushed the ceiling up to $600 per million output tokens. On the same day, a million output tokens can cost anywhere from 10 cents to 600 dollars depending on which model you call. Full write-up with the chart: https://roninforge.org/data/ai-price-index/the-fan-out/

## Files

- `ai_price_index.csv`: flat table, one row per model and variation (input or output) per dated validity window. Load this with pandas or `load_dataset`.
- `ai_price_index.json`: the same records as JSON.

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

## Load it

```python
import pandas as pd

df = pd.read_csv("ai_price_index.csv")
current = df[df["effective_to"].isna()]          # the latest price of every model
print(current.sort_values("price_usd").head())
```

## Provenance, license, and corrections

Licensed CC BY 4.0: free to use with attribution. The bitemporal source of truth, the methodology, and the tooling live in the GitHub repository, and corrections or new-provider requests are welcome as issues and pull requests.

- GitHub (source of truth): https://github.com/RoninForge/ai-price-index
- Hugging Face mirror: https://huggingface.co/datasets/RoninForge/ai-price-index
- Browsable view: https://roninforge.org/data/ai-price-index/
- Citable DOI: https://doi.org/10.5281/zenodo.20730241
