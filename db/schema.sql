-- ai-price-index system-of-record schema (SQLite, WAL).
-- Bitemporal, modelled as bi-temporal SCD Type 2 (see METHODOLOGY.md):
--   valid time      = effective_from / effective_to  (when a price was in effect in the world)
--   transaction time = recorded_at / superseded_at   (when we asserted or corrected the fact)
-- A correction closes the prior assertion (sets superseded_at) and inserts a new row; nothing is
-- destroyed, so the audit trail is intact. last_validated_at is first-class and required on every
-- row, including historical ones (the provenance rule).

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS price_records (
  record_id          TEXT PRIMARY KEY,        -- uuid
  provider           TEXT NOT NULL,           -- 'anthropic', 'openai', ...
  model_id           TEXT NOT NULL,           -- canonical slug, preferably the dated snapshot id
  variation          TEXT NOT NULL,           -- 'input' | 'output' | 'cache_read' | ...
  unit               TEXT NOT NULL,           -- 'usd_per_mtok' | 'usd_per_image' | ...
  price_usd          NUMERIC NOT NULL,

  -- VALID TIME (real world)
  effective_from     TEXT NOT NULL,           -- date, inclusive
  effective_to       TEXT,                    -- date, exclusive; NULL = current

  -- TRANSACTION TIME (system)
  recorded_at        TEXT NOT NULL,           -- timestamp, inclusive
  superseded_at      TEXT,                    -- timestamp, exclusive; NULL = currently believed

  -- VALIDATION + provenance (the moat; always populated, incl. historical rows)
  last_validated_at  TEXT NOT NULL,           -- when this price was last CONFIRMED against its source
  source_url         TEXT NOT NULL,           -- first-party page or archive link
  source_kind        TEXT NOT NULL,           -- 'provider_live'|'wayback'|'changelog'|'aggregator'|'manual'
  source_snapshot_ts TEXT,                    -- Wayback capture stamp, else NULL
  confidence         TEXT NOT NULL,           -- 'verified'|'archived'|'inferred'|'estimated'

  -- correction audit trail
  supersedes_id      TEXT REFERENCES price_records(record_id),
  change_reason      TEXT,                    -- 'initial'|'correction'|'restate'
  recorded_by        TEXT                     -- agent/job/human id
);

-- Fast lookup of the currently-believed series.
CREATE INDEX IF NOT EXISTS ix_pr_current
  ON price_records (provider, model_id, variation, effective_from)
  WHERE superseded_at IS NULL;

-- Export + housekeeping bookkeeping.
CREATE TABLE IF NOT EXISTS aipi_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
