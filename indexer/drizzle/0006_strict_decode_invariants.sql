-- Retroactively mark envelopes that violate SPEC decode invariants the
-- previous version of the decoder didn't enforce. The decoder fixes
-- (length checks, amount > 0, mint_limit > cap_amount, etc.) only
-- affect new ingest; this migration sweeps existing rows.

-- T_PMINT: exact 138-byte payload per SPEC §5.9 wire format.
UPDATE envelopes
SET status = 'malformed',
    decode_error = COALESCE(decode_error, '') || ' / payload length != 138',
    commitment_valid = false,
    commitment_checked_at = now(),
    commitment_invalid_reason = 'T_PMINT payload length != 138 (trailing bytes)'
WHERE opcode = 'T_PMINT'
  AND status = 'ok'
  AND octet_length(raw_payload) != 138;

-- T_PMINT: amount > 0 (zero amount can never equal a non-zero mint_limit
-- and is rejected by upstream decoder; align here).
UPDATE envelopes
SET status = 'malformed',
    decode_error = COALESCE(decode_error, '') || ' / amount must be > 0',
    commitment_valid = false,
    commitment_checked_at = now(),
    commitment_invalid_reason = 'T_PMINT amount = 0'
WHERE opcode = 'T_PMINT'
  AND status = 'ok'
  AND public_amount = 0;

-- T_PETCH: mint_limit > cap_amount is structurally invalid (cap unreachable).
-- The implicit check via cap_amount % mint_limit was nuanced; make it explicit.
WITH bad AS (
  SELECT a.asset_id
  FROM assets a
  WHERE a.kind = 't_petch'
    AND a.cap_amount IS NOT NULL
    AND a.mint_limit IS NOT NULL
    AND a.mint_limit > a.cap_amount
)
UPDATE envelopes
SET status = 'malformed',
    decode_error = COALESCE(decode_error, '') || ' / mint_limit > cap_amount'
WHERE asset_id IN (SELECT asset_id FROM bad)
  AND opcode = 'T_PETCH';

WITH bad AS (
  SELECT a.asset_id
  FROM assets a
  WHERE a.kind = 't_petch'
    AND a.cap_amount IS NOT NULL
    AND a.mint_limit IS NOT NULL
    AND a.mint_limit > a.cap_amount
)
UPDATE envelopes
SET commitment_valid = false,
    commitment_checked_at = now(),
    commitment_invalid_reason = 'parent T_PETCH has mint_limit > cap_amount'
WHERE asset_id IN (SELECT asset_id FROM bad)
  AND opcode = 'T_PMINT';

DELETE FROM assets
WHERE kind = 't_petch'
  AND cap_amount IS NOT NULL
  AND mint_limit IS NOT NULL
  AND mint_limit > cap_amount;
