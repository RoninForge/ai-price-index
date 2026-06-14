# Methodology

How a price gets into the AI Price Index, how it is dated, and how it is corrected. The whole value
of this dataset is that the method is honest and visible, so this document is part of the product.

## Principles

1. **Provenance over coverage.** A smaller set of prices, each with a dated first-party source, beats
   a large mirror with none. Every record carries a `source_url`, a `source_kind`, a `confidence`
   label, and a `last_validated_at` date.
2. **Detect cheaply, confirm carefully.** Aggregators and automated feeds are allowed to *detect* that
   something may have changed. They never become the authority. A human or agent *confirms* the value
   against the provider's own pricing page before it is recorded.
3. **Mirror reality, do not overwrite it.** Corrections supersede; they never silently delete. The old
   assertion and the fix both stay in the audit trail, so a wrong price is fixed in the open.
4. **Label uncertainty honestly.** Reconstructed history is marked `archived`, `inferred`, or
   `estimated` and is never presented with the same weight as a live-confirmed price.

## The bitemporal model (two clocks)

Each record tracks two independent time axes:

- **Valid time** (`effective_from`, `effective_to`): when the price was in effect in the real world.
- **Transaction time** (managed by the system of record): when we recorded or corrected that fact.

This lets the index answer both "what did model M cost on date D" and "what did we believe about that
on date D." A correction closes the prior assertion and inserts a new one, so nothing is destroyed.
The published per-model files are the resolved, currently-believed valid-time series; the bitemporal
bookkeeping lives in the system of record, not in what you download.

## Source tiers

- **Tier 1, official machine-readable.** Cloud marketplaces that publish a price API (for example
  Azure Retail Prices, the AWS Price List, the GCP Cloud Billing Catalog). Clean to read, still
  confirmed against the provider's own listing.
- **Tier 2, structured pricing page, parse and confirm by hand.** Most first-party model providers
  (Anthropic, OpenAI, Google, and so on) have no price API; the first-party source is the pricing
  PAGE. We transcribe the facts, cite the URL, and snapshot it to the Wayback Machine.
- **Tier 3, manual.** Credit-based or bespoke rate cards with no structured form.

Aggregators (for example a routed-price API or an open prices JSON) are used only as **detectors and
cross-checks**, never as the authority, and we do not bulk-mirror any single one.

## The detect, confirm, write loop

1. A scheduled job pulls the detectors and diffs them against the current data.
2. For each candidate change it opens or updates one deduplicated issue or PR, listing the detector
   value and a link to the first-party page to confirm against.
3. A human or agent confirms the value against the first-party source, sets `last_validated_at`,
   records the first-party `source_url` (and a Wayback snapshot where relevant), and writes it: close
   the old record's `effective_to`, insert the new record.
4. The export step regenerates the published artifacts and tags a release.

Automated: detection, diffing, issue/PR creation, shape validation, export. Human-gated: the value
that becomes authoritative, its first-party citation, and its validation date.

## Historical backfill

History is reconstructed flagship-first using, in order of preference: the Wayback Machine of the
provider's pricing page (using the CDX server with `collapse=digest` to find captures where the
content actually changed); provider changelog and announcement posts for exact dates; and aggregator
history only as corroboration. Each backfilled record gets a `source_kind` of `wayback`, `changelog`,
or `aggregator`, a `confidence` of `archived`, `inferred`, or `estimated`, a `source_snapshot_ts`
where applicable, and a `last_validated_at` equal to the evidence date. Pricing pages are
JS-rendered and restructured across eras, so precision is labelled honestly rather than overstated.

## Validation discipline

- CI validates every record's shape, bounds, dates (no future dates), and that each one has a
  `source_url` and a `last_validated_at`. A contribution without a dated first-party source fails by
  policy.
- A periodic re-validation pass re-confirms live prices and refreshes `last_validated_at`, so
  "last validated" never silently rots. Stale-but-labelled is acceptable; silently stale is not.
- Corrections are supersedes with a recorded reason, visible in the changelog.

## Accuracy statement

Prices change, and reconstructed history is approximate where the evidence is thin. Always read the
`confidence` label and the `source_url` on a record rather than assuming a number is current. If you
find an error, please correct it in the open (see [CONTRIBUTING.md](CONTRIBUTING.md)).
