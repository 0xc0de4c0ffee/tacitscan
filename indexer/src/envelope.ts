// Tacit envelope decoder. Pure functions on bytes.
// Wire format reference: SPEC.md §5 (z0r0z/tacit).
import { sha256 } from "@noble/hashes/sha256";
import { decodeScript, extractEnvelopeFrame } from "./script.js";

export const OPCODES = {
  CETCH: 0x21,
  CXFER: 0x23,
  T_MINT: 0x24,
  T_BURN: 0x25,
  T_AXFER: 0x26,
  T_PETCH: 0x27,
  T_PMINT: 0x28,
  T_DEPOSIT: 0x29,
  T_WITHDRAW: 0x2a,
} as const;

export const OPCODE_NAMES: Record<number, string> = {
  0x21: "CETCH",
  0x23: "CXFER",
  0x24: "T_MINT",
  0x25: "T_BURN",
  0x26: "T_AXFER",
  0x27: "T_PETCH",
  0x28: "T_PMINT",
  0x29: "T_DEPOSIT",
  0x2a: "T_WITHDRAW",
};

const MAGIC = new TextEncoder().encode("TACIT");
const VERSION = 0x01;

class Cursor {
  constructor(
    public buf: Uint8Array,
    public off: number = 0,
  ) {}
  remaining() {
    return this.buf.length - this.off;
  }
  takeU8(): number {
    if (this.off + 1 > this.buf.length) throw new Error("eof u8");
    return this.buf[this.off++]!;
  }
  takeU16LE(): number {
    if (this.off + 2 > this.buf.length) throw new Error("eof u16");
    const v = this.buf[this.off]! | (this.buf[this.off + 1]! << 8);
    this.off += 2;
    return v;
  }
  takeU32LE(): number {
    if (this.off + 4 > this.buf.length) throw new Error("eof u32");
    const v =
      (this.buf[this.off]! |
        (this.buf[this.off + 1]! << 8) |
        (this.buf[this.off + 2]! << 16) |
        (this.buf[this.off + 3]! << 24)) >>>
      0;
    this.off += 4;
    return v;
  }
  takeU64LE(): bigint {
    if (this.off + 8 > this.buf.length) throw new Error("eof u64");
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.off + i]!);
    this.off += 8;
    return v;
  }
  takeBytes(n: number): Uint8Array {
    if (this.off + n > this.buf.length) throw new Error(`eof bytes(${n})`);
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  takeUtf8(n: number): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(this.takeBytes(n));
  }
  /** Throws on invalid UTF-8 (matches upstream's fatal:true decoder). */
  takeUtf8Strict(n: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.takeBytes(n));
  }
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error("odd hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Concat helper.
function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// SPEC §4: asset_id = SHA256(reveal_txid_BE || reveal_vout_LE).
//
// In this spec "_BE" refers to Bitcoin's natural hash-output byte order,
// which is the REVERSE of the displayed hex form. Bitcoin txids are the
// raw sha256d output; convention is to display them with bytes reversed.
// Esplora and our envelope payloads carry the displayed form, so we must
// reverse the bytes before feeding them to the hash. Verified empirically
// against on-chain T_PMINT envelopes that embed both etch_txid (displayed
// form) and asset_id (hash output) — the reverse-then-hash derivation
// matches; the no-reverse derivation does not.
export function deriveAssetId(revealTxid: string, revealVout: number): string {
  const txidBytes = hexToBytes(revealTxid).reverse();
  const voutBytes = new Uint8Array(4);
  voutBytes[0] = revealVout & 0xff;
  voutBytes[1] = (revealVout >>> 8) & 0xff;
  voutBytes[2] = (revealVout >>> 16) & 0xff;
  voutBytes[3] = (revealVout >>> 24) & 0xff;
  return bytesToHex(sha256(concat(txidBytes, voutBytes)));
}

// ──────────────────────────────────────────────────────────────────────
// Per-opcode decoded shapes
// ──────────────────────────────────────────────────────────────────────

export interface CommitmentOut {
  vout: number; // for envelopes that produce confidential outputs at vout 0..N-1
  commitmentC: Uint8Array; // 33 bytes
  encryptedAmount: Uint8Array; // 8 bytes
}

export type DecodedEnvelope =
  | { opcode: "CETCH"; payload: Uint8Array; ticker: string; decimals: number; commitmentC: Uint8Array; amountCt: Uint8Array; rangeproof: Uint8Array; mintAuthority: Uint8Array; imageUri: string }
  | { opcode: "CXFER"; payload: Uint8Array; assetId: string; kernelSig: Uint8Array; n: number; outputs: CommitmentOut[]; rangeproof: Uint8Array }
  | { opcode: "T_MINT"; payload: Uint8Array; assetId: string; etchTxid: string; commitmentC: Uint8Array; amountCt: Uint8Array; rangeproof: Uint8Array; issuerSig: Uint8Array }
  | { opcode: "T_BURN"; payload: Uint8Array; assetId: string; burnedAmount: bigint; kernelSig: Uint8Array; n: number; outputs: CommitmentOut[]; rangeproof: Uint8Array | null }
  | { opcode: "T_AXFER"; payload: Uint8Array; assetId: string; assetInputCount: number; kernelSig: Uint8Array; n: number; outputs: CommitmentOut[]; rangeproof: Uint8Array }
  | { opcode: "T_PETCH"; payload: Uint8Array; ticker: string; decimals: number; capAmount: bigint; mintLimit: bigint; mintStartHeight: number; mintEndHeight: number; imageUri: string }
  | { opcode: "T_PMINT"; payload: Uint8Array; assetId: string; etchTxid: string; commitmentC: Uint8Array; amount: bigint; blinding: Uint8Array }
  | { opcode: "T_DEPOSIT"; payload: Uint8Array; assetId: string; denomination: bigint; leafCommitment: Uint8Array; kernelSig: Uint8Array; isPoolInit: false }
  | { opcode: "T_DEPOSIT"; payload: Uint8Array; assetId: string; denomination: 0n; isPoolInit: true; poolDenom: bigint; vkCid: string; ceremonyCid: string; initSig: Uint8Array }
  | { opcode: "T_WITHDRAW"; payload: Uint8Array; assetId: string; denomination: bigint; merkleRoot: Uint8Array; nullifierHash: Uint8Array; recipientCommitment: Uint8Array; rLeaf: Uint8Array; bindHash: Uint8Array; proof: Uint8Array };

export type DecodeResult =
  | { ok: true; envelope: DecodedEnvelope; rawPayload: Uint8Array }
  | { ok: false; reason: string; rawPayload: Uint8Array | null };

// Parses the witness leaf script and returns the concatenated payload.
// Returns null if the script does not contain a Tacit envelope frame.
export function extractTacitPayload(witnessScript: Uint8Array): Uint8Array | null {
  let ops;
  try {
    ops = decodeScript(witnessScript);
  } catch {
    return null;
  }
  const pushes = extractEnvelopeFrame(ops);
  if (!pushes || pushes.length < 3) return null;
  if (!eq(pushes[0]!, MAGIC)) return null;
  if (pushes[1]!.length !== 1 || pushes[1]![0] !== VERSION) return null;
  return concat(...pushes.slice(2));
}

// Top-level: take a Bitcoin tx's witness data and try to decode a Tacit
// envelope. Returns null if the tx isn't Tacit-bearing.
export function tryDecodeFromWitness(witness: string[] | undefined): DecodeResult | null {
  // SPEC §5: envelope rides in vin[0].witness[1].
  if (!witness || witness.length < 2) return null;
  let scriptBytes: Uint8Array;
  try {
    scriptBytes = hexToBytes(witness[1]!);
  } catch {
    return null;
  }
  const payload = extractTacitPayload(scriptBytes);
  if (!payload) return null;
  return decodePayload(payload);
}

export function decodePayload(payload: Uint8Array): DecodeResult {
  if (payload.length < 1) return { ok: false, reason: "empty payload", rawPayload: payload };
  const op = payload[0]!;
  const c = new Cursor(payload, 1);
  try {
    let envelope: DecodedEnvelope;
    switch (op) {
      case OPCODES.CETCH:
        envelope = decodeCetch(payload, c);
        break;
      case OPCODES.CXFER:
        envelope = decodeCxfer(payload, c);
        break;
      case OPCODES.T_MINT:
        envelope = decodeTMint(payload, c);
        break;
      case OPCODES.T_BURN:
        envelope = decodeTBurn(payload, c);
        break;
      case OPCODES.T_AXFER:
        envelope = decodeTAxfer(payload, c);
        break;
      case OPCODES.T_PETCH:
        envelope = decodeTPetch(payload, c);
        break;
      case OPCODES.T_PMINT:
        envelope = decodeTPmint(payload, c);
        break;
      case OPCODES.T_DEPOSIT:
        envelope = decodeTDeposit(payload, c);
        break;
      case OPCODES.T_WITHDRAW:
        envelope = decodeTWithdraw(payload, c);
        break;
      default:
        return { ok: false, reason: `unknown opcode 0x${op.toString(16)}`, rawPayload: payload };
    }
    // SPEC: each envelope's payload is exactly the bytes its decoder
    // consumes. Trailing data is a malformed envelope per upstream
    // reference parser. Reject so we don't credit junk envelopes that
    // happen to byte-match a prefix.
    if (c.off !== payload.length) {
      return {
        ok: false,
        reason: `trailing bytes: consumed ${c.off} of ${payload.length}`,
        rawPayload: payload,
      };
    }
    return { ok: true, rawPayload: payload, envelope };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), rawPayload: payload };
  }
}

