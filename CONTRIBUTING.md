# Contributing

Thank you for helping keep the AI Price Index accurate. There is exactly one hard rule, and it is the
reason this dataset is worth trusting:

> **Every price needs a first-party source URL and the date you confirmed it.**

A contribution without a dated first-party source cannot be accepted, no matter how confident it is.

## Report a wrong or missing price

Open an issue using the "Price correction" template. It asks for the provider, the model, the
variation (input, output, cache, and so on), the correct price, the first-party source URL, and the
date you saw it. That is enough for a maintainer to confirm and record it.

## Open a pull request

If you want to make the change directly:

1. Add or edit records under `data/records/<provider>.json` (an array of price records). The record
   shape is defined in [`schema/price-record.schema.json`](schema/price-record.schema.json); see
   [`examples/records/anthropic.example.json`](examples/records/anthropic.example.json) for the form.
2. Fill in the provenance fields honestly:
   - `source_url`: the provider's own pricing page (or a Wayback link for historical data).
   - `source_kind`: `provider_live`, `wayback`, `changelog`, `aggregator`, or `manual`.
   - `confidence`: `verified` for a live first-party confirmation; `archived` / `inferred` /
     `estimated` for reconstructed history.
   - `last_validated_at`: the date you confirmed this price against the source.
3. Run the validator locally and make sure it passes:
   ```bash
   node tools/validate.mjs
   ```
4. Open the PR. CI runs the same validator. A maintainer confirms the value against the first-party
   source before merging; community PRs are proposals that get vetted, not auto-merged into live data.

## What not to do

- Do not paste prices copied from an aggregator and present them as first-party. Aggregators are
  detectors and cross-checks, not the authority. Cite the provider's own page.
- Do not bulk-import another dataset. We compile our own from first-party facts on purpose (see
  [METHODOLOGY.md](METHODOLOGY.md)).
- Do not guess a historical effective date. If you are reconstructing history, cite the Wayback
  capture or changelog post and label the `confidence` accordingly.

## Corrections, not overwrites

If a recorded price was wrong, we correct it by superseding the old record, not by deleting it, so the
history of what we believed stays auditable. Note the reason in your PR description.

By contributing you agree that your data contributions are licensed under CC BY 4.0 and any code
contributions under MIT, matching the repository's licensing.
