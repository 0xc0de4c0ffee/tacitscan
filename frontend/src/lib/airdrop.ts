// Airdrop eligibility lookup. Loads the two Etherscan token-holder
// CSVs that ship in src/data at module init, parses them into address
// → balance Maps. Lookup is O(1) lowercase address keys.
//
// The two source contracts are the snapshot inputs the dapp's airdrop
// builder merges (see tacit/README.md "Greta airdrops 50,000 GRETA…").
// We expose per-contract balances and a summed eligibility figure so
// the page can show breakdown + total.
//
// We don't try to compute the actual on-chain claim amount — that
// depends on the airdrop creator's chosen merkle leaf weights, which
// can be linear, sqrt, capped, or off-list weighted. We surface the
// raw snapshot weight (sum of holdings) and let the user know the
// final number is decided by the airdrop publisher.
import csv0xe9b1 from "../data/export-tokenholders-for-contract-0xe9b1cfea55baa219e34301f2f31b9fd0921664ed.csv?raw";
import csv0x00a6 from "../data/export-tokenholders-for-contract-0x00a6ba94bbb5474725515de88fe04f854f2dcb12.csv?raw";

export interface AirdropSource {
  contractAddress: string;
  /** Short display label for the source contract. */
  label: string;
  balances: Map<string, number>;
}

function parseCsv(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  // Skip the header row. Etherscan format: "HolderAddress","Balance","PendingBalanceUpdate"
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Naive CSV: fields are quoted, no embedded commas in these files.
    const m = line.match(/^"([^"]+)","([^"]+)","[^"]*"$/);
    if (!m) continue;
    const addr = m[1]!.toLowerCase();
    // Balance is formatted with thousands separators and a decimal,
    // e.g. "7,775,903.683026136819491537". Parse to a float — we lose
    // some precision past 15 digits but for display purposes that's
    // fine. The real claim amount is computed from the on-chain merkle
    // tree anyway.
    const balance = parseFloat(m[2]!.replace(/,/g, ""));
    if (Number.isNaN(balance) || balance <= 0) continue;
    out.set(addr, balance);
  }
  return out;
}

export const SOURCES: AirdropSource[] = [
  {
    contractAddress: "0xe9b1cfea55baa219e34301f2f31b9fd0921664ed",
    label: "ZAMM",
    balances: parseCsv(csv0xe9b1),
  },
  {
    contractAddress: "0x00a6ba94bbb5474725515de88fe04f854f2dcb12",
    label: "ZORG",
    balances: parseCsv(csv0x00a6),
  },
];

// Best-known timestamp for when the snapshot was taken — derived from
// the commit that added the CSVs to github.com/z0r0z/tacit (21394bf,
// 2026-05-12 01:57:07 UTC). The actual on-chain snapshot block was
// finalized slightly before this; the commit time is an upper bound
// that's accurate to within a few minutes for display purposes.
export const SNAPSHOT_AT = new Date("2026-05-12T01:57:07Z");
export const SNAPSHOT_SOURCE_COMMIT = {
  repo: "z0r0z/tacit",
  sha: "21394bf",
  url: "https://github.com/z0r0z/tacit/commit/21394bf",
};

export interface AirdropResult {
  address: string;
  eligible: boolean;
  /** TAC amount the address is eligible for: ZAMM + ZORG, 1:1 each. */
  tacAmount: number;
  /** 1-indexed position when all eligible addresses are sorted by
   * tacAmount desc. null for ineligible addresses. */
  rank: number | null;
  /** Total number of eligible addresses across both source snapshots. */
  totalEligible: number;
  perSource: { contractAddress: string; label: string; balance: number | null }[];
}

// Build the unique-eligible-address list ONCE at module init. With ~8k
// rows across both sources this is sub-millisecond and lookups become
// O(1) Map.get calls per /api/airdrop-check request.
const _RANK_BY_ADDR: Map<string, number> = (() => {
  const combined = new Map<string, number>();
  for (const s of SOURCES) {
    for (const [addr, bal] of s.balances) {
      combined.set(addr, (combined.get(addr) ?? 0) + bal);
    }
  }
  const sorted = Array.from(combined.entries())
    .filter(([, tac]) => tac > 0)
    // tie-break on address so ranks are deterministic across deploys.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return new Map(sorted.map(([addr], i) => [addr, i + 1]));
})();

export const TOTAL_ELIGIBLE = _RANK_BY_ADDR.size;

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidEthAddress(addr: string): boolean {
  return ETH_ADDR_RE.test(addr);
}

// TAC allocation: 1:1 with each source token, so total TAC =
// ZAMM balance + ZORG balance. TAC has 8 decimals on-chain but since
// both source balances are already decimal-formatted floats from the
// CSV, the addition is direct — we don't need to scale.
export function checkAirdrop(rawAddress: string): AirdropResult | null {
  if (!isValidEthAddress(rawAddress)) return null;
  const addr = rawAddress.toLowerCase();
  const perSource = SOURCES.map((s) => ({
    contractAddress: s.contractAddress,
    label: s.label,
    balance: s.balances.get(addr) ?? null,
  }));
  const tacAmount = perSource.reduce((sum, p) => sum + (p.balance ?? 0), 0);
  const eligible = tacAmount > 0;
  return {
    address: addr,
    eligible,
    tacAmount,
    rank: eligible ? _RANK_BY_ADDR.get(addr) ?? null : null,
    totalEligible: _RANK_BY_ADDR.size,
    perSource,
  };
}