function decodeCetch(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const tickerLen = c.takeU8();
  if (tickerLen < 1 || tickerLen > 16) throw new Error(`bad ticker_len=${tickerLen}`);
  const ticker = c.takeUtf8(tickerLen);
  const decimals = c.takeU8();
  if (decimals > 8) throw new Error(`bad decimals=${decimals}`);
  const commitmentC = c.takeBytes(33);
  const amountCt = c.takeBytes(8);
  const rpLen = c.takeU16LE();
  const rangeproof = c.takeBytes(rpLen);
  const mintAuthority = c.takeBytes(32);
  const imgLen = c.takeU16LE();
  if (imgLen > 256) throw new Error(`bad img_len=${imgLen}`);
  const imageUri = c.takeUtf8(imgLen);
  return {
    opcode: "CETCH",
    payload,
    ticker,
    decimals,
    commitmentC,
    amountCt,
    rangeproof,
    mintAuthority,
    imageUri,
  };
}

function decodeCxfer(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const assetId = bytesToHex(c.takeBytes(32));
  const kernelSig = c.takeBytes(64);
  const n = c.takeU8();
  if (![1, 2, 4, 8].includes(n)) throw new Error(`bad N=${n}`);
  const outputs: CommitmentOut[] = [];
  for (let i = 0; i < n; i++) {
    outputs.push({
      vout: i,
      commitmentC: c.takeBytes(33),
      encryptedAmount: c.takeBytes(8),
    });
  }
  const rpLen = c.takeU16LE();
  const rangeproof = c.takeBytes(rpLen);
  return { opcode: "CXFER", payload, assetId, kernelSig, n, outputs, rangeproof };
}

