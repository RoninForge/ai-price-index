# Backfill log: Mistral AI

First coverage pass for Mistral (added 2026-06-15). Prices are USD per 1M tokens, standard tier, text
input/output, read off the live first-party pricing page at https://mistral.ai/pricing (USD toggle,
USD shown; cross-checked across repeated fetches). Availability dates come from the dated first-party
announcement at mistral.ai/news/* for each model (those announcement pages do not carry per-token
prices, so the price is sourced to the live pricing page and the date to the announcement).

| model | input | output | effective_from | confidence | date source |
| --- | --- | --- | --- | --- | --- |
| mistral-large-3 | 0.5 | 1.5 | 2025-12-02 | verified | news/mistral-3 |
| mistral-medium-3.5 | 1.5 | 7.5 | 2026-04-29 | inferred | docs card slug 26-04 (news 404) |
| mistral-small-4 | 0.1 | 0.3 | 2026-03-16 | verified | news/mistral-small-4 |
| magistral-medium | 2 | 5 | 2025-06-10 | verified | news/magistral (orig launch) |
| magistral-small | 0.5 | 1.5 | 2025-06-10 | verified | news/magistral |
| codestral-25.08 | 0.3 | 0.9 | 2025-07-30 | verified | news/codestral-25-08 |
| devstral-2 | 0.4 | 2 | 2025-12-09 | verified | news/devstral-2-vibe-cli |
| devstral-small-2 | 0.1 | 0.3 | 2025-12-09 | verified | news/devstral-2-vibe-cli |
| ministral-3-3b | 0.1 | 0.1 | 2025-12-02 | verified | news/mistral-3 |
| ministral-3-8b | 0.15 | 0.15 | 2025-12-02 | verified | news/mistral-3 |
| ministral-3-14b | 0.2 | 0.2 | 2025-12-02 | verified | news/mistral-3 |

## Caveats / gaps

- Mistral Medium 3.5: the live price is first-party but the exact launch date could not be confirmed
  from a first-party page (the docs model card was not fetchable, the guessed news URL 404'd), so the
  date is inferred from the docs card slug date code `26-04` and marked `inferred`.
- The Ministral 3 family lists a flat input=output price on the page; recorded as shown.
- Magistral Medium/Small use the original 2025-06-10 launch date; the live SKU reflects the later 1.2
  lineage but keeps the same named price line.
- Not recorded (out of scope): embeddings (Mistral Embed, Codestral Embed), vision-image / audio
  (Voxtral), batch, and fine-tuning. No standalone Pixtral text SKU exists on the current page (its
  multimodal capability was folded into Small 4 / Medium 3.5). Legacy Mixtral / NeMo SKUs were not
  consistently present across fetches and were omitted conservatively.

## Sources fetched

- https://mistral.ai/pricing (live pricing page; the price source)
- https://mistral.ai/news/mistral-3/
- https://mistral.ai/news/mistral-small-4/
- https://mistral.ai/news/magistral/
- https://mistral.ai/news/codestral-25-08/
- https://mistral.ai/news/devstral-2-vibe-cli/
