# Backfill log: OpenAI (GPT)

GPT flagship price history, reconstructed from archived OpenAI pricing pages (Wayback) plus the live
first-party model/pricing pages. Prices are USD per 1M tokens, standard (synchronous) tier.

| model | input | output | effective_from | effective_to | evidence |
| --- | --- | --- | --- | --- | --- |
| gpt-4 (8K) | 30 | 60 | 2023-03-14 | null (retires 2026-10-23) | Wayback openai.com/pricing 20230415223802 |
| gpt-4-turbo | 10 | 30 | 2023-11-06 | null (retires 2026-10-23) | Wayback 20231110022605 (DevDay) |
| gpt-4o | 5 -> 2.50 | 15 -> 10 | 2024-05-13 -> 2024-08-06 | (the step) | Wayback 20240524210913 + 20240812003130 |
| gpt-4o-mini | 0.15 | 0.60 | 2024-07-18 | null | Wayback 20240722005830 |
| gpt-4.1 | 2 | 8 | 2025-04-14 | null | live developers.openai.com model page (verified) |
| gpt-5 | 1.25 | 10 | 2025-08-07 | null | live model page (price verified); date inferred from the GPT-5 launch (not first-party-confirmed) |

## The flagship price decline

The GPT flagship input price fell from **$30 (GPT-4, Mar 2023)** to **$10 (GPT-4 Turbo, Nov 2023)** to
**$5 (GPT-4o, May 2024)** to **$2.50 (GPT-4o Aug 2024 cut)** to **$2 (GPT-4.1, Apr 2025)** to **$1.25
(GPT-5, Aug 2025)**. GPT-4o is recorded as one model with a two-interval step (the Aug 2024 reduction).

## Caveats / gaps

- `effective_to` is set only for models already retired (a past date). gpt-4 / gpt-4-turbo have a
  future scheduled retirement (2026-10-23 per the OpenAI deprecations page), so they stay `null`
  (still offered) and the note records the scheduled date.
- The GPT-5 effective date is the widely-reported launch date; the price is first-party-verified but
  the date was not confirmed on a fetched first-party page (confidence `inferred`).
- The very latest models (GPT-5.4, GPT-5.5 and their pro/mini/nano variants) are priced on the live
  page and tracked in the llm-pricing dataset, but their first-party effective dates were not
  sourceable, so they are NOT yet in the index. Add them once a dated source exists.
- Batch-tier (50% off) and the cached-input rates are not recorded; only the standard tier.

## Sources fetched

- https://web.archive.org/web/20230415223802/https://openai.com/pricing
- https://web.archive.org/web/20231110022605/https://openai.com/pricing
- https://web.archive.org/web/20240524210913/https://openai.com/pricing/
- https://web.archive.org/web/20240722005830/https://openai.com/pricing/
- https://web.archive.org/web/20240812003130/https://openai.com/pricing/
- https://developers.openai.com/api/docs/models/gpt-4.1
- https://developers.openai.com/api/docs/models/gpt-5
- https://developers.openai.com/api/docs/pricing (current live page)
- https://developers.openai.com/api/docs/deprecations (retirement dates)

## 2026-06-15 update: current GPT-5.4 / 5.5 line added

The latest GPT line was added from the live first-party developers pricing page, dated via the
official developers changelog (all `verified`, standard sync tier, USD per 1M tokens):

| model | input | output | effective_from |
| --- | --- | --- | --- |
| gpt-5.4 | 2.50 | 15 | 2026-03-05 |
| gpt-5.4-mini | 0.75 | 4.50 | 2026-03-17 |
| gpt-5.4-nano | 0.20 | 1.25 | 2026-03-17 |
| gpt-5.4-pro | 30 | 180 | 2026-03-05 |
| gpt-5.5 | 5 | 30 | 2026-04-24 |
| gpt-5.5-pro | 30 | 180 | 2026-04-24 |

Still gaps (no price on the current first-party page, so not added): the o-series (o1/o3/o3-mini/
o3-pro/o4-mini) and gpt-5.1/5.2 are absent from the live pricing page; gpt-5.3-codex (code-specialized,
$1.75/$14) is out of scope. Batch and cached-input tiers remain unrecorded. The gpt-5.4-mini/nano day
(Mar 16 vs 17) had minor changelog ambiguity; 2026-03-17 used.
