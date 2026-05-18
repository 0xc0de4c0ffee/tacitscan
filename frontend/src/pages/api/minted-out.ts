// Cross-indexer fairness gate. Returns the set of T_PETCH asset_ids
// that have reached their cap per our validator (Pedersen + parent +
// amount + height-window verification per SPEC §5.9). Designed to be
// consumed by the upstream Tacit dapp as a defensive secondary check —
// when the dapp's primary worker is stale and the user's browser-side
// scan hasn't caught up, this list lets the dapp disable the Mint
// button so users don't burn fees on cap-overflow attempts.
//
// CORS: allow-origin * since the dapp at tacit.finance reads
// cross-origin from tacitscan.io.
import type { APIRoute } from "astro";
import { sql } from "drizzle-orm";
import { db } from "../../db";

export const prerender = false;

type Row = {
  asset_id: string;
  ticker: string;
  cap_amount: string;
  mint_limit: string;
  valid_count: number;
  slots_total: number;
};

export const GET: APIRoute = async () => {
  const network = import.meta.env.PUBLIC_NETWORK ?? "mainnet";
  const rows = await db.execute<Row>(sql`
    WITH stats AS (
      SELECT
        a.asset_id,
        a.ticker,
        a.cap_amount::text AS cap_amount,
        a.mint_limit::text AS mint_limit,
        (a.cap_amount / a.mint_limit)::int AS slots_total,
        (
          SELECT COUNT(*)::int FROM envelopes e
          WHERE e.asset_id = a.asset_id
            AND e.opcode = 'T_PMINT'
            AND e.commitment_valid = true
            AND e.chain_status = 'confirmed'
        ) AS valid_count
      FROM assets a
      WHERE a.kind = 't_petch'
        AND a.network = ${network}
        AND a.cap_amount IS NOT NULL
        AND a.mint_limit IS NOT NULL
        AND a.mint_limit > 0
    )
    SELECT asset_id, ticker, cap_amount, mint_limit, valid_count, slots_total
    FROM stats
    WHERE valid_count >= slots_total
    ORDER BY ticker, asset_id
  `);

  const body = {
    network,
    source: "tacitscan",
    generated_at: new Date().toISOString(),
    assets: rows.map((r) => ({
      asset_id: r.asset_id,
      ticker: r.ticker,
      cap_amount: r.cap_amount,
      mint_limit: r.mint_limit,
      credited_mints: r.valid_count,
      cap_slots: r.slots_total,
    })),
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      // 30s cache lines up with the indexer's tip-poll interval; cap status
      // can't flip more frequently than blocks land.
      "cache-control": "public, max-age=30, s-maxage=30",
      // Cross-origin: the upstream Tacit dapp reads this from
      // tacit.finance / tacit.market / any forked host.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
    },
  });
};
