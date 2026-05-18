import type { APIRoute } from "astro";
import { getRecentEnvelopes, getDuplicateTickers } from "../../lib/queries";
import { displayAssetName } from "../../lib/format";
import { identiconSvg } from "../../lib/identicon";

export const prerender = false;

export const GET: APIRoute = async () => {
  const network = import.meta.env.PUBLIC_NETWORK ?? "mainnet";
  const [recent, duplicates] = await Promise.all([
    getRecentEnvelopes(25),
    getDuplicateTickers(network),
  ]);
  const rows = recent.map((r) => ({
    txid: r.txid,
    opcode: r.opcode,
    assetId: r.assetId,
    blockHeight: r.blockHeight,
    blockTime: r.blockTime,
    chainStatus: r.chainStatus,
    firstSeenAt: r.firstSeenAt,
    ticker: r.ticker,
    displayName:
      r.ticker && r.assetId
        ? displayAssetName(r.ticker, r.assetId, duplicates.has(r.ticker))
        : null,
    identicon: r.assetId ? identiconSvg(r.assetId, 12) : null,
  }));
  return new Response(JSON.stringify({ rows }), {
    headers: {
      "content-type": "application/json",
      // 15s freshness matches the polling cadence in RecentFeed.
      "cache-control": "public, max-age=15, s-maxage=15",
    },
  });
};
