CREATE TABLE IF NOT EXISTS "cursor" (
  "network" text PRIMARY KEY NOT NULL,
  "last_indexed_height" integer NOT NULL,
  "last_indexed_block_hash" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "assets" (
  "asset_id" text PRIMARY KEY NOT NULL,
  "network" text NOT NULL,
  "kind" text NOT NULL,
  "ticker" text NOT NULL,
  "decimals" integer NOT NULL,
  "image_uri" text,
  "creator_pubkey" text,
  "mint_authority" text,
  "cap_amount" bigint,
  "mint_limit" bigint,
  "mint_start_height" integer,
  "mint_end_height" integer,
  "etch_txid" text NOT NULL,
  "etch_height" integer NOT NULL,
  "etch_block_time" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "assets_ticker_idx" ON "assets" ("ticker");
CREATE INDEX IF NOT EXISTS "assets_network_height_idx" ON "assets" ("network","etch_height");

CREATE TABLE IF NOT EXISTS "envelopes" (
  "txid" text PRIMARY KEY NOT NULL,
  "network" text NOT NULL,
  "opcode" text NOT NULL,
  "asset_id" text,
  "block_height" integer NOT NULL,
  "block_hash" text NOT NULL,
  "block_time" timestamptz NOT NULL,
  "tx_index" integer NOT NULL,
  "input_count" integer NOT NULL,
  "output_count" integer NOT NULL,
  "fee_sats" bigint,
  "burned_amount" bigint,
  "public_amount" bigint,
  "n" integer,
  "asset_input_count" integer,
  "denomination" bigint,
  "etch_txid" text,
  "is_pool_init" boolean NOT NULL DEFAULT false,
  "raw_witness" bytea NOT NULL,
  "raw_payload" bytea NOT NULL,
  "kernel_sig" bytea,
  "issuer_sig" bytea,
  "rangeproof" bytea,
  "proof_bytes" bytea,
  "merkle_root" text,
  "nullifier_hash" text,
  "status" text NOT NULL DEFAULT 'ok',
  "decode_error" text
);

CREATE INDEX IF NOT EXISTS "envelopes_network_height_idx" ON "envelopes" ("network","block_height");
CREATE INDEX IF NOT EXISTS "envelopes_asset_idx" ON "envelopes" ("asset_id","block_height");
CREATE INDEX IF NOT EXISTS "envelopes_opcode_idx" ON "envelopes" ("opcode","block_height");
CREATE INDEX IF NOT EXISTS "envelopes_height_desc_idx" ON "envelopes" ("block_height");

CREATE TABLE IF NOT EXISTS "commitments" (
  "txid" text NOT NULL,
  "vout" integer NOT NULL,
  "network" text NOT NULL,
  "asset_id" text NOT NULL,
  "commitment_c" bytea NOT NULL,
  "encrypted_amount" bytea,
  "block_height" integer NOT NULL,
  "is_public_opening" boolean NOT NULL DEFAULT false,
  "public_amount" bigint,
  "public_blinding" bytea,
  PRIMARY KEY ("txid","vout")
);

CREATE INDEX IF NOT EXISTS "commitments_asset_idx" ON "commitments" ("asset_id","block_height");

CREATE TABLE IF NOT EXISTS "disclosures" (
  "id" text PRIMARY KEY NOT NULL,
  "asset_id" text NOT NULL,
  "owner_pubkey" text NOT NULL,
  "threshold" bigint NOT NULL,
  "utxos" text[] NOT NULL,
  "rangeproof" bytea NOT NULL,
  "sig" bytea NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
