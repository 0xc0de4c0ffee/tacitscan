import type { APIRoute } from "astro";
import { search, getDuplicateTickers } from "../../lib/queries";
import { displayAssetName } from "../../lib/format";
import { identiconSvg } from "../../lib/identicon";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get("q") ?? "";
  if (!q || q.length < 2) {
    return new Response(JSON.stringify({ txids: [], assets: [] }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=10" },
    });
  }
  const network = import.meta.env.PUBLIC_NETWORK ?? "mainnet";
  const [data, duplicates] = await Promise.all([search(q), getDuplicateTickers(network)]);
  const decorated = {
    txids: data.txids,
    assets: data.assets.map((a) => ({
      ...a,
      displayName: displayAssetName(a.ticker, a.assetId, duplicates.has(a.ticker)),
      identicon: identiconSvg(a.assetId, 14),
    })),
  };
  return new Response(JSON.stringify(decorated), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=10, s-maxage=10",
    },
  });
};