// Resolve a user input (0x address, ENS name, or WNS .wei name) to an
// Ethereum address. Server-side only — uses viem for ENS against mainnet
// and wns-utils for .wei against the Wei Name Service.
//
// Bare labels (no dot) are ambiguous: we try ENS (`name.eth`) first
// because it's far more common, then WNS (`name.wei`) as a fallback.
export interface ResolvedInput {
  /** Final 0x address (lowercase). null on resolution failure. */
  address: string | null;
  /** The original input the user submitted (unchanged). */
  input: string;
  /** Set when we resolved from a name. e.g. "vitalik.eth", "alice.wei". */
  resolvedName?: string;
  /** "ens" | "wns" | "address" | null. null on failure. */
  via: "ens" | "wns" | "address" | null;
  error?: string;
}

export async function resolveInput(raw: string): Promise<ResolvedInput> {
  const trimmed = raw.trim();
  if (!trimmed) return { address: null, input: raw, via: null, error: "empty input" };
  if (isValidEthAddress(trimmed)) {
    return { address: trimmed.toLowerCase(), input: raw, via: "address" };
  }

  const lower = trimmed.toLowerCase();
  // .wei: WNS only
  if (lower.endsWith(".wei")) {
    const addr = await tryResolveWns(lower);
    return addr
      ? { address: addr.toLowerCase(), input: raw, via: "wns", resolvedName: lower }
      : { address: null, input: raw, via: null, error: `Could not resolve ${lower}` };
  }
  // .eth: ENS only
  if (lower.endsWith(".eth")) {
    const addr = await tryResolveEns(lower);
    return addr
      ? { address: addr.toLowerCase(), input: raw, via: "ens", resolvedName: lower }
      : { address: null, input: raw, via: null, error: `Could not resolve ${lower}` };
  }
  // Bare label: try .eth then .wei
  if (/^[a-z0-9-]+$/.test(lower)) {
    const ensName = `${lower}.eth`;
    const ensAddr = await tryResolveEns(ensName);
    if (ensAddr) return { address: ensAddr.toLowerCase(), input: raw, via: "ens", resolvedName: ensName };
    const weiName = `${lower}.wei`;
    const wnsAddr = await tryResolveWns(weiName);
    if (wnsAddr) return { address: wnsAddr.toLowerCase(), input: raw, via: "wns", resolvedName: weiName };
    return { address: null, input: raw, via: null, error: `No record for ${ensName} or ${weiName}` };
  }
  return { address: null, input: raw, via: null, error: "Not a valid address or .eth/.wei name" };
}

// ENS resolves at "latest". The historical-block walk-back approach I
// tried first (~30 sequential getBlock calls + ENS call) reliably blew
// past Vercel's function timeout on cold start. Latest-block ENS is a
// single call (~300ms) and works on cold start within the page's 12s
// fetch budget. Tradeoff: if a .eth name has been transferred since
// the snapshot, the resolved address may not match the snapshot CSV
// entry — the UI surfaces a note for both .eth and .wei resolutions
// pointing this out, and a user with that edge case can paste their
// snapshot-time 0x address directly.
// Viem's default transport for mainnet is cloudflare-eth which reliably
// times out on ENS lookups from Vercel's serverless functions. Use a
// fallback over fast public RPCs with a 2.5s per-call ceiling so a
// single slow upstream doesn't burn the function's whole budget.
async function tryResolveEns(name: string): Promise<string | null> {
  try {
    const { createPublicClient, http, fallback } = await import("viem");
    const { mainnet } = await import("viem/chains");
    const { normalize } = await import("viem/ens");
    const transport = fallback(
      [
        http("https://eth.llamarpc.com", { timeout: 2500 }),
        http("https://ethereum.publicnode.com", { timeout: 2500 }),
        http("https://1rpc.io/eth", { timeout: 2500 }),
        http("https://eth.drpc.org", { timeout: 2500 }),
      ],
      { rank: false },
    );
    const client = createPublicClient({ chain: mainnet, transport });
    return await client.getEnsAddress({ name: normalize(name) });
  } catch {
    return null;
  }
}

// WNS resolves at "latest" — wns-utils doesn't expose a block-tag knob.
// In practice .wei names rarely change ownership, so the gap between
// snapshot and now isn't usually load-bearing, but we surface a note
// in the UI when a .wei resolution is used so the user can sanity-check.
async function tryResolveWns(name: string): Promise<string | null> {
  try {
    const { createWnsClient } = await import("wns-utils");
    const wns = createWnsClient();
    return await wns.resolve(name);
  } catch {
    return null;
  }
}
