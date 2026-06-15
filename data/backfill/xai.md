# Backfill log: xAI (Grok)

First coverage pass for xAI (added 2026-06-15). Prices are USD per 1M tokens, standard tier, text
input/output, read off the live first-party model pages under https://docs.x.ai/docs/models (the
marketing pages x.ai/api and x.ai/news 403 fetchers, and the Wayback Machine was unreachable from the
build environment, so all prices come from the live first-party docs, source_kind `provider_live`).

| model | input | output | effective_from | confidence | note |
| --- | --- | --- | --- | --- | --- |
| grok-4.3 | 1.25 | 2.50 | 2026-05-05 | verified | flagship, 1M ctx; date from the "live on the API" post |
| grok-4.20-0309-reasoning | 1.25 | 2.50 | 2026-03-09 | inferred | March 2026 release notes + -0309 slug |
| grok-build-0.1 | 1.00 | 2.00 | 2026-06-01 | inferred | coding model, early access, 256k ctx |

## Caveats / gaps

- The Grok 4.20 non-reasoning and multi-agent variants carry the SAME $1.25/$2.50 as the reasoning
  variant on the same date, so only the reasoning variant is recorded (one price point, not three
  identical lines). They are first-party-priced and can be added later if a distinct price emerges.
- grok-4.20 and grok-build-0.1 dates are `inferred`: the price is first-party but the release notes
  date them only by month, so the day is a best estimate (the -0309 slug supports 2026-03-09).
- A first-party model retirement on 2026-05-15 (docs.x.ai migration page) removed grok-3, grok-4-fast,
  grok-4-0709, grok-4.1*, and grok-code-fast-1 from the lineup; those slugs now redirect to grok-4.3.
  Their old budget prices survive only on third-party aggregators (not a valid source here), so they
  are not recorded. A dated Wayback capture of a first-party page would be needed to backfill them.
- Not recorded (out of scope): cached input ($0.20/Mtok across the text models), live-search, image,
  video, and voice SKUs.

## Sources fetched

- https://docs.x.ai/docs/models (and the per-model pages for grok-4.3, grok-4.20-0309-reasoning, grok-build-0.1)
- https://docs.x.ai/developers/release-notes
- https://docs.x.ai/developers/migration/may-15-retirement
