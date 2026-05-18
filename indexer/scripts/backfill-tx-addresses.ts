// One-shot backfill for the tx_addresses table.
//
// Walks every confirmed envelope row, refetches each tx from Esplora to
// resolve vin prevouts (dRPC's getblock v2 didn't include them so the
// per-block path can't harvest input addresses without an extra call),
// and inserts P2TR addresses with role='input'|'output'.
//
// Idempotent: PK on (network, txid, address, role) + ON CONFLICT DO
// NOTHING. Safe to interrupt and re-run — already-indexed txids are
// skipped at the SELECT step so we don't re-fetch them.
//
// Usage:
//   pnpm tsx scripts/backfill-tx-addresses.ts          # default 8 workers
//   CONCURRENCY=16 pnpm tsx scripts/backfill-tx-addresses.ts
//
// Required env (same as the indexer's):
//   DATABASE_URL, BITCOIN_NETWORK, ESPLORA_URL (optional override),
//   ESPLORA_FALLBACK_URL (optional)
import { sql } from "drizzle-orm";
import { db } from "../src/db.js";
import { indexTxAddresses, buildSource, loadConfig } from "../src/indexer.js";

async function main() {
  const cfg = loadConfig();
  const source = buildSource(cfg);
  const concurrency = Number(process.env.CONCURRENCY ?? 8);

  // Pull every confirmed envelope that doesn't yet have ANY tx_addresses
  // row. The "doesn't yet have any row" check is what makes the backfill
  // resumable — partial runs leave half the rows untouched, and we skip
  // them on the next invocation.
  const rows = await db.execute<{ txid: string }>(sql`
    SELECT e.txid
    FROM envelopes e
    WHERE e.network = ${cfg.network}
      AND e.chain_status = 'confirmed'
      AND NOT EXISTS (
        SELECT 1 FROM tx_addresses ta
        WHERE ta.network = e.network AND ta.txid = e.txid
      )
    ORDER BY e.block_height ASC
  `);
  console.log(`backfill: ${rows.length} txs need address indexing`);
  if (rows.length === 0) {
    process.exit(0);
  }

  let done = 0;
  let failed = 0;
  let nextIdx = 0;
  const startedAt = Date.now();

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= rows.length) return;
      const txid = rows[i]!.txid;
      try {
        const tx = await source.fetchTx(txid);
        await indexTxAddresses(source, cfg.network, tx);
        done++;
      } catch (e) {
        failed++;
        console.warn(`tx ${txid}: ${(e as Error).message}`);
      }
      if ((done + failed) % 50 === 0) {
        const rate = ((done + failed) / ((Date.now() - startedAt) / 1000)).toFixed(1);
        console.log(
          `progress: ${done + failed}/${rows.length} (ok=${done} fail=${failed}) @ ${rate} tx/s`,
        );
      }
    }
  });
  await Promise.all(workers);

  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`done: ok=${done} fail=${failed} in ${took}s`);
  process.exit(failed > 0 && done === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("backfill failed:", e);
  process.exit(1);
});
