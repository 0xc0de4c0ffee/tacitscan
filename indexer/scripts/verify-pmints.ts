// Independent SPEC-validator spot-check for T_PMINT envelopes.
// Usage:  pnpm tsx scripts/verify-pmints.ts <txid> [<txid> ...]
//
// For each txid: fetches the tx from mempool.space, runs the canonical
// decoder, derives expected asset_id from etch_txid, then checks Pedersen
// (amount·H + blinding·G == commitment).
//
// These are SPEC §5.9 steps 1 (asset_id derivation) + 6 (Pedersen).
// Steps 2 (parent is T_PETCH), 3 (amount = mint_limit), 4 (height window),
// and 5 (cap overflow) need additional lookups against parent T_PETCH
// metadata, which the indexer's validator loop already does in DB.
//
// Output is just a verdict per txid + the decoded fields so you can
// eyeball them against any other indexer.
import { tryDecodeFromWitness, deriveAssetId, bytesToHex } from "../src/envelope.js";
import { verifyPedersen } from "../src/pedersen.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: pnpm tsx scripts/verify-pmints.ts <txid> [<txid> ...]");
  process.exit(1);
}

let pass = 0;
let fail = 0;

for (const txid of args) {
  console.log(`\n── ${txid} ──`);
  let tx;
  try {
    const r = await fetch(`https://mempool.space/api/tx/${txid}`);
    if (!r.ok) {
      console.log(`  ✗ HTTP ${r.status} from mempool.space`);
      fail++;
      continue;
    }
    tx = await r.json();
  } catch (e) {
    console.log(`  ✗ fetch failed: ${(e as Error).message}`);
    fail++;
    continue;
  }

  const result = tryDecodeFromWitness(tx.vin?.[0]?.witness);
  if (!result) {
    console.log(`  ✗ no Tacit envelope in vin[0].witness`);
    fail++;
    continue;
  }
  if (!result.ok) {
    console.log(`  ✗ decode failed: ${result.reason}`);
    fail++;
    continue;
  }
  const env = result.envelope;
  if (env.opcode !== "T_PMINT") {
    console.log(`  ✗ wrong opcode: ${env.opcode}`);
    fail++;
    continue;
  }

  console.log(`  opcode:       T_PMINT`);
  console.log(`  block:        ${tx.status?.block_height ?? "unconfirmed"}`);
  console.log(`  asset_id:     ${env.assetId}`);
  console.log(`  etch_txid:    ${env.etchTxid}`);
  console.log(`  amount:       ${env.amount}`);
  console.log(`  blinding:     ${bytesToHex(env.blinding)}`);
  console.log(`  commitment:   ${bytesToHex(env.commitmentC)}`);

  const expectedAid = deriveAssetId(env.etchTxid, 0);
  const aidOk = expectedAid === env.assetId;
  console.log(`  §5.9 step 1:  asset_id == sha256(reverse(etch_txid) || vout=0)`);
  console.log(`                ${aidOk ? "✓" : "✗ MISMATCH (expected " + expectedAid + ")"}`);

  const ped = verifyPedersen(env.amount, env.blinding, env.commitmentC);
  console.log(`  §5.9 step 6:  pedersen(amount, blinding) == commitment`);
  console.log(`                ${ped.ok ? "✓" : "✗ " + ped.reason}`);

  if (aidOk && ped.ok) {
    console.log(`  → VALID per SPEC §5.9 steps 1 + 6`);
    pass++;
  } else {
    console.log(`  → INVALID`);
    fail++;
  }
}

console.log(`\n────────`);
console.log(`Summary: ${pass} valid, ${fail} invalid (of ${args.length} checked)`);
process.exit(fail === 0 ? 0 : 2);
