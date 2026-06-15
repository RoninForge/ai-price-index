# Backfill log: DeepSeek

First coverage pass for DeepSeek (added 2026-06-15). Prices are USD per 1M tokens, standard tier, text
input/output, read off the live first-party pricing table at
https://api-docs.deepseek.com/quick_start/pricing (the page states prices are per 1M tokens in USD;
no conversion needed). The current text lineup is two models.

| model | input (cache-miss) | output | effective_from | confidence | note |
| --- | --- | --- | --- | --- | --- |
| deepseek-v4-flash | 0.14 | 0.28 | 2026-04-24 | verified | V4 launch per the first-party change log |
| deepseek-v4-pro | 0.435 | 0.87 | 2026-06-01 | inferred | permanent post-cut price; date not first-party-dated |

## Method and caveats

- DeepSeek lists separate cache-hit and cache-miss input prices. The recorded `input` is the
  cache-MISS (standard, non-cached) rate; the cache-hit rates (v4-flash $0.0028, v4-pro $0.003625 per
  Mtok) are noted on the records, not separately charted.
- deepseek-v4-flash prices have held since the 2026-04-24 V4 launch (first-party change log entry +
  news page), so `verified`.
- deepseek-v4-pro's current $0.435/$0.87 is the permanent rate after a 75% cut. The price is
  first-party (live page) but DeepSeek's change log does not date the cut; the promo ran through
  2026-05-31 and became the list price around 2026-06-01, so the date is `inferred`.
- The legacy `deepseek-chat` (non-thinking) and `deepseek-reasoner` (thinking) aliases are not
  separately priced; they map to deepseek-v4-flash and are scheduled to retire 2026-07-24.
- Not recorded (out of scope): cached input, batch, and any image/embeddings SKUs. No time-of-day /
  off-peak discount appears on the current V4 pricing page.
- Pre-V4 history (V3.2 2025-12-01, V3.2-Exp 2025-09-29, V3.1-Terminus 2025-09-22, V3.1 2025-08-21) is
  noted for a future backfill pass but not yet charted.

## Sources fetched

- https://api-docs.deepseek.com/quick_start/pricing (live pricing table; the price source)
- https://api-docs.deepseek.com/updates (change log; V4 launch date)
- https://api-docs.deepseek.com/news/news260424 (V4 launch announcement)
