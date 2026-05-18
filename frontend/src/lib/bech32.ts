// Minimal bech32m P2TR decoder. Just enough to extract the 32-byte
// x-only output key from a "bc1p..."/"tb1p..." address so we can match
// it against assets.creator_pubkey / mint_authority (which the indexer
// stores as 64-hex-char x-only keys).
//
// References:
//   - BIP-173 (bech32)         https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
//   - BIP-350 (bech32m / SegWit v1+)  https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
//   - BIP-341 (Taproot)        https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki
//
// Witness version 1 + 32-byte program = P2TR; the 32-byte program IS
// the tweaked x-only output key. We DON'T attempt to untweak (would
// need the internal-key + merkle-root context Bitcoin Core has but
// callers don't), so what we match against is the *output* key. For
// Tacit's creator_pubkey field that's correct: SPEC §3 puts the output
// key into the asset record, since that's what's visible on-chain.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const BECH32_CONST = 1;

const CHARSET_REV: Record<string, number> = {};
for (let i = 0; i < CHARSET.length; i++) CHARSET_REV[CHARSET[i]!] = i;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function verifyChecksum(hrp: string, data: number[], constant: number): boolean {
  return polymod([...hrpExpand(hrp), ...data]) === constant;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  const maxAcc = (1 << (from + to - 1)) - 1;
  for (const v of data) {
    if (v < 0 || v >> from !== 0) return null;
    acc = ((acc << from) | v) & maxAcc;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

export interface DecodedP2TR {
  hrp: "bc" | "tb";
  /** 32-byte x-only output key, hex-encoded (64 chars). */
  xonlyPubkeyHex: string;
}

export interface DecodedP2WPKH {
  hrp: "bc" | "tb";
  /** 20-byte hash160 program, hex-encoded (40 chars). */
  hash160Hex: string;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32M_CONST;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

// Encode a 32-byte x-only pubkey as a P2TR bech32m address. The pubkey
// MUST already be the on-chain output key (post any taproot tweak). Used
// to link from creator_pubkey / mint_authority fields back to /address.
export function encodeP2TR(network: "mainnet" | "signet" | "testnet", xonlyHex: string): string | null {
  if (xonlyHex.length !== 64) return null;
  const program: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    const byte = parseInt(xonlyHex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    program.push(byte);
  }
  const five = convertBits(program, 8, 5, true);
  if (!five) return null;
  const data = [1, ...five]; // witver=1
  const hrp = network === "mainnet" ? "bc" : "tb";
  const checksum = createChecksum(hrp, data);
  let addr = hrp + "1";
  for (const v of [...data, ...checksum]) addr += CHARSET[v]!;
  return addr;
}

// Encode a 20-byte hash160 as a segwit-v0 P2WPKH bech32 address (bc1q…).
// Used by the airdrop queue page to map each claim's tacit_pubkey (which
// the recipient signed with) into the on-chain payment address the
// fulfiller will pay 546 sats to. `hash160Hex` must be 40 hex chars
// (ripemd160(sha256(compressed_pubkey))).
export function encodeP2WPKH(network: "mainnet" | "signet" | "testnet", hash160Hex: string): string | null {
  if (hash160Hex.length !== 40) return null;
  const program: number[] = [];
  for (let i = 0; i < 40; i += 2) {
    const byte = parseInt(hash160Hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    program.push(byte);
  }
  const five = convertBits(program, 8, 5, true);
  if (!five) return null;
  const data = [0, ...five]; // witver=0
  const hrp = network === "mainnet" ? "bc" : "tb";
  // v0 segwit uses bech32 (const=1), NOT bech32m (which is for v1+).
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32_CONST;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  let addr = hrp + "1";
  for (const v of [...data, ...checksum]) addr += CHARSET[v]!;
  return addr;
}

// Decode a bech32m segwit-v1 (P2TR) address. Returns null for any input
// that isn't a valid P2TR address — we don't accept v0 segwit or legacy
// addresses since the address page only supports P2TR.
export function decodeP2TR(addr: string): DecodedP2TR | null {
  const a = addr.toLowerCase();
  // Mixed case is forbidden by bech32; reject the original input if it
  // differs from its lowercase form AND its uppercase form.
  if (addr !== a && addr !== addr.toUpperCase()) return null;
  const sep = a.lastIndexOf("1");
  if (sep < 1 || sep + 7 > a.length || a.length > 90) return null;
  const hrp = a.slice(0, sep);
  if (hrp !== "bc" && hrp !== "tb") return null;
  const dataPart = a.slice(sep + 1);
  const data: number[] = [];
  for (let i = 0; i < dataPart.length; i++) {
    const v = CHARSET_REV[dataPart[i]!];
    if (v === undefined) return null;
    data.push(v);
  }
  if (!verifyChecksum(hrp, data, BECH32M_CONST)) return null;
  // Strip 6-char checksum, leaving [witver, ...program5bit].
  const payload = data.slice(0, -6);
  if (payload.length === 0) return null;
  const witver = payload[0]!;
  if (witver !== 1) return null;
  const program = convertBits(payload.slice(1), 5, 8, false);
  if (!program || program.length !== 32) return null;
  const hex = program.map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hrp: hrp as "bc" | "tb", xonlyPubkeyHex: hex };
}

// Decode a bech32 segwit-v0 P2WPKH address ("bc1q…"/"tb1q…"). v0 uses the
// original bech32 checksum constant (1), not bech32m. Returns null for
// anything that isn't valid v0 P2WPKH (20-byte program).
export function decodeP2WPKH(addr: string): DecodedP2WPKH | null {
  const a = addr.toLowerCase();
  if (addr !== a && addr !== addr.toUpperCase()) return null;
  const sep = a.lastIndexOf("1");
  if (sep < 1 || sep + 7 > a.length || a.length > 90) return null;
  const hrp = a.slice(0, sep);
  if (hrp !== "bc" && hrp !== "tb") return null;
  const dataPart = a.slice(sep + 1);
  const data: number[] = [];
  for (let i = 0; i < dataPart.length; i++) {
    const v = CHARSET_REV[dataPart[i]!];
    if (v === undefined) return null;
    data.push(v);
  }
  if (!verifyChecksum(hrp, data, BECH32_CONST)) return null;
  const payload = data.slice(0, -6);
  if (payload.length === 0) return null;
  const witver = payload[0]!;
  if (witver !== 0) return null;
  const program = convertBits(payload.slice(1), 5, 8, false);
  if (!program || program.length !== 20) return null;
  const hex = program.map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hrp: hrp as "bc" | "tb", hash160Hex: hex };
}
