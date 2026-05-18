// Pedersen commitment verification for Tacit T_PMINT envelopes.
// SPEC §3.1 (NUMS H) + §3.2 (C = a·H + r·G).
//
// Verified against the reference test vector in §3.1:
//   H = 02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56
// and against a real on-chain T_PMINT (FAIR, txid d84caa17…20df).
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const utf8 = (s: string) => new TextEncoder().encode(s);

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

// SPEC §3.1: try-and-increment under tacit-generator-H-v1 domain.
function deriveH(): InstanceType<typeof secp256k1.ProjectivePoint> {
  const seed = sha256(utf8("tacit-generator-H-v1"));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concat(seed, new Uint8Array([counter])));
    const candidate = concat(new Uint8Array([0x02]), x);
    try {
      const pt = secp256k1.ProjectivePoint.fromHex(candidate);
      if (!pt.equals(secp256k1.ProjectivePoint.ZERO)) {
        return pt;
      }
    } catch {
      // candidate x not on curve; try next
    }
  }
  throw new Error("could not derive H NUMS generator");
}

// Module-level singletons. Both are O(1) once initialized.
const H = deriveH();
const G = secp256k1.ProjectivePoint.BASE;
const N = secp256k1.CURVE.n;

// SPEC §5.9 stores blinding as a 32-byte big-endian scalar.
// (Verified empirically against on-chain FAIR T_PMINT.)
function blindingToScalar(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export interface PedersenCheck {
  ok: boolean;
  reason?: string;
}

// Returns ok=true iff (amount, blinding) is a valid opening of commitment
// under H, G. Cheap: one ECDSA scalar multiply on each generator + one add.
// On a quiet laptop this runs at ~2k checks/sec.
export function verifyPedersen(
  amount: bigint,
  blinding: Uint8Array,
  commitment: Uint8Array,
): PedersenCheck {
  if (blinding.length !== 32) return { ok: false, reason: "blinding length != 32" };
  if (commitment.length !== 33) return { ok: false, reason: "commitment length != 33" };
  if (amount < 0n) return { ok: false, reason: "amount negative" };

  const r = blindingToScalar(blinding);
  if (r <= 0n || r >= N) return { ok: false, reason: "blinding not in (0, n)" };

  let C: ReturnType<typeof secp256k1.ProjectivePoint.fromHex>;
  try {
    C = secp256k1.ProjectivePoint.fromHex(commitment);
  } catch {
    return { ok: false, reason: "commitment not a valid point" };
  }

  // expected = amount·H + r·G
  const aH = amount === 0n ? secp256k1.ProjectivePoint.ZERO : H.multiply(amount);
  const rG = G.multiply(r);
  const expected = aH.add(rG);

  return expected.equals(C) ? { ok: true } : { ok: false, reason: "pedersen mismatch" };
}

// Exposed for tests / smoke checks.
export const REFERENCE_H_HEX =
  "02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56";
export function getH() {
  return H;
}
