// Per-opcode persistence. Each handler takes a decoded envelope + tx
// context and writes rows to Postgres. Idempotent via primary keys —
// safe to re-run on the same block.
import type { DB } from "./db.js";
import { schema } from "./db.js";
import {
  bytesToHex,
  deriveAssetId,
  type DecodedEnvelope,
  type DecodeResult,
} from "./envelope.js";
import { extractSpendingPubkey } from "./script.js";
import type { EsploraTx } from "./esplora.js";

export interface BlockCtx {
  network: string;
  height: number;
  blockHash: string;
  blockTime: Date;
}

export interface TxCtx extends BlockCtx {
  txid: string;
  txIndex: number;
  inputCount: number;
  outputCount: number;
  feeSats: bigint | null;
}

// Promotion-set for ON CONFLICT (txid) DO UPDATE when a confirmed block
// includes a tx we already had as 'mempool' (or 'orphaned' from a prior
// reorg). Block fields become authoritative; raw_* / decoded fields are
// trusted from the earlier insert since the envelope can't change without
// the txid changing.
function envelopeConfirmSet(ctx: TxCtx) {
  return {
    blockHeight: ctx.height,
    blockHash: ctx.blockHash,
    blockTime: ctx.blockTime,
    txIndex: ctx.txIndex,
    chainStatus: "confirmed" as const,
  };
}

export async function persistEnvelope(
  db: DB,
  tx: EsploraTx,
  ctx: TxCtx,
  result: DecodeResult,
  rawWitness: Uint8Array,
): Promise<void> {
  // SPEC §5: every Tacit envelope-bearing input has the canonical leaf-script
  // shape `<32B pubkey> OP_CHECKSIG OP_FALSE OP_IF ...`. The pubkey is the
  // holder's tacit_pubkey — what verifies the spend. We surface this in the
  // address-page Activity tab. Null for shape-malformed witnesses.
  const spendingPubkey = extractSpendingPubkey(rawWitness);

  // Malformed / unknown envelope — record minimal row so the explorer can
  // still surface the tx.
  if (!result.ok) {
    await db
      .insert(schema.envelopes)
      .values({
        txid: ctx.txid,
        network: ctx.network,
        opcode: "UNKNOWN",
        blockHeight: ctx.height,
        blockHash: ctx.blockHash,
        blockTime: ctx.blockTime,
        txIndex: ctx.txIndex,
        inputCount: ctx.inputCount,
        outputCount: ctx.outputCount,
        feeSats: ctx.feeSats,
        rawWitness,
        rawPayload: result.rawPayload ?? new Uint8Array(0),
        status: "malformed",
        decodeError: result.reason,
        spendingPubkey,
      })
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    return;
  }

  const env = result.envelope;
  const base = {
    txid: ctx.txid,
    network: ctx.network,
    opcode: env.opcode,
    blockHeight: ctx.height,
    blockHash: ctx.blockHash,
    blockTime: ctx.blockTime,
    txIndex: ctx.txIndex,
    inputCount: ctx.inputCount,
    outputCount: ctx.outputCount,
    feeSats: ctx.feeSats,
    rawWitness,
    rawPayload: result.rawPayload,
    status: "ok",
    spendingPubkey,
  } as const;

  switch (env.opcode) {
    case "CETCH":
      return persistCetch(db, env, ctx, base);
    case "T_PETCH":
      return persistTPetch(db, env, ctx, base);
    case "T_MINT":
      return persistTMint(db, env, ctx, base);
    case "T_PMINT":
      return persistTPmint(db, env, ctx, base);
    case "CXFER":
      return persistCxfer(db, env, ctx, base);
    case "T_AXFER":
      return persistTAxfer(db, env, ctx, base);
    case "T_BURN":
      return persistTBurn(db, env, ctx, base);
    case "T_DEPOSIT":
      return persistTDeposit(db, env, ctx, base);
    case "T_WITHDRAW":
      return persistTWithdraw(db, env, ctx, base);
  }
}

async function persistCetch(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "CETCH" }>,
  ctx: TxCtx,
  base: object,
) {
  const assetId = deriveAssetId(ctx.txid, 0);
  const isMintable = !env.mintAuthority.every((b) => b === 0);
  await db.transaction(async (t) => {
    await t
      .insert(schema.assets)
      .values({
        assetId,
        network: ctx.network,
        kind: "cetch",
        ticker: env.ticker,
        decimals: env.decimals,
        imageUri: env.imageUri || null,
        mintAuthority: isMintable ? bytesToHex(env.mintAuthority) : null,
        etchTxid: ctx.txid,
        etchHeight: ctx.height,
        etchBlockTime: ctx.blockTime,
      })
      .onConflictDoNothing();
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId,
        rangeproof: env.rangeproof,
        n: 1,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId,
        commitmentC: env.commitmentC,
        encryptedAmount: env.amountCt,
        blockHeight: ctx.height,
      })
      .onConflictDoNothing();
  });
}

