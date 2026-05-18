// Background loop that resolves each asset's image_uri to a final HTTPS
// image URL. Tacit assets often follow the NFT pattern where image_uri
// points to metadata JSON containing an `image` field, not the image
// itself. We do this once per asset and persist the result.
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db.js";

const FETCH_TIMEOUT_MS = 6000;
const IDLE_POLL_MS = 30_000;
const BATCH_SIZE = 20;
// Primary gateway is content.wrappr.wtf — Cloudflare-fronted, fast cache
// hits globally and the URL we want stored in DB so users see the same
// host. Fallbacks kick in only on fetch errors (resolver-side only; the
// final stored URL is always the wrappr one when resolution succeeds).
const GATEWAYS = [
  "https://content.wrappr.wtf/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
];

function ipfsToHttp(uri: string): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  if (trimmed.startsWith("ipfs://")) {
    let cid = trimmed.slice("ipfs://".length);
    if (cid.startsWith("ipfs/")) cid = cid.slice("ipfs/".length);
    return cid ? `${GATEWAYS[0]}${cid}` : null;
  }
  if (/^(baf[ykr]|Qm)/.test(trimmed)) return `${GATEWAYS[0]}${trimmed}`;
  return null;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "tacitscan-resolver/0.1" },
    redirect: "follow",
  });
}

// Returns the final HTTPS image URL or throws.
async function resolveImage(rawUri: string): Promise<string> {
  const url = ipfsToHttp(rawUri);
  if (!url) throw new Error("could not resolve to https URL");

  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();

  if (ct.startsWith("image/")) {
    return url;
  }

  // JSON or text — try metadata-style decode.
  if (ct.includes("json") || ct.includes("text") || ct === "" || ct.includes("octet-stream")) {
    const text = await r.text();
    let meta: { image?: unknown } | null = null;
    try {
      meta = JSON.parse(text);
    } catch {
      throw new Error(`non-image, non-JSON response (content-type=${ct || "unknown"})`);
    }
    if (!meta || typeof meta.image !== "string" || !meta.image.trim()) {
      throw new Error("metadata JSON missing 'image' field");
    }
    const inner = ipfsToHttp(meta.image);
    if (!inner) throw new Error(`could not resolve metadata.image=${meta.image}`);
    // Optionally HEAD-verify the inner is image/*; skip for v1 to save a roundtrip.
    return inner;
  }

  throw new Error(`unexpected content-type ${ct}`);
}

async function processAsset(asset: { assetId: string; imageUri: string }): Promise<void> {
  try {
    const resolved = await resolveImage(asset.imageUri);
    await db
      .update(schema.assets)
      .set({
        resolvedImageUrl: resolved,
        imageResolvedAt: new Date(),
        imageResolveError: null,
      })
      .where(eq(schema.assets.assetId, asset.assetId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(schema.assets)
      .set({
        imageResolvedAt: new Date(),
        imageResolveError: msg.slice(0, 500),
      })
      .where(eq(schema.assets.assetId, asset.assetId));
  }
}

export async function runResolver(): Promise<never> {
  console.log("[resolver] started");
  while (true) {
    const candidates = await db
      .select({ assetId: schema.assets.assetId, imageUri: schema.assets.imageUri })
      .from(schema.assets)
      .where(
        and(
          isNotNull(schema.assets.imageUri),
          isNull(schema.assets.imageResolvedAt),
        ),
      )
      .limit(BATCH_SIZE);

    if (candidates.length === 0) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const startedAt = Date.now();
    let ok = 0;
    let fail = 0;
    // Process this batch with limited concurrency so we don't hammer
    // gateways. 4 in flight is gentle.
    const work = [...candidates];
    const concurrency = 4;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (work.length > 0) {
          const a = work.shift()!;
          if (!a.imageUri) continue;
          try {
            await processAsset(a as { assetId: string; imageUri: string });
            ok++;
          } catch {
            fail++;
          }
        }
      }),
    );
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[resolver] batch: +${ok} resolved, ${fail} failed in ${took}s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
