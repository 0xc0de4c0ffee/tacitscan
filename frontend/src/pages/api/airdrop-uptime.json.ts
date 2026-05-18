// Debug/data endpoint for the airdrop uptime histogram. Returns
// hourly CXFER counts for the TAC asset over the last 24h. Used by
// the /airdrop/queue page, and curl-able for live debugging when the
// page-side render isn't behaving (you'll see the actual SQL error or
// the raw rows here, not a silent empty histogram).
import type { APIRoute } from "astro";
import { db, schema } from "../../db";
import { sql, and, eq } from "drizzle-orm";

export const prerender = false;

const ASSET_ID = "f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b";

export const GET: APIRoute = async ({ url }) => {
  const network = url.searchParams.get("network") || "mainnet";
  const bucketSeconds = Number(url.searchParams.get("bucket_seconds") || "3600");
  const totalBuckets = Number(url.searchParams.get("total_buckets") || "24");

  const now = new Date();
  // Floor to bucket boundary for clean grouping.
  if (bucketSeconds >= 3600) now.setMinutes(0, 0, 0);
  else { now.setSeconds(0, 0); now.setMinutes(Math.floor(now.getMinutes() / (bucketSeconds / 60)) * (bucketSeconds / 60)); }
  const start = new Date(now.getTime() - (totalBuckets - 1) * bucketSeconds * 1000);
  const startISO = start.toISOString();

  // First: confirm the indexer has *any* recent CXFER rows for this
  // asset, without bucketing. Helps distinguish "no data" from "bucket
  // query is broken".
  let recentSample: unknown[] = [];
  let recentErr: string | null = null;
  try {
    const rows = await db
      .select({
        txid: schema.envelopes.txid,
        blockTime: schema.envelopes.blockTime,
        blockHeight: schema.envelopes.blockHeight,
        chainStatus: schema.envelopes.chainStatus,
      })
      .from(schema.envelopes)
      .where(
        and(
          eq(schema.envelopes.network, network),
          eq(schema.envelopes.assetId, ASSET_ID),
          eq(schema.envelopes.opcode, "CXFER"),
        ),
      )
      .orderBy(sql`block_height DESC NULLS FIRST`)
      .limit(5);
    recentSample = rows;
  } catch (e) {
    recentErr = (e as Error).message?.slice(0, 200) ?? "unknown";
  }

  // Now the bucketing query.
  let buckets: unknown[] = [];
  let bucketErr: string | null = null;
  try {
    if (bucketSeconds === 3600) {
      const rows = await db.execute<{ bucket: Date; cnt: number }>(sql`
        SELECT date_trunc('hour', block_time) AS bucket, COUNT(*)::int AS cnt
        FROM envelopes
        WHERE network = ${network}
          AND asset_id = ${ASSET_ID}
          AND opcode = 'CXFER'
          AND chain_status <> 'orphaned'
          AND block_time >= ${startISO}
        GROUP BY 1
        ORDER BY 1
      `);
      buckets = rows;
    } else {
      const rows = await db.execute<{ bucket: Date; cnt: number }>(sql`
        SELECT to_timestamp(floor(extract(epoch from block_time) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
               COUNT(*)::int AS cnt
        FROM envelopes
        WHERE network = ${network}
          AND asset_id = ${ASSET_ID}
          AND opcode = 'CXFER'
          AND chain_status <> 'orphaned'
          AND block_time >= ${startISO}
        GROUP BY 1
        ORDER BY 1
      `);
      buckets = rows;
    }
  } catch (e) {
    bucketErr = (e as Error).message?.slice(0, 200) ?? "unknown";
  }

  return new Response(JSON.stringify({
    network,
    asset_id: ASSET_ID,
    bucket_seconds: bucketSeconds,
    total_buckets: totalBuckets,
    range_start: startISO,
    range_end: now.toISOString(),
    recent_sample_count: Array.isArray(recentSample) ? recentSample.length : 0,
    recent_sample_err: recentErr,
    recent_sample: recentSample,
    bucket_rows_count: Array.isArray(buckets) ? buckets.length : 0,
    bucket_rows_err: bucketErr,
    bucket_rows: buckets,
  }, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
