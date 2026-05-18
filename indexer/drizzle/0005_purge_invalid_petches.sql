-- SPEC §5.8: a T_PETCH whose mint_start_height is non-zero MUST be
-- ≥ etch_height + 1, and a non-zero mint_end_height MUST be > effective_start.
-- Otherwise the asset cannot satisfy its own mint state machine (and the
-- "zero deployer allocation" invariant breaks). Such T_PETCHes are
-- permanently invalid per spec.
--
-- Going forward handlers.ts rejects them at index time. This migration
-- evicts any malformed T_PETCH rows that pre-date that fix:
--   * mark the T_PETCH envelope row as malformed
--   * delete the asset registry entry so it no longer appears anywhere
--   * mark every T_PMINT against that etch as commitment_valid=false
--     (the validator's parent lookup will already drop them, but
--     pre-marking keeps the supply numbers honest immediately)

WITH bad_petches AS (
  SELECT a.asset_id, a.etch_txid, a.mint_start_height, a.etch_height,
         a.mint_end_height
  FROM assets a
  WHERE a.kind = 't_petch'
    AND (
      (a.mint_start_height IS NOT NULL
       AND a.mint_start_height != 0
       AND a.mint_start_height < a.etch_height + 1)
      OR
      (a.mint_end_height IS NOT NULL
       AND a.mint_end_height != 0
       AND a.mint_end_height <= COALESCE(NULLIF(a.mint_start_height, 0), a.etch_height + 1))
    )
)
UPDATE envelopes
SET status = 'malformed',
    decode_error = 'T_PETCH violates §5.8 height invariants'
WHERE asset_id IN (SELECT asset_id FROM bad_petches)
  AND opcode = 'T_PETCH';

UPDATE envelopes
SET commitment_valid = false,
    commitment_checked_at = now(),
    commitment_invalid_reason = 'parent T_PETCH violates §5.8 invariants'
WHERE asset_id IN (
  SELECT asset_id FROM assets a
  WHERE a.kind = 't_petch'
    AND (
      (a.mint_start_height IS NOT NULL
       AND a.mint_start_height != 0
       AND a.mint_start_height < a.etch_height + 1)
      OR
      (a.mint_end_height IS NOT NULL
       AND a.mint_end_height != 0
       AND a.mint_end_height <= COALESCE(NULLIF(a.mint_start_height, 0), a.etch_height + 1))
    )
)
AND opcode = 'T_PMINT';

DELETE FROM assets a
WHERE a.kind = 't_petch'
  AND (
    (a.mint_start_height IS NOT NULL
     AND a.mint_start_height != 0
     AND a.mint_start_height < a.etch_height + 1)
    OR
    (a.mint_end_height IS NOT NULL
     AND a.mint_end_height != 0
     AND a.mint_end_height <= COALESCE(NULLIF(a.mint_start_height, 0), a.etch_height + 1))
  );
