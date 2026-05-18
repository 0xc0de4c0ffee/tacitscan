// Thin client over the Esplora REST API.
// Public free instances: mempool.space, blockstream.info.
// Same interface ports cleanly to a managed provider later — just swap
// the BitcoinDataSource impl.
import pRetry, { AbortError } from "p-retry";
import type { BitcoinDataSource, FullBlock } from "./source.js";

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  // null means "fee unknown" (e.g. RPC source doesn't include it without
  // an extra prevout fetch). Esplora always populates it.
  fee: number | null;
  vin: EsploraTxInput[];
  vout: EsploraTxOutput[];
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

export interface EsploraTxInput {
  txid: string;
  vout: number;
  prevout?: EsploraTxOutput | null;
  scriptsig: string;
  scriptsig_asm: string;
  witness?: string[];
  is_coinbase: boolean;
  sequence: number;
}

export interface EsploraTxOutput {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraBlock {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  merkle_root: string;
  previousblockhash: string | null;
  nonce: number;
  bits: number;
  difficulty: number;
}

export class EsploraClient implements BitcoinDataSource {
  readonly name: string;
  constructor(
    private readonly primary: string,
    private readonly fallback?: string,
    // Optional auth headers, e.g. {"api-key": "..."} for Maestro. Merged
    // into every request. We don't bake provider-specific knowledge in;
    // the caller in indexer.ts decides what to send.
    private readonly authHeaders?: Record<string, string>,
    nameOverride?: string,
  ) {
    this.name = nameOverride ?? "esplora";
  }

  async fetchBlock(height: number): Promise<FullBlock> {
    const hash = await this.getBlockHashByHeight(height);
    const block = await this.getBlock(hash);
    const txs = await this.getAllBlockTxs(hash, block.tx_count);
    return {
      hash: block.id,
      height: block.height,
      timestamp: block.timestamp,
      previousblockhash: block.previousblockhash,
      tx_count: block.tx_count,
      txs,
    };
  }

  private endpoints(): string[] {
    return this.fallback ? [this.primary, this.fallback] : [this.primary];
  }

  private async fetchJson<T>(path: string): Promise<T> {
    return pRetry(
      async () => {
        let lastErr: unknown;
        for (const base of this.endpoints()) {
          try {
            const r = await fetch(`${base}${path}`, {
              headers: { "user-agent": "tacitscan-indexer/0.1", ...this.authHeaders },
              // Hard ceiling so a hung connection can't trap the whole
              // indexer loop. Each attempt gets 15s; pRetry adds up to 4
              // retries so worst-case latency is bounded.
              signal: AbortSignal.timeout(15_000),
            });
            if (r.status === 404) {
              throw new AbortError(`404: ${path}`);
            }
            if (!r.ok) {
              lastErr = new Error(`HTTP ${r.status} from ${base}${path}`);
              continue;
            }
            return (await r.json()) as T;
          } catch (e) {
            if (e instanceof AbortError) throw e;
            lastErr = e;
          }
        }
        throw lastErr ?? new Error(`fetch failed: ${path}`);
      },
      { retries: 4, minTimeout: 500, maxTimeout: 5000, factor: 2 },
    );
  }

  private async fetchText(path: string): Promise<string> {
    return pRetry(
      async () => {
        let lastErr: unknown;
        for (const base of this.endpoints()) {
          try {
            const r = await fetch(`${base}${path}`, {
              headers: { "user-agent": "tacitscan-indexer/0.1", ...this.authHeaders },
              signal: AbortSignal.timeout(15_000),
            });
            if (r.status === 404) throw new AbortError(`404: ${path}`);
            if (!r.ok) {
              lastErr = new Error(`HTTP ${r.status} from ${base}${path}`);
              continue;
            }
            return await r.text();
          } catch (e) {
            if (e instanceof AbortError) throw e;
            lastErr = e;
          }
        }
        throw lastErr ?? new Error(`fetch failed: ${path}`);
      },
      { retries: 4, minTimeout: 500, maxTimeout: 5000, factor: 2 },
    );
  }

  async getTipHeight(): Promise<number> {
    const t = await this.fetchText(`/blocks/tip/height`);
    return Number(t.trim());
  }

  async getBlockHashByHeight(height: number): Promise<string> {
    return (await this.fetchText(`/block-height/${height}`)).trim();
  }

  async getBlock(hash: string): Promise<EsploraBlock> {
    return this.fetchJson<EsploraBlock>(`/block/${hash}`);
  }

  // Esplora returns block transactions in pages of 25, ordered by tx_index.
  async getBlockTxs(hash: string, startIndex: number): Promise<EsploraTx[]> {
    return this.fetchJson<EsploraTx[]>(`/block/${hash}/txs/${startIndex}`);
  }

  async getMempoolTxids(): Promise<string[]> {
    return this.fetchJson<string[]>(`/mempool/txids`);
  }

  async fetchTx(txid: string): Promise<EsploraTx> {
    return this.fetchJson<EsploraTx>(`/tx/${txid}`);
  }

  // Fetch all tx pages of a block in parallel. Esplora pages are 25 txs
  // each — a 3000-tx mainnet block is 120 page calls. Sequential at ~50ms
  // each = 6s per block; parallel-bounded at concurrency 8 ≈ 750ms.
  async getAllBlockTxs(hash: string, txCount: number, concurrency = 8): Promise<EsploraTx[]> {
    const offsets: number[] = [];
    for (let i = 0; i < txCount; i += 25) offsets.push(i);
    const results: EsploraTx[][] = new Array(offsets.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, offsets.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= offsets.length) return;
        results[idx] = await this.getBlockTxs(hash, offsets[idx]!);
      }
    });
    await Promise.all(workers);
    const out: EsploraTx[] = [];
    for (const page of results) if (page) out.push(...page);
    return out;
  }
}
