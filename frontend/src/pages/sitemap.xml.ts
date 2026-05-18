import type { APIRoute } from "astro";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db";

export const prerender = false;

const SITE = "https://tacitscan.io";

// Cap envelope URLs to keep sitemap reasonable. Search engines and
// LLMs really only need a healthy crawlable surface — they'll discover
// the rest via on-page links.
const MAX_TX = 5000;

export const GET: APIRoute = async () => {
  const network = import.meta.env.PUBLIC_NETWORK ?? "mainnet";

  const [assets, recentEnvelopes] = await Promise.all([
    db
      .select({ assetId: schema.assets.assetId, etchBlockTime: schema.assets.etchBlockTime })
      .from(schema.assets)
      .where(eq(schema.assets.network, network)),
    db
      .select({ txid: schema.envelopes.txid, blockTime: schema.envelopes.blockTime })
      .from(schema.envelopes)
      .where(eq(schema.envelopes.network, network))
      .orderBy(desc(schema.envelopes.blockHeight))
      .limit(MAX_TX),
  ]);

  const now = new Date().toISOString();
  const urls: string[] = [
    url(`${SITE}/`, now, "hourly", "1.0"),
    url(`${SITE}/assets`, now, "hourly", "0.9"),
  ];
  for (const a of assets) {
    urls.push(url(`${SITE}/assets/${a.assetId}`, iso(a.etchBlockTime), "daily", "0.8"));
  }
  for (const e of recentEnvelopes) {
    // Mempool envelopes have null blockTime; fall back to `now` so the
    // sitemap entry still has a lastmod. We don't filter them out — a
    // pending tx page is still a valid permalink.
    urls.push(url(`${SITE}/tx/${e.txid}`, iso(e.blockTime ?? new Date()), "yearly", "0.5"));
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml",
      "cache-control": "public, max-age=600, s-maxage=600",
    },
  });
};

function url(loc: string, lastmod: string, changefreq: string, priority: string): string {
  return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
}

function iso(d: Date | string): string {
  return new Date(d).toISOString();
}
