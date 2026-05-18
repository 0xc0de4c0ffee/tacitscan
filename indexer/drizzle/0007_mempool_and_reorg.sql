-- Mempool indexing + reorg-aware chain status.
--
-- Adds:
--   - `chain_status` lifecycle column on envelopes ('mempool'|'confirmed'|'orphaned')
--   - `first_seen_at` for the moment we first observed the tx
--   - nullable block_height/block_hash/block_time/tx_index since mempool
--     rows have no block yet (we backfill these when the block lands)
--   - `blocks` table: per-network record of every processed block height
--     so the reorg detector can walk back to a common ancestor

ALTER TABLE envelopes
  ALTER COLUMN block_height DROP NOT NULL,
  ALTER COLUMN block_hash   DROP NOT NULL,
  ALTER COLUMN block_time   DROP NOT NULL,
  ALTER COLUMN tx_index     DROP NOT NULL;

ALTER TABLE envelopes
  ADD COLUMN IF NOT EXISTS chain_status  text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();

-- Existing rows came from confirmed blocks. Reaffirm explicitly.
UPDATE envelopes SET chain_status = 'confirmed' WHERE chain_status <> 'confirmed';

ALTER TABLE envelopes
  ADD CONSTRAINT envelopes_chain_status_check
  CHECK (chain_status IN ('mempool', 'confirmed', 'orphaned'));

-- Backfill first_seen_at to block_time for confirmed rows so the column
-- doesn't pretend everything was seen "just now" after the migration.
UPDATE envelopes SET first_seen_at = block_time WHERE block_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS envelopes_chain_status_idx
  ON envelopes (chain_status, network);

CREATE INDEX IF NOT EXISTS envelopes_first_seen_idx
  ON envelopes (first_seen_at DESC)
  WHERE chain_status = 'mempool';

-- Per-block ledger for reorg detection. Records every height we processed,
-- not only ones with envelopes, so the reorg walker has a continuous chain
-- of hashes to compare against canonical.
CREATE TABLE IF NOT EXISTS blocks (
  network      text        NOT NULL,
  height       integer     NOT NULL,
  block_hash   text        NOT NULL,
  block_time   timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, height)
);

CREATE INDEX IF NOT EXISTS blocks_network_hash_idx ON blocks (network, block_hash);
