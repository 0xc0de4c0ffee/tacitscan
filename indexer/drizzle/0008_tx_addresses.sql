-- Per-tx address index. For each confirmed tacit tx, we record the
-- distinct Bitcoin addresses appearing on the vin (prevout) and vout
-- sides. This powers the address page's "interacted with" section.
--
-- Important: in Tacit, asset OWNERSHIP is hidden behind Pedersen
-- commitments and the taproot internal pubkey is NUMS-Hash, so the
-- addresses indexed here are fee payers and change recipients — NOT
-- the asset sender/receiver. The UI should make this distinction
-- clear with a tooltip.
--
-- We restrict to P2TR (`scriptpubkey_type = 'v1_p2tr'`) at indexing
-- time since that's the only form the address page accepts. Indexing
-- non-P2TR types would be storage we'd never query against.

CREATE TABLE IF NOT EXISTS tx_addresses (
  network text    NOT NULL,
  txid    text    NOT NULL,
  address text    NOT NULL,
  role    text    NOT NULL,            -- 'input' | 'output'
  PRIMARY KEY (network, txid, address, role)
);

CREATE INDEX IF NOT EXISTS tx_addresses_addr_idx ON tx_addresses (address, network);