function decodeTMint(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const assetId = bytesToHex(c.takeBytes(32));
  const etchTxid = bytesToHex(c.takeBytes(32));
  const commitmentC = c.takeBytes(33);
  const amountCt = c.takeBytes(8);
  const rpLen = c.takeU16LE();
  const rangeproof = c.takeBytes(rpLen);
  const issuerSig = c.takeBytes(64);
  return { opcode: "T_MINT", payload, assetId, etchTxid, commitmentC, amountCt, rangeproof, issuerSig };
}

function decodeTBurn(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const assetId = bytesToHex(c.takeBytes(32));
  const burnedAmount = c.takeU64LE();
  const kernelSig = c.takeBytes(64);
  const n = c.takeU8();
  if (![0, 1, 2, 4, 8].includes(n)) throw new Error(`bad N=${n}`);
  const outputs: CommitmentOut[] = [];
  for (let i = 0; i < n; i++) {
    outputs.push({
      vout: i,
      commitmentC: c.takeBytes(33),
      encryptedAmount: c.takeBytes(8),
    });
  }
  let rangeproof: Uint8Array | null = null;
  if (n > 0) {
    const rpLen = c.takeU16LE();
    rangeproof = c.takeBytes(rpLen);
  }
  return { opcode: "T_BURN", payload, assetId, burnedAmount, kernelSig, n, outputs, rangeproof };
}

function decodeTAxfer(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const assetId = bytesToHex(c.takeBytes(32));
  const assetInputCount = c.takeU8();
  if (assetInputCount < 1) throw new Error(`bad asset_input_count=${assetInputCount}`);
  const kernelSig = c.takeBytes(64);
  const n = c.takeU8();
  if (![1, 2, 4, 8].includes(n)) throw new Error(`bad N=${n}`);
  const outputs: CommitmentOut[] = [];
  for (let i = 0; i < n; i++) {
    outputs.push({
      vout: i,
      commitmentC: c.takeBytes(33),
      encryptedAmount: c.takeBytes(8),
    });
  }
  const rpLen = c.takeU16LE();
  const rangeproof = c.takeBytes(rpLen);
  return { opcode: "T_AXFER", payload, assetId, assetInputCount, kernelSig, n, outputs, rangeproof };
}

