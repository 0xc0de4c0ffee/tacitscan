// Re-exposes the static airdrop fulfilment snapshot as a public JSON
// endpoint so the dapp's Claim view can cross-check "is this leaf already
// paid?" before letting the user re-submit. The data lives at
// src/data/airdrop-history.json (regenerated manually via
// fulfiller/generate-history.mjs after batch waves); this endpoint just
// adds CORS + cache headers and serves it.
//
// Why an endpoint instead of just dropping the file under public/:
// keeping it in src/data/ means the build-time imports (e.g. on the
// /airdrop/queue page) keep working without duplication. One source of
// truth, two serving paths.
import type { APIRoute } from "astro";
import history from "../../data/airdrop-history.json";

export const prerender = false;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(history), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Snapshot only changes on a manual fulfiller-side regen + push,
      // so we cache aggressively at the edge. Browsers hold a copy for
      // 60s to avoid hammering the edge on rapid page-flips.
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
      // The dapp loads from a different origin (z0r0z.github.io or
      // tacit.cash); without CORS the fetch in _loadAirdropHistory would
      // be blocked. Allow any origin since the data is public.
      "Access-Control-Allow-Origin": "*",
    },
  });
};
