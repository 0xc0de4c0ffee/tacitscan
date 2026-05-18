import type { APIRoute } from "astro";
import { getCursor } from "../../lib/queries";
import { fetchChainTip } from "../../lib/tip";

export const prerender = false;

const STALE_AFTER_SEC = 300;

export const GET: APIRoute = async () => {
  const network = import.meta.env.PUBLIC_NETWORK ?? "mainnet";
  const [cursor, tip] = await Promise.all([getCursor(network), fetchChainTip()]);

  if (!cursor) {
    return json(
      {
        healthy: false,
        reason: "no cursor row — indexer never ran against this DB",
        network,
      },
      503,
    );
  }

  const updatedMs = new Date(cursor.updatedAt).getTime();
  const lagSeconds = Math.floor((Date.now() - updatedMs) / 1000);
  const blocksBehindTip = tip !== null ? Math.max(0, tip - cursor.lastIndexedHeight) : null;
  // Healthy = cursor advancing. Being behind tip is normal during backfill.
  const healthy = lagSeconds < STALE_AFTER_SEC;

  return json(
    {
      healthy,
      network,
      lastIndexedHeight: cursor.lastIndexedHeight,
      lastIndexedBlockHash: cursor.lastIndexedBlockHash,
      cursorUpdatedAt: cursor.updatedAt,
      lagSeconds,
      staleAfterSec: STALE_AFTER_SEC,
      chainTip: tip,
      blocksBehindTip,
    },
    healthy ? 200 : 503,
  );
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
