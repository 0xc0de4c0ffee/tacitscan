// Smoke test against a real mainnet Tacit envelope.
// Usage: pnpm smoke
//
// Verified known-good: the TAC CETCH at block 948242. If this script's
// output drifts from the asserted values below, the decoder regressed.
import { tryDecodeFromWitness, deriveAssetId, bytesToHex } from "../src/envelope.ts";

const TXID = "e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e";

const EXPECTED = {
  ticker: "TAC",
  decimals: 8,
  mintable: false,
  rangeproofMin: 600,
  rangeproofMax: 800,
  imageUriPrefix: "ipfs://",
  assetId: "f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b",
};

async function main() {
  const r = await fetch(`https://mempool.space/api/tx/${TXID}`);
  const tx = await r.json();
  const witness: string[] = tx.vin[0].witness;
  console.log(`tx ${TXID} @ block ${tx.status.block_height}`);
  console.log(`witness items: ${witness.length}`);
  console.log(`  [0] sig:    ${witness[0]!.length / 2} B`);
  console.log(`  [1] script: ${witness[1]!.length / 2} B`);
  console.log(`  [2] ctrl:   ${witness[2]!.length / 2} B`);

  const result = tryDecodeFromWitness(witness);
  if (!result) {
    console.error("✗ no Tacit envelope detected");
    process.exit(1);
  }
  if (!result.ok) {
    console.error(`✗ decode failed: ${result.reason}`);
    process.exit(1);
  }
  const env = result.envelope;
  console.log(`\n✓ decoded as ${env.opcode}`);
  if (env.opcode !== "CETCH") {
    console.error(`expected CETCH, got ${env.opcode}`);
    process.exit(1);
  }

  const assetId = deriveAssetId(TXID, 0);
  console.log(`  ticker:        ${JSON.stringify(env.ticker)}`);
  console.log(`  decimals:      ${env.decimals}`);
  console.log(`  commitment:    ${bytesToHex(env.commitmentC)}`);
  console.log(`  amount_ct:     ${bytesToHex(env.amountCt)}`);
  console.log(`  rangeproof:    ${env.rangeproof.length} B`);
  console.log(`  mint_auth:     ${bytesToHex(env.mintAuthority)}`);
  console.log(`  mintable:      ${!env.mintAuthority.every((b) => b === 0)}`);
  console.log(`  image_uri:     ${JSON.stringify(env.imageUri)}`);
  console.log(`  asset_id:      ${assetId}`);

  const errors: string[] = [];
  if (env.ticker !== EXPECTED.ticker) errors.push(`ticker = ${env.ticker}`);
  if (env.decimals !== EXPECTED.decimals) errors.push(`decimals = ${env.decimals}`);
  if (env.commitmentC.length !== 33) errors.push(`commitment.length = ${env.commitmentC.length}`);
  if (env.amountCt.length !== 8) errors.push(`amount_ct.length = ${env.amountCt.length}`);
  if (env.rangeproof.length < EXPECTED.rangeproofMin || env.rangeproof.length > EXPECTED.rangeproofMax) {
    errors.push(`rangeproof.length = ${env.rangeproof.length}`);
  }
  const isMintable = !env.mintAuthority.every((b) => b === 0);
  if (isMintable !== EXPECTED.mintable) errors.push(`mintable = ${isMintable}`);
  if (!env.imageUri.startsWith(EXPECTED.imageUriPrefix)) errors.push(`image_uri = ${env.imageUri}`);
  if (assetId !== EXPECTED.assetId) errors.push(`asset_id regressed: ${assetId}`);

  if (errors.length > 0) {
    console.error("\n✗ assertion failures:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log("\n✓ all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
