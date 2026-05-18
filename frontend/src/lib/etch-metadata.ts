// Fetch the off-chain JSON metadata blob that a CETCH/T_PETCH issuer
// publishes at the envelope's `image_uri`. Used by both the /assets/[id]
// page and the /tx/[txid] page so the decoded metadata renders the same
// way regardless of entry point.
//
// Why server-side at SSR rather than client: the blob is small, cached
// at the IPFS gateway, and we want the data visible without JS for
// preview crawlers (Twitter cards, etc.).

export type AssetMetadata = {
  raw: string | null;
  parsed: Record<string, any> | null;
  attest: { supply?: string; blinding?: string; commitment?: string } | null;
  error: string | null;
  gatewayUrl: string | null;
};

export async function fetchAssetMetadata(uri: string | null | undefined): Promise<AssetMetadata> {
  if (!uri) return { raw: null, parsed: null, attest: null, error: null, gatewayUrl: null };
  let url = uri;
  if (uri.startsWith("ipfs://")) url = `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (!/^https?:\/\//.test(url)) {
    return { raw: null, parsed: null, attest: null, error: "unsupported URI scheme", gatewayUrl: null };
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { raw: null, parsed: null, attest: null, error: `HTTP ${r.status}`, gatewayUrl: url };
    const text = await r.text();
    if (text.length > 8192) {
      return { raw: text.slice(0, 8192), parsed: null, attest: null, error: "blob too large to parse inline", gatewayUrl: url };
    }
    try {
      const parsed = JSON.parse(text);
      const attest = parsed && typeof parsed === "object" && parsed.tacit_attest && typeof parsed.tacit_attest === "object"
        ? parsed.tacit_attest
        : null;
      return { raw: text, parsed, attest, error: null, gatewayUrl: url };
    } catch {
      return { raw: text, parsed: null, attest: null, error: "not JSON (likely a direct image)", gatewayUrl: url };
    }
  } catch (e) {
    return { raw: null, parsed: null, attest: null, error: (e as Error).message?.slice(0, 100) ?? "fetch failed", gatewayUrl: url };
  }
}

export function formatRevealedSupply(supplyStr: string | undefined | null, decimals: number): string | null {
  if (!supplyStr) return null;
  try {
    const v = BigInt(supplyStr);
    const div = 10n ** BigInt(decimals);
    const whole = v / div;
    const frac = v % div;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toLocaleString()}.${fracStr}`;
  } catch {
    return null;
  }
}
