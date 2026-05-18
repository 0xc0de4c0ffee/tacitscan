-- T_MINT issuer-signature validation per SPEC §5.3.
-- Anyone can broadcast a T_MINT-shaped envelope, but only the holder of
-- the parent CETCH's mint_authority key can produce a valid BIP-340
-- Schnorr signature over tacit-mint-v1 (asset_id || commit_anchor ||
-- commitment || amount_ct). These columns hold the verifier's verdict.
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "issuer_sig_valid" boolean;
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "issuer_sig_checked_at" timestamptz;
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "issuer_sig_invalid_reason" text;

CREATE INDEX IF NOT EXISTS "envelopes_unvalidated_mint_idx"
  ON "envelopes" ("block_height")
  WHERE opcode = 'T_MINT' AND status = 'ok' AND issuer_sig_valid IS NULL;

CREATE INDEX IF NOT EXISTS "envelopes_valid_mint_by_asset_idx"
  ON "envelopes" ("asset_id", "block_height")
  WHERE opcode = 'T_MINT' AND issuer_sig_valid = true;
