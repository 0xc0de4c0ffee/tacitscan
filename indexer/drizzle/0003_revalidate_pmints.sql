-- Re-validate all T_PMINTs once. The validator now enforces SPEC §5.9
-- step 4 (height window: a T_PMINT confirmed at a block before
-- petch.etch_height + 1 is permanently invalid). Rows validated by the
-- previous version of the validator passed without that check, so
-- ~75% of FAIR's "valid" rows were actually pre-deploy spam.
--
-- This migration runs once per the _migrations table. The validator
-- background loop picks up the cleared rows and re-checks them.
UPDATE envelopes
SET commitment_valid = NULL,
    commitment_checked_at = NULL,
    commitment_invalid_reason = NULL
WHERE opcode = 'T_PMINT';
