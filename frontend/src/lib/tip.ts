// Fetch current Bitcoin chain tip from mempool.space.
// Used by the sync indicator + /api/health to compute lag-from-tip.
// Soft fail (returns null) so a slow Esplora doesn't break page renders.
export async function fetchChainTip(): Promise<number | null> {
  try {
    const r = await fetch("https://mempool.space/api/blocks/tip/height", {
      signal: AbortSignal.timeout(3000),
      headers: { "user-agent": "tacitscan-frontend/0.1" },
    });
    if (!r.ok) return null;
    const t = await r.text();
    const n = Number(t.trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// Bitcoin's expected ~10 min/block. Lag in blocks → human time.
export function lagToHuman(blocks: number): string {
  const min = blocks * 10;
  if (min < 60) return `~${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `~${hr}h`;
  const day = (min / 1440).toFixed(1);
  return `~${day}d`;
}
