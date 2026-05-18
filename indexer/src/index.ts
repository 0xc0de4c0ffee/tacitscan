import { runIndexer } from "./indexer.js";
import { runResolver } from "./resolver.js";
import { runValidator } from "./validator.js";
import { runMintValidator } from "./mint-validator.js";
import { runMempoolPoller } from "./mempool.js";
import { backfillSpendingPubkey } from "./backfill-spending-pubkey.js";
import { backfillRedecode } from "./backfill-redecode.js";

// Five independent loops in the same process:
//   indexer        — block walker, decodes envelopes, writes to DB
//   mempool        — polls /mempool/txids and inserts unconfirmed envelopes
//                    so the explorer can show 0-conf txs (Etherscan-style).
//                    Block walker promotes mempool rows to confirmed via
//                    ON CONFLICT DO UPDATE on the envelopes PK.
//   resolver       — fetches IPFS metadata, follows NFT-style image fields
//   validator      — runs Pedersen + parent + amount + height checks
//                    on T_PMINT rows (SPEC §5.9)
//   mint-validator — runs BIP-340 Schnorr issuer-sig check on T_MINT rows
//                    against parent CETCH's mint_authority (SPEC §5.3)
// One-shot backfills before tip-walk resumes. Idempotent — subsequent
// starts see empty result sets and return fast. Failures shouldn't block
// the indexer; log + continue.
backfillSpendingPubkey().catch((e) => {
  console.error("[backfill-spending-pubkey] failed (continuing):", e);
});
backfillRedecode().catch((e) => {
  console.error("[backfill-redecode] failed (continuing):", e);
});

// If the indexer crashes the process exits and Railway restarts us —
// partial progress is checkpointed in DB. The auxiliary loops are caught
// so a flaky external dep can't take down the indexer.
Promise.all([
  runIndexer(),
  runMempoolPoller().catch((e) => {
    console.error("[mempool] crashed (continuing without it):", e);
  }),
  runResolver().catch((e) => {
    console.error("[resolver] crashed (continuing without it):", e);
  }),
  runValidator().catch((e) => {
    console.error("[validator] crashed (continuing without it):", e);
  }),
  runMintValidator().catch((e) => {
    console.error("[mint-validator] crashed (continuing without it):", e);
  }),
]).catch((err) => {
  console.error("indexer crashed:", err);
  process.exit(1);
});
