-- Per-envelope commit txid. Every tacit envelope sits in vin[0]'s witness
-- on a P2TR script-path spend, so the prior tx (vin[0].txid) is its commit
-- half. The commit tx itself has no envelope and would otherwise 404 on
-- the /tx page; storing commit_txid here lets the frontend resolve
-- /tx/<commit_txid> to the same envelope row.
--
-- Nullable because the inline backfill fills historical rows lazily.

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS commit_txid text;

CREATE INDEX IF NOT EXISTS envelopes_commit_txid_idx
  ON envelopes (commit_txid);