function decodeTPetch(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const tickerLen = c.takeU8();
  if (tickerLen < 1 || tickerLen > 16) throw new Error(`bad ticker_len=${tickerLen}`);
  // SPEC §5.8: ticker is UTF-8. Strict mode rejects invalid byte
  // sequences. Upstream uses fatal:true; aligning so we don't accept
  // garbage tickers with replacement chars.
  const ticker = c.takeUtf8Strict(tickerLen);
  const decimals = c.takeU8();
  if (decimals > 8) throw new Error(`bad decimals=${decimals}`);
  const capAmount = c.takeU64LE();
  const mintLimit = c.takeU64LE();
  if (capAmount <= 0n) throw new Error("cap_amount must be > 0");
  if (mintLimit <= 0n) throw new Error("mint_limit must be > 0");
  if (mintLimit > capAmount) throw new Error("mint_limit > cap_amount");
  if (capAmount % mintLimit !== 0n) throw new Error("cap not divisible by mint_limit");
  const mintStartHeight = c.takeU32LE();
  const mintEndHeight = c.takeU32LE();
  // SPEC §5.8: when both heights are non-zero, mint_end_height MUST
  // exceed mint_start_height. The etch_height-dependent invariant
  // (mint_start_height >= etch_height + 1) is enforced in handlers.ts
  // where we have block context.
  if (mintStartHeight !== 0 && mintEndHeight !== 0 && mintEndHeight <= mintStartHeight) {
    throw new Error(`mint_end_height ${mintEndHeight} <= mint_start_height ${mintStartHeight}`);
  }
  const imgLen = c.takeU16LE();
  if (imgLen > 256) throw new Error(`bad img_len=${imgLen}`);
  const imageUri = c.takeUtf8Strict(imgLen);
  return {
    opcode: "T_PETCH",
    payload,
    ticker,
    decimals,
    capAmount,
    mintLimit,
    mintStartHeight,
    mintEndHeight,
    imageUri,
  };
}

function decodeTPmint(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  // SPEC §5.9 wire: opcode(1) || asset_id(32) || etch_txid(32) ||
  //   commitment(33) || amount(8 LE) || blinding(32) = exactly 138 bytes.
  if (payload.length !== 1 + 32 + 32 + 33 + 8 + 32) {
    throw new Error(`T_PMINT payload length ${payload.length} != 138`);
  }
  const assetId = bytesToHex(c.takeBytes(32));
  const etchTxid = bytesToHex(c.takeBytes(32));
  const commitmentC = c.takeBytes(33);
  const amount = c.takeU64LE();
  if (amount <= 0n) throw new Error(`T_PMINT amount must be > 0, got ${amount}`);
  const blinding = c.takeBytes(32);
  // SPEC §5.9 step 6: 0 < blinding < curve_order. Decoder catches the
  // trivial all-zero case; full curve-order range check is the Pedersen
  // validator's job (needs the secp256k1 N constant).
  let allZero = true;
  for (const b of blinding) {
    if (b !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) throw new Error("T_PMINT blinding is all zero");
  return { opcode: "T_PMINT", payload, assetId, etchTxid, commitmentC, amount, blinding };
}

function decodeTDeposit(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const assetId = bytesToHex(c.takeBytes(32));
  const denomination = c.takeU64LE();
  if (denomination === 0n) {
    // POOL_INIT shape (§5.10.1)
    const poolDenom = c.takeU64LE();
    const vkCidLen = c.takeU8();
    const vkCid = c.takeUtf8(vkCidLen);
    const ceremonyCidLen = c.takeU8();
    const ceremonyCid = c.takeUtf8(ceremonyCidLen);
    const initSig = c.takeBytes(64);
    return {
      opcode: "T_DEPOSIT",
      payload,
      assetId,
      denomination: 0n,
      isPoolInit: true,
      poolDenom,
      vkCid,
      ceremonyCid,
      initSig,
    };
  }
  const leafCommitment = c.takeBytes(32);
  const kernelSig = c.takeBytes(64);
  return {
    opcode: "T_DEPOSIT",
    payload,
    assetId,
    denomination,
    leafCommitment,
    kernelSig,
    isPoolInit: false,
  };
}

function decodeTWithdraw(payload: Uint8Array, c: Cursor): DecodedEnvelope {
  const assetId = bytesToHex(c.takeBytes(32));
  const denomination = c.takeU64LE();
  const merkleRoot = c.takeBytes(32);
  const nullifierHash = c.takeBytes(32);
  const recipientCommitment = c.takeBytes(33);
  const rLeaf = c.takeBytes(32);
  const bindHash = c.takeBytes(32);
  const proofLen = c.takeU16LE();
  const proof = c.takeBytes(proofLen);
  return {
    opcode: "T_WITHDRAW",
    payload,
    assetId,
    denomination,
    merkleRoot,
    nullifierHash,
    recipientCommitment,
    rLeaf,
    bindHash,
    proof,
  };
}
