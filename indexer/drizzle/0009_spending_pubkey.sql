-- Per-envelope spending pubkey. Extracted from vin[0].witness[1] at index
-- time: the script starts with `<32-byte pubkey> OP_CHECKSIG ...`, so the
-- first 32-byte push is the holder's tacit_pubkey that signed the spend.
--
-- Powers the address page's "Activity" tab — every envelope a pubkey signed
-- (CXFER spends, T_BURN, T_AXFER, T_DEPOSIT, T_PMINT, T_DCLAIM, etc.) is
-- publicly attributable to it per SPEC §5. This is not new disclosure; it's
-- the same on-chain data the witness already reveals, indexed for query.
--
-- Nullable because (a) very old / malformed envelopes whose witness doesn't
-- match the canonical `<pubkey> OP_CHECKSIG OP_FALSE OP_IF ...` shape have
-- no recoverable spender, and (b) the inline backfill on startup fills this
-- in for historical rows lazily.

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS spending_pubkey text;

CREATE INDEX IF NOT EXISTS envelopes_spending_pubkey_idx
  ON envelopes (network, spending_pubkey, block_height DESC);