async function persistTPetch(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_PETCH" }>,
  ctx: TxCtx,
  base: object,
) {
  const assetId = deriveAssetId(ctx.txid, 0);

  // SPEC §5.8 invariants enforced at indexing time:
  //   mint_start_height (if non-zero) MUST be ≥ etch_height + 1
  //     — defends the "zero deployer allocation" property by preventing
  //       same-block deployer pre-mining.
  //   mint_end_height (if non-zero) MUST be > effective_start
  //     — otherwise the window is empty and the asset can never mint.
  // A T_PETCH violating either is permanently invalid; we record the
  // envelope as malformed and skip the assets-table insert so the bad
  // T_PETCH never enters the registry.
  const effectiveStart = env.mintStartHeight !== 0 ? env.mintStartHeight : ctx.height + 1;
  let invalidReason: string | null = null;
  if (env.mintStartHeight !== 0 && env.mintStartHeight < ctx.height + 1) {
    invalidReason = `mint_start_height ${env.mintStartHeight} < etch_height+1 (${ctx.height + 1})`;
  } else if (env.mintEndHeight !== 0 && env.mintEndHeight <= effectiveStart) {
    invalidReason = `mint_end_height ${env.mintEndHeight} <= effective_start ${effectiveStart}`;
  }

  if (invalidReason) {
    await db
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId,
        status: "malformed",
        decodeError: invalidReason,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    return;
  }

  await db.transaction(async (t) => {
    await t
      .insert(schema.assets)
      .values({
        assetId,
        network: ctx.network,
        kind: "t_petch",
        ticker: env.ticker,
        decimals: env.decimals,
        imageUri: env.imageUri || null,
        capAmount: env.capAmount,
        mintLimit: env.mintLimit,
        mintStartHeight: env.mintStartHeight,
        mintEndHeight: env.mintEndHeight,
        etchTxid: ctx.txid,
        etchHeight: ctx.height,
        etchBlockTime: ctx.blockTime,
      })
      .onConflictDoNothing();
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    // T_PETCH produces NO tacit UTXO — no commitment row.
  });
}

async function persistTMint(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_MINT" }>,
  ctx: TxCtx,
  base: object,
) {
  const expected = deriveAssetId(env.etchTxid, 0);
  const ok = expected === env.assetId;
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        etchTxid: env.etchTxid,
        rangeproof: env.rangeproof,
        issuerSig: env.issuerSig,
        n: 1,
        status: ok ? "ok" : "malformed",
        decodeError: ok ? null : "asset_id != sha256(etch_txid || 0)",
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId: env.assetId,
        commitmentC: env.commitmentC,
        encryptedAmount: env.amountCt,
        blockHeight: ctx.height,
      })
      .onConflictDoNothing();
  });
}

async function persistTPmint(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_PMINT" }>,
  ctx: TxCtx,
  base: object,
) {
  const expected = deriveAssetId(env.etchTxid, 0);
  const ok = expected === env.assetId;
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        etchTxid: env.etchTxid,
        publicAmount: env.amount,
        n: 1,
        status: ok ? "ok" : "malformed",
        decodeError: ok ? null : "asset_id != sha256(etch_txid || 0)",
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId: env.assetId,
        commitmentC: env.commitmentC,
        encryptedAmount: null,
        blockHeight: ctx.height,
        isPublicOpening: true,
        publicAmount: env.amount,
        publicBlinding: env.blinding,
      })
      .onConflictDoNothing();
  });
}

async function persistCxfer(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "CXFER" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
        n: env.n,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    if (env.outputs.length > 0) {
      await t
        .insert(schema.commitments)
        .values(
          env.outputs.map((o) => ({
            txid: ctx.txid,
            vout: o.vout,
            network: ctx.network,
            assetId: env.assetId,
            commitmentC: o.commitmentC,
            encryptedAmount: o.encryptedAmount,
            blockHeight: ctx.height,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function persistTAxfer(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_AXFER" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
        n: env.n,
        assetInputCount: env.assetInputCount,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    if (env.outputs.length > 0) {
      await t
        .insert(schema.commitments)
        .values(
          env.outputs.map((o) => ({
            txid: ctx.txid,
            vout: o.vout,
            network: ctx.network,
            assetId: env.assetId,
            commitmentC: o.commitmentC,
            encryptedAmount: o.encryptedAmount,
            blockHeight: ctx.height,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function persistTBurn(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_BURN" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
        burnedAmount: env.burnedAmount,
        publicAmount: env.burnedAmount,
        n: env.n,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    if (env.outputs.length > 0) {
      await t
        .insert(schema.commitments)
        .values(
          env.outputs.map((o) => ({
            txid: ctx.txid,
            vout: o.vout,
            network: ctx.network,
            assetId: env.assetId,
            commitmentC: o.commitmentC,
            encryptedAmount: o.encryptedAmount,
            blockHeight: ctx.height,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function persistTDeposit(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_DEPOSIT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomination: env.isPoolInit ? env.poolDenom : env.denomination,
      kernelSig: env.isPoolInit ? null : env.kernelSig,
      issuerSig: env.isPoolInit ? env.initSig : null,
      isPoolInit: env.isPoolInit,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
  // T_DEPOSIT produces no tacit UTXO.
}

async function persistTWithdraw(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_WITHDRAW" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        denomination: env.denomination,
        publicAmount: env.denomination,
        merkleRoot: bytesToHex(env.merkleRoot),
        nullifierHash: bytesToHex(env.nullifierHash),
        proofBytes: env.proof,
        n: 1,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId: env.assetId,
        commitmentC: env.recipientCommitment,
        encryptedAmount: null,
        blockHeight: ctx.height,
        isPublicOpening: true,
        publicAmount: env.denomination,
      })
      .onConflictDoNothing();
  });
}
