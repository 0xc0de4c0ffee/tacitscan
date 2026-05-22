// One-shot backfill of envelopes.commit_txid for historical rows.
// Every tacit envelope sits in vin[0]'s witness on a P2TR script-path
// spend, so the prior tx (vin[0].txid) is its commit half. Storing it
// lets /tx/<commit_txid> resolve to the same envelope page — the commit
// half has no envelope of its own and would otherwise 404.
//
// Idempotent: we mark rows that we've checked with a sentinel single
// hyphen if vin[0] can't be resolved (data-source error after retries,
// or the unlikely coinbase-witness edge case). Real commit_txids are
// 64-hex so the sentinel never collides.
//
// Cost: one Esplora fetchTx per NULL row, bounded by RATE_LIMIT_MS to
// stay polite with the free mempool.space allowance. ~thousand
// historical envelopes → ~30s at 30ms/req. Subsequent starts find an
// empty result set and return immediately.

import { db, schema } from "./db.js";
import { sql, eq } from "drizzle-orm";
import { loadConfig, buildSource } from "./indexer.js";

const BATCH = 200;
const RATE_LIMIT_MS = 30;
const SENTINEL_UNRESOLVED = "-";

function isTxidHex(s: string | null | undefined): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

export async function backfillCommitTxid(): Promise<void> {
  const cfg = loadConfig();
  const source = buildSource(cfg);
  let totalProcessed = 0;
  let totalUpdated = 0;
  for (;;) {
    const rows = await db
      .select({ txid: schema.envelopes.txid })
      .from(schema.envelopes)
      .where(sql`${schema.envelopes.commitTxid} IS NULL`)
      .limit(BATCH);
    if (rows.length === 0) break;

    for (const row of rows) {
      totalProcessed++;
      let commitTxid: string | null = null;
      try {
        const tx = await source.fetchTx(row.txid);
        const v0 = tx.vin[0]?.txid;
        commitTxid = isTxidHex(v0) ? v0 : null;
      } catch (e) {
        console.warn(
          `[backfill-commit-txid] fetchTx(${row.txid}) failed: ${(e as Error).message}`,
        );
      }
      await db
        .update(schema.envelopes)
        .set({ commitTxid: commitTxid ?? SENTINEL_UNRESOLVED })
        .where(eq(schema.envelopes.txid, row.txid));
      if (commitTxid) totalUpdated++;
      if (RATE_LIMIT_MS > 0) {
        await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
      }
    }
    if (totalProcessed % 1000 === 0) {
      console.log(
        `[backfill-commit-txid] processed ${totalProcessed}, updated ${totalUpdated}`,
      );
    }
  }
  if (totalProcessed > 0) {
    console.log(
      `[backfill-commit-txid] done: processed ${totalProcessed}, updated ${totalUpdated}`,
    );
  }
}
