<!-- Thanks for contributing to the AI Price Index. The one hard rule: every price needs a first-party
     source URL and the date you confirmed it. PRs that fail the validator or lack provenance cannot
     be merged. -->

## What this changes

<!-- Which provider/model(s) and prices. Is this a correction, a new model, or backfilled history? -->

## Provenance

- [ ] Every added or changed record has a `source_url` pointing at a first-party page (or a Wayback
      link for historical data).
- [ ] Every record has a `last_validated_at` date when I confirmed it against that source.
- [ ] `confidence` is honest: `verified` only for a live first-party confirmation; `archived` /
      `inferred` / `estimated` for reconstructed history.
- [ ] I did not copy prices from an aggregator and present them as first-party.

## Validation

- [ ] `node tools/validate.mjs` passes locally.

## Notes

<!-- If this corrects a prior value, say what was wrong and why, so the change is auditable. -->
