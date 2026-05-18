// Abstract data-source interface so the block walker doesn't care
// whether bytes come from Esplora REST or Bitcoin JSON-RPC.
import type { EsploraTx } from "./esplora.js";

export interface FullBlock {
  hash: string;
  height: number;
  timestamp: number;
  previousblockhash: string | null;
  tx_count: number;
  txs: EsploraTx[];
}

export interface BitcoinDataSource {
  /** Best-effort name for logging. */
  readonly name: string;
  getTipHeight(): Promise<number>;
  fetchBlock(height: number): Promise<FullBlock>;
  /** Canonical chain hash at `height`. Used by reorg detection to walk
   * back to a common ancestor without fetching the full block body. */
  getBlockHashByHeight(height: number): Promise<string>;
  /** Mempool txid set. Returns IDs only; callers fetch tx bodies as needed. */
  getMempoolTxids(): Promise<string[]>;
  /** Single tx by id, including witness. Used by the mempool poller and
   * for orphan-recovery lookups. */
  fetchTx(txid: string): Promise<EsploraTx>;
}

// Wraps two sources: try primary, fall back to secondary on any throw.
// Used to put dRPC (or any paid provider) primary with mempool.space as
// the safety net.
export function withFallback(
  primary: BitcoinDataSource,
  fallback: BitcoinDataSource,
): BitcoinDataSource {
  return {
    name: `${primary.name} → ${fallback.name}`,
    async getTipHeight() {
      try {
        return await primary.getTipHeight();
      } catch (e) {
        console.warn(`[${primary.name}] getTipHeight failed, falling back: ${(e as Error).message}`);
        return fallback.getTipHeight();
      }
    },
    async fetchBlock(h) {
      try {
        return await primary.fetchBlock(h);
      } catch (e) {
        console.warn(`[${primary.name}] fetchBlock(${h}) failed, falling back: ${(e as Error).message}`);
        return fallback.fetchBlock(h);
      }
    },
    async getBlockHashByHeight(h) {
      try {
        return await primary.getBlockHashByHeight(h);
      } catch (e) {
        console.warn(`[${primary.name}] getBlockHashByHeight(${h}) failed, falling back: ${(e as Error).message}`);
        return fallback.getBlockHashByHeight(h);
      }
    },
    async getMempoolTxids() {
      try {
        return await primary.getMempoolTxids();
      } catch (e) {
        console.warn(`[${primary.name}] getMempoolTxids failed, falling back: ${(e as Error).message}`);
        return fallback.getMempoolTxids();
      }
    },
    async fetchTx(txid) {
      try {
        return await primary.fetchTx(txid);
      } catch (e) {
        console.warn(`[${primary.name}] fetchTx(${txid}) failed, falling back: ${(e as Error).message}`);
        return fallback.fetchTx(txid);
      }
    },
  };
}
