// Airdrop eligibility check API. Server-side because:
//   - The two source CSVs (~600KB combined) shouldn't ship to the client.
//   - ENS/WNS resolution uses viem + wns-utils + RPCs we don't want
//     exposed in the browser bundle.
//
// Excluded from ISR (see astro.config.mjs) so query params actually
// reach the function rather than collapsing into one cached response.
// no-store on the response so each call resolves fresh — results are
// deterministic but the browser-side fetch already implements its own
// "submit → fetch → render" flow, so server caching adds nothing.
import type { APIRoute } from "astro";
import { checkAirdrop, resolveInput, SNAPSHOT_AT, SNAPSHOT_SOURCE_COMMIT, SOURCES } from "../../lib/airdrop";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const raw = url.searchParams.get("input")?.trim() ?? "";
  if (!raw) {
    return json({
      ok: false,
      error: "Missing ?input= query param.",
      snapshot: snapshotInfo(),
    }, 400);
  }

  const resolved = await resolveInput(raw);
  if (!resolved.address) {
    return json({
      ok: false,
      error: resolved.error ?? "Could not resolve input.",
      snapshot: snapshotInfo(),
    });
  }

  const result = checkAirdrop(resolved.address);
  if (!result) {
    return json({
      ok: false,
      error: "Could not compute eligibility (unexpected).",
      snapshot: snapshotInfo(),
    }, 500);
  }

  return json({
    ok: true,
    input: raw,
    resolvedName: resolved.resolvedName ?? null,
    resolvedVia: resolved.via,
    address: result.address,
    eligible: result.eligible,
    tacAmount: result.tacAmount,
    rank: result.rank,
    totalEligible: result.totalEligible,
    perSource: result.perSource,
    snapshot: snapshotInfo(),
  });
};

function snapshotInfo() {
  return {
    takenAt: SNAPSHOT_AT.toISOString(),
    sourceCommit: SNAPSHOT_SOURCE_COMMIT,
    totalAddresses: SOURCES.reduce((s, x) => s + x.balances.size, 0),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Don't cache — page-side JS handles UX; results are deterministic
      // but the client never re-fetches the same input twice in a session
      // anyway, so server caching is dead weight.
      "cache-control": "no-store",
    },
  });
}
