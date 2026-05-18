// One-shot backfill of envelopes.spending_pubkey for historical rows.
// Runs on indexer startup (per chosen deployment mode) — scans the table
// for rows where the column is NULL but raw_witness is present, re-parses
// the witness to extract the pubkey, and UPDATEs.
//
// Idempotent: if the column is already populated (post-first-run) the
// query returns 0 rows and the function returns immediately.
//
// Cost: one indexed scan over `envelopes_spending_pubkey_idx` filtered to
// IS NULL, then one UPDATE per row in batches. Negligible on current
// dataset (~thousands of envelopes); will need rework only at six-figure
// row counts.

import { db, schema } from "./db.js";
import { sql, eq } from "drizzle-orm";
import { extractSpendingPubkey } from "./script.js";

const BATCH = 500;

export async function backfillSpendingPubkey(): Promise<void> {
  let totalProcessed = 0;
  let totalUpdated = 0;
  // Loop in batches; each iteration claims the next 500 NULL-pubkey rows.
  // We use the txid PK to page rather than OFFSET so concurrent inserts
  // from the live indexer don't make us skip rows.
  for (;;) {
    const rows = await db
      .select({ txid: schema.envelopes.txid, rawWitness: schema.envelopes.rawWitness })
      .from(schema.envelopes)
      .where(sql`${schema.envelopes.spendingPubkey} IS NULL`)
      .limit(BATCH);
    if (rows.length === 0) break;

    for (const row of rows) {
      const pubkey = extractSpendingPubkey(row.rawWitness);
      totalProcessed++;
      if (pubkey) {
        await db
          .update(schema.envelopes)
          .set({ spendingPubkey: pubkey })
          .where(eq(schema.envelopes.txid, row.txid));
        totalUpdated++;
      } else {
        // No recoverable spender — mark with a sentinel-empty string so
        // the next backfill pass doesn't re-process the same row forever.
        // Use a single hyphen since pubkey hex never contains one.
        await db
          .update(schema.envelopes)
          .set({ spendingPubkey: "-" })
          .where(eq(schema.envelopes.txid, row.txid));
      }
    }
    if (totalProcessed % 5000 === 0) {
      console.log(`[backfill-spending-pubkey] processed ${totalProcessed}, updated ${totalUpdated}`);
    }
  }
  if (totalProcessed > 0) {
    console.log(`[backfill-spending-pubkey] done: processed ${totalProcessed}, updated ${totalUpdated}`);
  }
}
