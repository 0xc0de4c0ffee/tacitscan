-- Per SPEC §5.5/§5.9, a T_PMINT is only a valid mint (produces real
-- spendable supply, counts toward cap) if it passes ALL of:
--   asset_id derivation, parent envelope = T_PETCH, amount = mint_limit,
--   height window, cap not exceeded, blinding ∈ (0, n),
--   pedersenCommit(amount, blinding) == commitment, vout=0 supply UTXO.
--
-- The byte-shape decode at index time only proves the envelope LOOKS
-- like a T_PMINT — anyone can broadcast 138 bytes that decode. These
-- columns hold the result of the proper validator pass run by
-- src/validator.ts as a background loop.
--
-- commitment_valid:
--   true  = full validation passed, mint counts toward supply
--   false = one or more checks failed (see commitment_invalid_reason)
--   null  = not yet checked

ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "commitment_valid" boolean;
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "commitment_checked_at" timestamptz;
ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "commitment_invalid_reason" text;

CREATE INDEX IF NOT EXISTS "envelopes_unvalidated_pmint_idx"
  ON "envelopes" ("block_height")
  WHERE opcode = 'T_PMINT' AND status = 'ok' AND commitment_valid IS NULL;

CREATE INDEX IF NOT EXISTS "envelopes_valid_pmint_by_asset_idx"
  ON "envelopes" ("asset_id", "block_height")
  WHERE opcode = 'T_PMINT' AND commitment_valid = true;
